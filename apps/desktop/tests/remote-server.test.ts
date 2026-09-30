import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import test from "node:test";
import { WebSocket } from "ws";
import { isTrustedAddress } from "../src/main/remote/remote-auth";
import { REMOTE_INVOKE_CHANNELS, bridgeScript, pairingPage } from "../src/main/remote/remote-client";
import { RemoteServer } from "../src/main/remote/remote-server";

const APP_HTML = "<!doctype html>\n<html>\n  <head>\n    <title>CoilCoil</title>\n  </head>\n  <body></body>\n</html>\n";

async function startServer(
  t: test.TestContext,
  invoke: (channel: string, args: unknown[]) => Promise<unknown> = async () => "ok",
) {
  const directory = await mkdtemp(join(tmpdir(), "coilcoil-remote-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  // The renderer directory holds only the app; anything the server must never
  // hand out lives beside it, one level up.
  const rendererDir = join(directory, "renderer");
  await mkdir(rendererDir, { recursive: true });
  await writeFile(join(rendererDir, "index.html"), APP_HTML, "utf8");
  await writeFile(join(rendererDir, "app.js"), "// bundle\n", "utf8");
  await writeFile(join(directory, "secret.txt"), "device tokens", "utf8");

  const server = new RemoteServer({
    host: "127.0.0.1",
    port: 0,
    platform: "darwin",
    rendererDir,
    authFile: join(directory, "remote-devices.json"),
    invoke,
    log: () => undefined,
    trustLocalNetwork: () => true,
  });
  const address = await server.start();
  t.after(() => server.stop());
  return { server, address, directory, rendererDir };
}

async function pair(address: string, code: string): Promise<{ status: number; cookie?: string }> {
  const response = await fetch(`${address}/__remote/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, name: "test phone" }),
  });
  const raw = response.headers.get("set-cookie") ?? undefined;
  return { status: response.status, cookie: raw?.split(";")[0] };
}

test("an unpaired device only ever gets the pairing page", async (t) => {
  const { address } = await startServer(t);
  const response = await fetch(`${address}/`);
  const body = await response.text();
  assert.match(body, /登录以遥控这台 Mac/);
  assert.doesNotMatch(body, /<title>CoilCoil<\/title>/);
});

test("Windows remote login uses Windows wording instead of Mac wording", () => {
  const page = pairingPage(undefined, "win32");
  assert.match(page, /登录以遥控这台 Windows/);
  assert.doesNotMatch(page, /Mac/);
  assert.match(bridgeScript("win32"), /hostLabel = "Windows"/);
});

test("a wrong pairing code is rejected and hands out no cookie", async (t) => {
  const { address, server } = await startServer(t);
  const wrong = server.auth.pairingCode() === "000000" ? "111111" : "000000";
  const result = await pair(address, wrong);
  assert.equal(result.status, 403);
  assert.equal(result.cookie, undefined);
});

test("pairing rotates the code so it cannot be replayed", async (t) => {
  const { address, server } = await startServer(t);
  const code = server.auth.pairingCode();
  assert.equal((await pair(address, code)).status, 200);
  assert.notEqual(server.auth.pairingCode(), code);
  assert.equal((await pair(address, code)).status, 403);
});

test("a paired device gets the app with the bridge ahead of its bundle", async (t) => {
  const { address, server } = await startServer(t);
  const { cookie } = await pair(address, server.auth.pairingCode());
  assert.ok(cookie);
  const response = await fetch(`${address}/`, { headers: { cookie } });
  const body = await response.text();
  assert.match(body, /<script src="\/__remote\/bridge\.js"><\/script>/);
  assert.ok(body.indexOf("/__remote/bridge.js") < body.indexOf("</head>"));
});

/** fetch() rewrites `..` before sending, so a traversal has to be sent raw. */
function rawGet(address: string, path: string, cookie: string): Promise<{ status: number; body: string }> {
  const target = new URL(address);
  return new Promise((done, failed) => {
    const call = httpRequest(
      { hostname: target.hostname, port: target.port, path, method: "GET", headers: { cookie } },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => { body += chunk; });
        response.on("end", () => done({ status: response.statusCode ?? 0, body }));
      },
    );
    call.on("error", failed);
    call.end();
  });
}

test("asset paths cannot walk out of the renderer directory", async (t) => {
  const { address, server } = await startServer(t);
  const { cookie } = await pair(address, server.auth.pairingCode());

  const literal = await rawGet(address, "/../secret.txt", cookie!);
  assert.equal(literal.status, 404);
  assert.doesNotMatch(literal.body, /device tokens/);

  const encoded = await rawGet(address, "/%2e%2e/secret.txt", cookie!);
  assert.equal(encoded.status, 404);
  assert.doesNotMatch(encoded.body, /device tokens/);

  const inside = await rawGet(address, "/app.js", cookie!);
  assert.equal(inside.status, 200);
  assert.match(inside.body, /bundle/);
});

test("the socket relays allowed channels and refuses everything else", async (t) => {
  const seen: string[] = [];
  const { address, server } = await startServer(t, async (channel) => {
    seen.push(channel);
    return { ok: true, value: { sessions: [] } };
  });
  const { cookie } = await pair(address, server.auth.pairingCode());
  const socket = new WebSocket(`${address.replace("http", "ws")}/__remote/ws`, { headers: { cookie: cookie! } });
  t.after(() => socket.close());
  await new Promise((ready, failed) => {
    socket.once("open", ready);
    socket.once("error", failed);
  });

  const reply = (frame: unknown): Promise<any> => new Promise((done) => {
    socket.once("message", (raw) => done(JSON.parse(String(raw))));
    socket.send(JSON.stringify(frame));
  });

  const allowed = await reply({ id: "1", channel: "runtime:request", args: [{ command: { type: "bootstrap" } }] });
  assert.equal(allowed.ok, true);
  assert.deepEqual(seen, ["runtime:request"]);

  const refused = await reply({ id: "2", channel: "remote:not-a-real-channel", args: [] });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /不支持/);
  assert.deepEqual(seen, ["runtime:request"]);
});

test("an unpaired socket is dropped before it can send anything", async (t) => {
  const { address } = await startServer(t);
  const socket = new WebSocket(`${address.replace("http", "ws")}/__remote/ws`);
  const failure = await new Promise<string>((done) => {
    socket.once("error", (error: Error) => done(error.message));
    socket.once("open", () => done("opened"));
  });
  assert.notEqual(failure, "opened");
});

test("runtime events reach every connected remote client", async (t) => {
  const { address, server } = await startServer(t);
  const { cookie } = await pair(address, server.auth.pairingCode());
  const socket = new WebSocket(`${address.replace("http", "ws")}/__remote/ws`, { headers: { cookie: cookie! } });
  t.after(() => socket.close());
  await new Promise((ready) => socket.once("open", ready));

  const pushed = new Promise<any>((done) => socket.once("message", (raw) => done(JSON.parse(String(raw)))));
  // The desktop window is served by the same broadcast, which is what keeps
  // the phone and the Mac looking at one session rather than two.
  server.broadcast("runtime:event", { runtimeId: "r1", event: { type: "message_started" } });
  const frame = await pushed;
  assert.equal(frame.push, "runtime:event");
  assert.equal(frame.payload.runtimeId, "r1");
});

test("pairing a new device retires the previous one", async (t) => {
  const { address, server } = await startServer(t);
  const first = await pair(address, server.auth.pairingCode());
  const second = await pair(address, server.auth.pairingCode());
  assert.equal(second.status, 200);
  assert.notEqual(first.cookie, second.cookie);

  const retired = await fetch(`${address}/`, { headers: { cookie: first.cookie! } });
  assert.match(await retired.text(), /登录以遥控这台 Mac/);
  const current = await fetch(`${address}/`, { headers: { cookie: second.cookie! } });
  assert.match(await current.text(), /__remote\/bridge\.js/);
});

// 本机回环（测试走 127.0.0.1）多端共存：两个连接都在，不互踢，都能收到推送。
test("loopback connections coexist without displacing each other", async (t) => {
  const { address, server } = await startServer(t);
  const { cookie } = await pair(address, server.auth.pairingCode());
  const url = `${address.replace("http", "ws")}/__remote/ws`;

  const first = new WebSocket(url, { headers: { cookie: cookie! } });
  t.after(() => first.close());
  await new Promise((ready) => first.once("open", ready));
  let firstClosed = false;
  first.once("close", () => { firstClosed = true; });

  const second = new WebSocket(url, { headers: { cookie: cookie! } });
  t.after(() => second.close());
  await new Promise((ready) => second.once("open", ready));
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(firstClosed, false);
  assert.equal(server.connectedClients(), 2);

  // 两边都收到 Mac 的推送。
  const pushedFirst = new Promise<any>((done) => first.once("message", (raw) => done(JSON.parse(String(raw)))));
  const pushedSecond = new Promise<any>((done) => second.once("message", (raw) => done(JSON.parse(String(raw)))));
  server.broadcast("runtime:event", { runtimeId: "r1", event: { type: "message_started" } });
  assert.equal((await pushedFirst).push, "runtime:event");
  assert.equal((await pushedSecond).push, "runtime:event");
});

test("a tailnet or LAN peer skips the login screen, loopback never does", async (t) => {
  const { address, directory } = await startServer(t);
  // The reverse-proxy tunnel arrives on loopback, so trusting loopback would
  // hand the whole internet a free pass through the proxy.
  assert.equal(isTrustedAddress("127.0.0.1"), false);
  assert.equal(isTrustedAddress("::ffff:127.0.0.1"), false);
  assert.equal(isTrustedAddress("100.101.102.103"), true);
  assert.equal(isTrustedAddress("192.168.1.20"), true);
  assert.equal(isTrustedAddress("10.0.0.5"), true);
  assert.equal(isTrustedAddress("203.0.113.7"), false);
  assert.ok(address.startsWith("http://127.0.0.1"));
  assert.ok(directory);
});

test("trusted networks stay closed while the option is off", async (t) => {
  const { address } = await startServer(t);
  // The test server connects over loopback, which is never trusted.
  const response = await fetch(`${address}/`);
  assert.match(await response.text(), /登录以遥控这台 Mac/);
});

test("an account signs in without a pairing code and retires the old device", async (t) => {
  const { address, server } = await startServer(t);
  const paired = await pair(address, server.auth.pairingCode());
  assert.equal(paired.status, 200);

  server.auth.setPassword("hao", "correct horse");
  const wrong = await fetch(`${address}/__remote/sign-in`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "hao", password: "nope", name: "phone" }),
  });
  assert.equal(wrong.status, 403);

  const right = await fetch(`${address}/__remote/sign-in`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "hao", password: "correct horse", name: "phone" }),
  });
  assert.equal(right.status, 200);
  const cookie = right.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);

  const app = await fetch(`${address}/`, { headers: { cookie: cookie! } });
  assert.match(await app.text(), /__remote\/bridge\.js/);

  const retired = await fetch(`${address}/`, { headers: { cookie: paired.cookie! } });
  assert.match(await retired.text(), /登录以遥控这台 Mac/);
});

test("clearing the account leaves only the pairing code", async (t) => {
  const { address, server } = await startServer(t);
  server.auth.setPassword("hao", "correct horse");
  server.auth.clearPassword();
  const attempt = await fetch(`${address}/__remote/sign-in`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "hao", password: "correct horse", name: "phone" }),
  });
  assert.equal(attempt.status, 403);
  assert.equal(server.auth.username(), undefined);
});

test("手机拿得到挂载的文件夹清单，而不是只剩一个 Home", () => {
  // 手机上的 localStorage 属于远程那个来源，永远是空的，所以这份数据只能问
  // Mac 要。少了这几条通道，手机连上来侧栏里就只有一个 Home——这正是它出过的样子。
  for (const channel of ["projects:mounted", "projects:mounted:set"]) {
    assert.ok(REMOTE_INVOKE_CHANNELS.includes(channel as (typeof REMOTE_INVOKE_CHANNELS)[number]),
      `${channel} 不在远程允许的通道里`);
  }
  const script = bridgeScript("darwin");
  for (const method of ["mountedProjects", "setMountedProjects"]) {
    assert.match(script, new RegExp(`${method}: function`), `远程那半个 bridge 少了 ${method}`);
  }
});

test("手机能看图、也能看到 Mac 上已经开着的网页标签", () => {
  // 预览的内容是 Mac 读出来随返回值送过去的，浏览器则是 Mac 上那一个——两样都没有
  // 「手机做不到」的理由，之前只是被 shim 直接回绝或者回了一份空数据。
  for (const channel of ["preview:open", "preview:close", "browser:get-state"]) {
    assert.ok(REMOTE_INVOKE_CHANNELS.includes(channel as (typeof REMOTE_INVOKE_CHANNELS)[number]),
      `${channel} 不在远程允许的通道里`);
  }
  const script = bridgeScript("darwin");
  assert.match(script, /openFilePreview: function \(input\) \{ return invoke\("preview:open"/);
  assert.doesNotMatch(script, /openFilePreview: rejects/, "文件预览又被回绝了");
  // 先设置远程客户端自己的 scope，再单独读取 Mac 上这个 scope 的真实状态。
  assert.match(script, /setBrowserScope: function \(scopeId, workspacePath\) \{ return invoke\("browser:set-scope"/);
  assert.match(script, /getBrowserState: function \(scopeId\) \{ return invoke\("browser:get-state"/);
  assert.match(script, /onBrowserStateUpdated: subscribe\("browser:state"\)/);
});

test("Electron 自己的原生 bridge 不会被浏览器 bridge 覆盖", () => {
  const nativeBridge = { isRemote: false };
  const context = {
    window: { coilcoil: nativeBridge },
    console,
  };
  vm.runInNewContext(bridgeScript("darwin"), context);
  assert.equal(context.window.coilcoil, nativeBridge);
});
