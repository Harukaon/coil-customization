/**
 * One MCP server, and everything CoilCoil needs to know about it.
 *
 * The protocol itself comes from the official SDK; what lives here is the part
 * CoilCoil kept getting wrong through pi-mcp-adapter — an honest answer to
 * "does this server work right now", produced without a Pi session anywhere in
 * the picture. That is the whole point of owning this layer: a connection is a
 * property of the runtime, not of whichever conversation happens to be open, so
 * the settings panel can ask at any time.
 *
 * A connection never throws at its caller for the ordinary failures. Wrong
 * address, refused credentials, a command that is not installed — those are
 * answers, not exceptions, and they land in `status` and `failure` where the
 * panel can show them verbatim. The server's own words are kept rather than
 * summarised: "Invalid API key" is worth ten of "failed to connect".
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { McpServerConfiguration } from "@coilcoil/runtime-protocol";
import { launchFor, type EnvironmentSource } from "./definition.js";
import type { McpCredentialStore } from "./credential-store.js";
import type { McpDiagnosticLogger } from "./diagnostic.js";
import { McpOAuthProvider } from "./oauth-provider.js";

/**
 * Deliberately the same words the runtime protocol already speaks, so nothing
 * has to translate between this layer and the panel.
 */
export type McpConnectionStatus =
  | "not connected"
  | "connecting"
  | "connected"
  | "needs-auth"
  | "failed";

export interface McpToolSummary {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpResourceSummary {
  uri: string;
  name?: string;
  mimeType?: string;
}

export interface McpConnectionOptions {
  definition: McpServerConfiguration;
  store: McpCredentialStore;
  /**
   * Where an authorization server sends the browser back to.
   *
   * Accepts a getter so the loopback listener is only started when a login
   * actually needs it: a workspace of stdio servers should never open a port.
   */
  redirectUrl: string | (() => string);
  openAuthorization: (url: URL) => void | Promise<void>;
  /** Optional sink for redacted authentication diagnostics. */
  diagnostic?: McpDiagnosticLogger;
  environment?: EnvironmentSource;
  clientName?: string;
  clientVersion?: string;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
/** Enough of a failing server's stderr to name the problem, not enough to fill the panel. */
const STDERR_TAIL_LIMIT = 600;

function tokenSummary(tokens: OAuthTokens | undefined): Record<string, unknown> {
  const value = tokens as (OAuthTokens & { expires_in?: unknown; scope?: unknown; token_type?: unknown }) | undefined;
  return {
    hasAccessToken: typeof value?.access_token === "string" && value.access_token.length > 0,
    hasRefreshToken: typeof value?.refresh_token === "string" && value.refresh_token.length > 0,
    expiresIn: typeof value?.expires_in === "number" ? value.expires_in : undefined,
    hasScope: typeof value?.scope === "string" && value.scope.length > 0,
    tokenType: typeof value?.token_type === "string" ? value.token_type : undefined,
  };
}

function requestGrantType(init?: RequestInit): string | undefined {
  if (init?.body instanceof URLSearchParams) return init.body.get("grant_type") ?? undefined;
  if (typeof init?.body !== "string") return undefined;
  try {
    return new URLSearchParams(init.body).get("grant_type") ?? undefined;
  } catch {
    return undefined;
  }
}

function safeOAuthBody(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const record = parsed as Record<string, unknown>;
    return {
      oauthError: typeof record.error === "string" ? record.error : undefined,
      oauthErrorDescription: typeof record.error_description === "string"
        ? record.error_description.slice(0, 240)
        : undefined,
      hasAccessToken: typeof record.access_token === "string" && record.access_token.length > 0,
      hasRefreshToken: typeof record.refresh_token === "string" && record.refresh_token.length > 0,
      expiresIn: typeof record.expires_in === "number" ? record.expires_in : undefined,
    };
  } catch {
    return { responseBody: text.trim() ? "non-json" : "empty" };
  }
}

/**
 * Everything an error actually says, including what it is wrapping.
 *
 * `fetch failed` is undici's message for every network problem there is; the
 * reason — refused, DNS, certificate, proxy — is only ever in `cause`. Reporting
 * the top-level message alone put a sentence in front of the user that could not
 * be acted on, and left the same sentence in the log for us.
 */
/**
 * 顺着 `cause` 往下找服务器回的 HTTP 状态码。
 *
 * SDK 的两种 HTTP 传输在收到非 2xx 时抛的错误都把状态码放在 `code` 上；网络层的
 * 错误（拒绝连接、DNS、超时）没有这个字段，或者放的是 `ECONNREFUSED` 这类字符串。
 * 所以「`code` 是个像 HTTP 状态码的数字」就等于「服务器答了话」。
 */
function httpStatusOf(error: unknown, depth = 0): number | undefined {
  if (!(error instanceof Error) || depth > 4) return undefined;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "number" && code >= 100 && code <= 599) return code;
  return httpStatusOf((error as { cause?: unknown }).cause, depth + 1);
}

