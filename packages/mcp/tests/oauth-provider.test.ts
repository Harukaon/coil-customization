import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { McpCredentialStore, credentialKey, defaultCredentialFile } from "../src/credential-store.ts";
import { McpOAuthProvider } from "../src/oauth-provider.ts";

const SERVER = "https://mcp.example.com/v1";

function provider(): { provider: McpOAuthProvider; store: McpCredentialStore; opened: URL[] } {
  const directory = mkdtempSync(join(tmpdir(), "coilcoil-mcp-oauth-"));
  const store = new McpCredentialStore(defaultCredentialFile(join(directory, "agent")));
  const opened: URL[] = [];
  return {
    store,
    opened,
    provider: new McpOAuthProvider({
      serverUrl: SERVER,
      store,
      redirectUrl: "http://127.0.0.1:7891/callback",
      openAuthorization: (url) => { opened.push(url); },
    }),
  };
}

const tokens = { access_token: "at", refresh_token: "rt", token_type: "Bearer" } as unknown as OAuthTokens;

test("授权信息进的是 CoilCoil 自己的文件，不碰系统钥匙串", () => {
  // 这正是换掉 pi-mcp-adapter 的原因：ad-hoc 签名下每次重新打包，macOS 都把
  // CoilCoil 当成另一个应用，于是每次都弹窗要钥匙串权限。
  const { provider: auth, store } = provider();
  auth.saveTokens(tokens);
  assert.deepEqual(store.get(credentialKey(SERVER))?.tokens, tokens);
  assert.deepEqual(auth.tokens(), tokens);
});

test("客户端元数据里的回调地址和真正用的那一个是同一个", () => {
  // 两处对不上，授权服务器会直接拒掉重定向，而且报的错通常看不出是这个原因。
  const { provider: auth } = provider();
  assert.deepEqual(auth.clientMetadata.redirect_uris, [auth.redirectUrl]);
  assert.equal(auth.clientMetadata.token_endpoint_auth_method, "none");
});

test("state 存下来，浏览器隔一会儿回来也还认得", () => {
  const { provider: auth, store } = provider();
  const first = auth.state();
  assert.equal(auth.state(), first, "同一次授权里 state 必须稳定");
  // 换一个 provider 实例读同一份存储——等于进程重启后继续这次授权。
  const resumed = new McpOAuthProvider({
    serverUrl: SERVER, store, redirectUrl: "http://127.0.0.1:7891/callback", openAuthorization: () => undefined,
  });
  assert.equal(resumed.state(), first);
});

test("换到令牌之后，PKCE 校验码和 state 一起作废", () => {
  const { provider: auth, store } = provider();
  auth.saveCodeVerifier("verifier-1");
  auth.state();
  auth.saveTokens(tokens);
  const record = store.get(credentialKey(SERVER));
  // 留着就等于同一个回调可以被重放到一次已经结束的授权上。
  assert.equal(record?.codeVerifier, undefined);
  assert.equal(record?.state, undefined);
  assert.throws(() => auth.codeVerifier(), /重新发起认证/);
});

test("授权页记下来，失败了还能重新打开", async () => {
  const { provider: auth, opened } = provider();
  const url = new URL("https://auth.example.com/authorize?state=s-1");
  await auth.redirectToAuthorization(url);
  assert.deepEqual(opened, [url]);
  assert.equal(auth.authorizationUrl?.href, url.href);
});

test("服务器说凭据过期了就按范围丢掉", () => {
  const { provider: auth, store } = provider();
  auth.saveClientInformation({ client_id: "abc" } as never);
  auth.saveTokens(tokens);
  auth.saveCodeVerifier("v");

  auth.invalidateCredentials("tokens");
  assert.equal(auth.tokens(), undefined);
  assert.deepEqual(store.get(credentialKey(SERVER))?.clientInformation, { client_id: "abc" });

  auth.invalidateCredentials("verifier");
  assert.equal(store.get(credentialKey(SERVER))?.codeVerifier, undefined);

  auth.invalidateCredentials("client");
  assert.equal(auth.clientInformation(), undefined);
});

test("登出是整条记录一起没，注册信息不留", () => {
  const { provider: auth, store } = provider();
  auth.saveClientInformation({ client_id: "abc" } as never);
  auth.saveTokens(tokens);
  auth.invalidateCredentials("all");
  assert.equal(store.get(credentialKey(SERVER)), undefined);
});

test("两个服务器的凭据互不串门", () => {
  const directory = mkdtempSync(join(tmpdir(), "coilcoil-mcp-oauth-"));
  const store = new McpCredentialStore(defaultCredentialFile(join(directory, "agent")));
  const make = (url: string): McpOAuthProvider => new McpOAuthProvider({
    serverUrl: url, store, redirectUrl: "http://127.0.0.1:7891/callback", openAuthorization: () => undefined,
  });
  const a = make("https://a.example.com/mcp");
  const b = make("https://b.example.com/mcp");
  a.saveTokens(tokens);
  assert.equal(b.tokens(), undefined);
  b.invalidateCredentials("all");
  assert.deepEqual(a.tokens(), tokens);
});