function errorText(error: unknown, depth = 0): string {
  if (!(error instanceof Error)) return String(error);
  const own = error.message || error.name;
  const code = (error as { code?: string }).code;
  const line = code && !own.includes(code) ? `${own} (${code})` : own;
  const cause = depth < 4 ? (error as { cause?: unknown }).cause : undefined;
  if (!cause) return line;
  const nested = errorText(cause, depth + 1);
  return nested && !line.includes(nested) ? `${line}：${nested}` : line;
}

/**
 * 「请求根本没发出去，因为连接不在了」——SDK 对这一种失败的说法。
 *
 * 只认这一句，是因为只有它保证服务器什么都没做过：传输层在发送前就拒绝了。至于
 * 「Connection closed」，那是请求已经送出、答案在半路丢了，重试可能让同一个动作
 * 执行两次，所以不在这里。
 */
function isDisconnected(error: unknown): boolean {
  return error instanceof Error && /^not connected$/i.test(error.message.trim());
}

/** The SDK's own words for a request that ran out of time. */
function isRequestTimeout(error: unknown): boolean {
  return error instanceof Error && /request timed out|maximum total timeout exceeded/i.test(error.message);
}

export class McpConnection {
  private client?: Client;
  private transport?: Transport;
  private state: McpConnectionStatus = "not connected";
  private lastFailure?: string;
  /**
   * 上一次失败时，服务器回的 HTTP 状态码——没有就是压根没连上。
   *
   * 这是「令牌坏了」和「服务器死了」之间唯一可靠的分界，而且不依赖对面把状态码
   * 写对。传输层在收到任何非 2xx 时抛的错误自带状态码；连接被拒、DNS 解析不了、
   * 握手超时则不会有。2026-09-14 真遇到过：一台 MCP Server 的令牌过期了，它却把
   * 401 报成 500，于是我们只当成「连不上」，界面上就成了一句没有出路的错误——用
   * 户唯一的办法是去手动删本地凭据文件。看「答没答话」就不会被这种事骗到：答了
   * 话就说明服务器活着，那把嫌疑落在令牌上永远是对的。
   */
  private lastFailureHttpStatus?: number;
  private discoveredTools: McpToolSummary[] = [];
  private discoveredResources: McpResourceSummary[] = [];
  private oauth?: McpOAuthProvider;
  /** The last thing a stdio server wrote to stderr, for the failure message. */
  private stderrTail = "";
  /** One connect at a time; a second press must join the first, not race it. */
  private inFlight?: Promise<McpConnectionStatus>;

  constructor(private readonly options: McpConnectionOptions) {}

  get name(): string {
    return this.options.definition.name;
  }

  get status(): McpConnectionStatus {
    return this.state;
  }

  get failure(): string | undefined {
    return this.lastFailure;
  }

  /** 上一次失败时服务器回的状态码；没答话就是 undefined。 */
  get failureHttpStatus(): number | undefined {
    return this.lastFailureHttpStatus;
  }

  get tools(): McpToolSummary[] {
    return this.discoveredTools;
  }

  get resources(): McpResourceSummary[] {
    return this.discoveredResources;
  }

  /** The page the browser was sent to, so 认证 can be retried or reopened. */
  get authorizationUrl(): URL | undefined {
    return this.oauth?.authorizationUrl;
  }

  private diagnostic(level: "info" | "warn" | "error", event: string, data?: Record<string, unknown>): void {
    this.options.diagnostic?.(level, event, { server: this.name, ...data });
  }

  private diagnosticFetch(serverUrl: string, oauth?: McpOAuthProvider): FetchLike {
    return async (input, init) => {
      const url = input instanceof URL ? input : new URL(input);
      const grantType = requestGrantType(init);
      const requestKind = grantType === "refresh_token"
        ? "token-refresh"
        : grantType === "authorization_code"
          ? "token-exchange"
          : url.toString() === serverUrl
            ? "mcp"
            : "oauth-discovery";
      const refreshBody = init?.body instanceof URLSearchParams
        ? init.body
        : typeof init?.body === "string" ? new URLSearchParams(init.body) : undefined;
      const response = requestKind === "token-refresh" && oauth && refreshBody
        ? await oauth.refresh(refreshBody, () => fetch(input, init))
        : await fetch(input, init);
      const shouldInspect = requestKind === "token-refresh"
        || requestKind === "token-exchange"
        || !response.ok;
      if (!shouldInspect) return response;

      const body = safeOAuthBody((await response.clone().text()).slice(0, 4096));
      this.diagnostic(response.ok ? "info" : "warn", response.ok ? "oauth_request_succeeded" : "oauth_request_failed", {
        requestKind,
        status: response.status,
        hasWwwAuthenticate: Boolean(response.headers.get("www-authenticate")),
        ...body,
      });
      return response;
    };
  }

  private buildTransport(): Transport {
    const environment = this.options.environment ?? process.env;
    const launch = launchFor(this.options.definition, environment);
    if (launch.kind === "stdio") {
      const transport = new StdioClientTransport({
        command: launch.command,
        args: launch.args,
        env: launch.env,
        cwd: launch.cwd,
        // Piped rather than inherited so a server that refuses to start can be
        // quoted back to the user. "Cannot find module 'x'" is the answer; a
        // bare "the connection failed" is what sent people to the logs.
        // `debug` additionally mirrors it to the runtime log, live.
        stderr: "pipe",
      });
      this.stderrTail = "";
      transport.stderr?.on("data", (chunk: Buffer | string) => {
        const text = String(chunk);
        if (this.options.definition.debug) process.stderr.write(text);
        // Only the tail is kept: a chatty server must not be able to grow this
        // without bound, and the last thing it said is the useful part.
        this.stderrTail = `${this.stderrTail}${text}`.slice(-STDERR_TAIL_LIMIT);
      });
      return transport;
    }
    const redirectUrl = this.options.redirectUrl;
    this.oauth = launch.oauth
      ? new McpOAuthProvider({
        serverUrl: launch.url,
        store: this.options.store,
        redirectUrl: typeof redirectUrl === "function" ? redirectUrl() : redirectUrl,
        openAuthorization: this.options.openAuthorization,
        clientName: this.options.clientName,
        diagnostic: (level, event, data) => this.diagnostic(level, event, data),
      })
      : undefined;
    return new StreamableHTTPClientTransport(new URL(launch.url), {
      authProvider: this.oauth,
      requestInit: { headers: launch.headers },
      fetch: this.diagnosticFetch(launch.url, this.oauth),
    });
  }