test("并发续期只请求一次，旧请求不能清除或覆盖新凭证", async () => {
  const { provider: first, store } = provider();
  const second = new McpOAuthProvider({
    serverUrl: SERVER, store, redirectUrl: first.redirectUrl, openAuthorization: () => undefined,
  });
  first.saveTokens(tokens);
  let release!: (response: Response) => void;
  let calls = 0;
  const fetchRefresh = () => {
    calls++;
    return new Promise<Response>((resolve) => { release = resolve; });
  };
  const request = new URLSearchParams({ grant_type: "refresh_token", refresh_token: "rt" });
  const one = first.withAuthContext(async () => {
    first.tokens();
    const response = await first.refresh(request, fetchRefresh);
    const fresh = await response.json() as OAuthTokens;
    first.saveTokens(fresh);
    return fresh;
  });
  const two = second.withAuthContext(async () => {
    second.tokens();
    const response = await second.refresh(request, fetchRefresh);
    const fresh = await response.json() as OAuthTokens;
    // The slower SDK invocation may save or invalidate after a newer result.
    await one;
    second.saveTokens(fresh);
    second.invalidateCredentials("tokens");
    return fresh;
  });
  assert.equal(calls, 1, "同一份旧 refresh token 只能向服务端续期一次");
  release(new Response(JSON.stringify({ access_token: "new-at", refresh_token: "new-rt", token_type: "Bearer" }), {
    status: 200, headers: { "content-type": "application/json" },
  }));
  await Promise.all([one, two]);
  assert.equal(second.tokens()?.refresh_token, "new-rt", "旧请求返回后仍要保住新令牌");

  // A request which read the old token before the successful rotation may only
  // reach the fetch hook after the new token was saved.
  const late = await second.withAuthContext(async () => second.refresh(request, fetchRefresh));
  assert.equal((await late.json() as OAuthTokens).refresh_token, "new-rt");
  assert.equal(calls, 1, "迟到的旧请求不应拿已失效的令牌再找服务端");
});

test("服务端不轮换 refresh token 时，下次过期必须重新续期", async () => {
  const { provider: auth } = provider();
  auth.saveTokens(tokens);
  let calls = 0;
  const request = new URLSearchParams({ grant_type: "refresh_token", refresh_token: "rt" });
  for (const access of ["new-at-1", "new-at-2"]) {
    await auth.withAuthContext(async () => {
      auth.tokens();
      const response = await auth.refresh(request, async () => {
        calls++;
        return new Response(JSON.stringify({ access_token: access, refresh_token: "rt", token_type: "Bearer" }));
      });
      auth.saveTokens(await response.json() as OAuthTokens);
    });
  }
  assert.equal(calls, 2);
  assert.equal(auth.tokens()?.access_token, "new-at-2");
});

test("迟到的 invalid_grant 不得抹掉另一请求保存的新令牌", async () => {
  const { provider: auth } = provider();
  auth.saveTokens(tokens);
  let release!: (response: Response) => void;
  await auth.withAuthContext(async () => {
    auth.tokens();
    const pending = auth.refresh(
      new URLSearchParams({ grant_type: "refresh_token", refresh_token: "rt" }),
      () => new Promise<Response>((resolve) => { release = resolve; }),
    );
    auth.saveTokens({ access_token: "new-at", refresh_token: "new-rt", token_type: "Bearer" });
    release(new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
    const response = await pending;
    assert.equal(response.status, 200, "缓存已轮换时，旧请求的失败应转为现有凭证");
    assert.equal((await response.json() as OAuthTokens).refresh_token, "new-rt");
    auth.invalidateCredentials("tokens");
    auth.saveTokens({ access_token: "stale-at", refresh_token: "stale-rt", token_type: "Bearer" });
  });
  assert.equal(auth.tokens()?.refresh_token, "new-rt");
});

test("当前刷新令牌确实失效时仍会清除凭证，让用户重新授权", async () => {
  const { provider: auth } = provider();
  auth.saveTokens(tokens);
  await auth.withAuthContext(async () => {
    auth.tokens();
    const response = await auth.refresh(
      new URLSearchParams({ grant_type: "refresh_token", refresh_token: "rt" }),
      async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
    );
    assert.equal(response.status, 400);
    auth.invalidateCredentials("tokens");
  });
  assert.equal(auth.tokens(), undefined);
});

test("回调端口变了之后，旧的注册信息要作废重来", () => {
  // 回调监听器按 7842、7843… 依次找空位，所以上一次授权可能注册在别的端口上。
  // 拿着那份旧注册再去发起授权，服务器只会回「redirect_uri 与注册时不一致」，
  // 而且会一直这样——除非我们自己认出来并重新注册。
  const { provider: subject, store } = provider();
  store.update(credentialKey(SERVER), {
    url: SERVER,
    clientInformation: {
      client_id: "kmg_client_old",
      redirect_uris: ["http://127.0.0.1:7843/callback"],
    } as never,
  });
  assert.equal(subject.clientInformation(), undefined, "地址对不上就当没注册过");

  store.update(credentialKey(SERVER), {
    url: SERVER,
    clientInformation: {
      client_id: "kmg_client_current",
      redirect_uris: ["http://127.0.0.1:7891/callback"],
    } as never,
  });
  assert.equal(subject.clientInformation()?.client_id, "kmg_client_current", "地址对得上就继续用");
});

test("服务器没回 redirect_uris 时不乱作废", () => {
  // 没告诉我们注册了什么，不代表对不上；作废了只会白白重新注册一次。
  const { provider: subject, store } = provider();
  store.update(credentialKey(SERVER), {
    url: SERVER,
    clientInformation: { client_id: "kmg_client_quiet" } as never,
  });
  assert.equal(subject.clientInformation()?.client_id, "kmg_client_quiet");
});