  /**
   * Connect, discover what the server offers, and report where that got to.
   *
   * `needs-auth` is separated from `failed` on purpose: it is the one outcome
   * the user can act on, and the panel turns it straight into the authorization
   * dialog instead of showing an error they cannot do anything about.
   */
  async connect(): Promise<McpConnectionStatus> {
    if (this.inFlight) return this.inFlight;
    if (this.state === "connected") return this.state;
    this.inFlight = this.runConnect().finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  private async runConnect(): Promise<McpConnectionStatus> {
    this.state = "connecting";
    this.lastFailure = undefined;
    this.lastFailureHttpStatus = undefined;
    if (this.oauth) this.diagnostic("info", "oauth_connect_started", tokenSummary(this.oauth.tokens()));
    try {
      const client = new Client(
        { name: this.options.clientName ?? "CoilCoil", version: this.options.clientVersion ?? "0.1.0" },
        { capabilities: {} },
      );
      const transport = this.buildTransport();
      await this.withTimeout(
        this.oauth ? this.oauth.withAuthContext(() => client.connect(transport)) : client.connect(transport),
        `连接 ${this.name} 超时（${Math.round(this.timeoutMs / 1000)} 秒）。`,
      );
      this.client = client;
      this.transport = transport;
      this.watchForClose(client);
      if (this.oauth) await this.oauth.withAuthContext(() => this.discover(client));
      else await this.discover(client);
      this.state = "connected";
      return this.state;
    } catch (error) {
      await this.dispose();
      if (error instanceof UnauthorizedError) {
        this.state = "needs-auth";
        this.lastFailure = undefined;
        if (this.oauth) this.diagnostic("warn", "oauth_auth_required", tokenSummary(this.oauth.tokens()));
        return this.state;
      }
      this.state = "failed";
      this.lastFailure = this.failureText(error);
      this.lastFailureHttpStatus = httpStatusOf(error);
      if (this.oauth) this.diagnostic("warn", "oauth_connect_failed", {
        httpStatus: this.lastFailureHttpStatus,
        ...tokenSummary(this.oauth.tokens()),
      });
      return this.state;
    }
  }

  /**
   * Notice when the connection dies on its own.
   *
   * A connection drops without anyone asking: the child process exits, the
   * socket it was holding goes away, the server decides it is done. The SDK
   * handles that honestly enough — it lets go of its transport, and every
   * request after that fails with `Not connected`. This layer did not: `state`
   * only ever moved when someone called `connect` or `close`, so a dead
   * connection went on reporting `connected` forever.
   *
   * That single stale word was the whole failure. The panel stayed green, the
   * tool list kept answering from the discovery cache without touching the
   * server, and `callTool`'s own reconnect was gated on the status not being
   * `connected` — so the one thing that could have fixed it was the one thing
   * the lie ruled out. On 2026-09-15 the built-in browser's server dropped
   * mid-session and the Agent spent two minutes on it: eight calls, all
   * `Not connected`, a re-list of the tools that returned a cheerful thirty
   * from cache, and no way out of it short of restarting the app.
   *
   * The guard is what keeps our own teardown out of this: `dispose` clears
   * `client` before closing it, so the close it causes finds a stranger here
   * and leaves the status `close` and `runConnect` are in the middle of setting.
   */
  private watchForClose(client: Client): void {
    client.onclose = () => {
      if (this.client !== client) return;
      this.client = undefined;
      this.transport = undefined;
      this.state = "not connected";
      this.discoveredTools = [];
      this.discoveredResources = [];
    };
  }

  private get timeoutMs(): number {
    return this.options.definition.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  /**
   * Put a ceiling on the handshake.
   *
   * The SDK times out its own requests but not `connect`, so a server that
   * accepts a socket and then says nothing hangs forever — and because the
   * Agent lists servers in parallel, one such server used to take every other
   * server's answer down with it.
   */
  private async withTimeout<T>(work: Promise<T>, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(message)), this.timeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * What to tell the user when a connection did not happen.
   *
   * A stdio server that dies on startup usually says why on stderr and then the
   * transport reports something generic like "closed"; joining the two is the
   * difference between an actionable message and a shrug.
   */
  private failureText(error: unknown): string {
    const reason = errorText(error);
    const stderr = this.stderrTail.trim();
    if (!stderr) return reason;
    return reason.includes(stderr) ? reason : `${reason}\n${stderr}`;
  }

  /**
   * Ask what is on offer.
   *
   * Resources are optional in the protocol and plenty of servers answer with a
   * "method not found" error rather than an empty list, so a refusal there is
   * not allowed to fail the whole connection — the tools are what matter.
   */
  private async discover(client: Client): Promise<void> {
    const timeout = this.timeoutMs;
    const tools = await client.listTools(undefined, { timeout });
    const excluded = new Set(this.options.definition.excludeTools);
    this.discoveredTools = tools.tools
      .filter((tool) => !excluded.has(tool.name))
      .map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
    if (!this.options.definition.exposeResources) {
      this.discoveredResources = [];
      return;
    }
    try {
      const resources = await client.listResources(undefined, { timeout });
      this.discoveredResources = resources.resources.map((resource) => ({
        uri: resource.uri,
        name: resource.name,
        mimeType: resource.mimeType,
      }));
    } catch {
      this.discoveredResources = [];
    }
  }

  /** Redeem an authorization code the browser handed back, then reconnect. */
  async finishAuth(code: string): Promise<McpConnectionStatus> {
    const transport = this.transport;
    if (transport instanceof StreamableHTTPClientTransport) {
      if (this.oauth) await this.oauth.withAuthContext(() => transport.finishAuth(code));
      else await transport.finishAuth(code);
    } else {
      // The failed attempt tore its transport down, so build a fresh one purely
      // to carry the code exchange; the reconnect below is what actually runs.
      const rebuilt = this.buildTransport();
      if (rebuilt instanceof StreamableHTTPClientTransport) {
        if (this.oauth) await this.oauth.withAuthContext(() => rebuilt.finishAuth(code));
        else await rebuilt.finishAuth(code);
      }
      await rebuilt.close().catch(() => undefined);
    }
    this.state = "not connected";
    return this.connect();
  }

  /**
   * @param signal Pi 给工具的中断信号，原样递给 SDK。
   *
   * 不接这个信号，界面上的停止按钮就按不停一次 MCP 调用：pi 那边早就放手了，这条
   * 请求还在跑，人得干等到它自己结束或者撞上超时。
   */
  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    try {
      try {
        return await this.sendCall(name, args, signal);
      } catch (error) {
        // 连接是在检查状态和发出请求之间断的。这种时序上的缝隙对调用方没有任何意义
        // ——它要的是工具的结果，不是我们内部先后顺序的报告——所以重连一次再试。只试
        // 一次：真连不上的时候，第二次的失败才是要交出去的那条原因。
        if (signal?.aborted || !isDisconnected(error)) throw error;
        await this.close();
        return await this.sendCall(name, args, signal);
      }
    } catch (error) {
      if (signal?.aborted || !isRequestTimeout(error)) throw error;
      throw this.timeoutError(name);
    }
  }

  /**
   * 超时说的是「我们不等了」，不是「那边停了」。
   *
   * SDK 在超时的同时会发 `notifications/cancelled`，但那只是一句通知：服务器可以
   * 照办，也可以当没看见。浏览器 MCP 就属于后者——页面里的脚本该跑还是跑，只是
   * 结果没人接了。原来交给 Agent 的是一句光秃秃的 "Request timed out"，于是它只能
   * 猜：有几次它当成「没做成」直接重试，把同一个动作在页面上做了两遍。
   *
   * 所以这条错误要把三件事一起说清楚：等了多久、那边可能还在跑、下一步该去查状态
   * 而不是重试。
   */
  private timeoutError(tool: string): Error {
    const seconds = Math.round(this.timeoutMs / 1000);
    return new Error(
      `MCP 工具「${tool}」等了 ${seconds} 秒还没有返回，我们这边已经不等了。`
      + `服务器收到了取消通知，但它不一定照办：这次调用触发的动作可能仍在继续。`
      + `不要直接重试——先查一次当前状态，确认这一步到底做没做成，再决定下一步。`,
    );
  }

  private async sendCall(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (this.state !== "connected") {
      const status = await this.connect();
      if (status !== "connected") {
        throw new Error(this.lastFailure ?? `MCP Server「${this.name}」当前${status === "needs-auth" ? "需要认证" : "连不上"}。`);
      }
    }
    const client = this.client;
    if (!client) throw new Error(`MCP Server「${this.name}」还没有连接。`);
    const call = () => client.callTool(
      { name, arguments: args },
      undefined,
      { timeout: this.options.definition.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, signal },
    );
    return this.oauth ? this.oauth.withAuthContext(call) : call();
  }

  private async dispose(): Promise<void> {
    const client = this.client;
    const transport = this.transport;
    this.client = undefined;
    this.transport = undefined;
    await client?.close().catch(() => undefined);
    await transport?.close().catch(() => undefined);
  }

  async close(): Promise<void> {
    await this.dispose();
    this.state = "not connected";
    this.discoveredTools = [];
    this.discoveredResources = [];
  }
}
