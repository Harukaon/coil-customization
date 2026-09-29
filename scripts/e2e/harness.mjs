// Launches the real CoilCoil desktop app against the mock gateway, and drives it
// the way a person would. See README.md.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { _electron as electron } from "playwright-core";
import { startMockGateway } from "./mock-gateway.mjs";

const here = import.meta.dirname;
export const repositoryRoot = resolve(here, "../..");
const require = createRequire(join(repositoryRoot, "package.json"));

/** Static pages the Agent opens in the built-in browser, at http://localhost:<port>/<name>.html. */
export async function startSite() {
  const server = createServer((request, response) => {
    const name = (request.url ?? "/").split("?", 1)[0].replace(/^\/+/, "");
    try {
      if (!/^[\w.-]+\.html$/.test(name) || extname(name) !== ".html") throw new Error("not found");
      const body = readFileSync(join(here, "site", name));
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const { port } = server.address();
  return { url: (page) => `http://localhost:${port}/${page}`, close: () => new Promise((done) => server.close(done)) };
}

/**
 * A fresh app: its own data directory, the mock model configured as the default
 * (and as every subagent profile's model), two mounted folders, onboarding done.
 */
/** 找一个空闲端口：远程访问要一个固定端口才能从外面连进来。 */
function freePort() {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

/**
 * `remote: true` 时同时打开远程访问（网页版 / 手机连的那个入口），返回的 remotePort
 * 交给 openRemoteClient，接一个真的网页客户端进来。
 *
 * 默认关着 GPU（稳定、和没有显卡的机器一样，浏览器面板走普通画面）；`gpu: true` 的
 * 场景开着 GPU，浏览器面板走共享纹理画面，和真实用户的 Mac 一样。
 */
/**
 * `onboarding: true` starts like a customer's first launch: no model configured, the
 * onboarding screen still up. The Spark AI address is pointed at the mock gateway
 * (through the `coilcoil.sparkBaseUrl` override) and `sparkModels` is what its
 * /models answers.
 */
export async function launch({ projects = ["projA", "projB"], remote = false, gpu = false, onboarding = false, sparkModels } = {}) {
  const root = mkdtempSync(join(tmpdir(), "coilcoil-e2e-"));
  const data = join(root, "data");
  const home = join(root, "home");
  const log = join(root, "gateway.jsonl");
  mkdirSync(join(data, "agent"), { recursive: true });
  mkdirSync(home, { recursive: true });
  const paths = Object.fromEntries(projects.map((name) => {
    const path = join(root, name);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "README.md"), `# ${name}\n`);
    return [name, path];
  }));
  const gateway = await startMockGateway({ log, ...sparkModels ? { models: sparkModels } : {} });
  const agent = (file, value) => writeFileSync(join(data, "agent", file), JSON.stringify(value, null, 2));
  if (!onboarding) {
    agent("models.json", {
      providers: {
        mock: {
          baseUrl: gateway.baseUrl,
          api: "openai-completions",
          apiKey: "mock-key",
          models: [{ id: "mock-1", name: "Mock 1", contextWindow: 200000, maxTokens: 8192, input: ["text"], reasoning: false }],
        },
      },
    });
    agent("settings.json", { defaultProvider: "mock", defaultModel: "mock-1" });
    agent("subagent-settings.json", { models: { explore: "mock/mock-1", reviewer: "mock/mock-1", worker: "mock/mock-1" } });
  }
  writeFileSync(join(data, "mounted-projects.json"), JSON.stringify(
    Object.entries(paths).map(([name, path]) => ({ name, path, kind: "workspace" })), null, 2));

  const remotePort = remote ? await freePort() : undefined;
  const app = await electron.launch({
    executablePath: require("electron"),
    args: [join(repositoryRoot, "apps/desktop"), `--user-data-dir=${data}`, "--no-sandbox", ...gpu ? [] : ["--disable-gpu"]],
    env: { ...process.env, HOME: home, USERPROFILE: home, ...remote ? { COILCOIL_REMOTE_PORT: String(remotePort) } : {} },
    timeout: 90_000,
  });
  const page = await app.firstWindow();
  await page.waitForFunction(() => Boolean(window.coilcoil), undefined, { timeout: 60_000 });
  if (onboarding) await page.evaluate((url) => window.localStorage.setItem("coilcoil.sparkBaseUrl", url), gateway.baseUrl);
  else await page.evaluate(() => window.localStorage.setItem("coilcoil.onboarding", JSON.stringify({ completedAt: new Date().toISOString() })));
  await page.reload();
  await page.waitForFunction(() => Boolean(window.coilcoil), undefined, { timeout: 60_000 });
  // 等输入框下面显示出模型名：界面启动后要先向运行时读一次配置，读回来之前点发送
  // 只会得到「正在读取模型配置」。真人看到的也是这个状态。
  if (onboarding) await page.getByRole("heading", { name: /待在同一个界面里/ }).waitFor({ timeout: 60_000 });
  else await page.locator(".agent-mode", { hasText: "Mock 1" }).first().waitFor({ timeout: 60_000 });
  const close = async () => {
    await app.close().catch(() => undefined);
    await new Promise((done) => gateway.server.close(done));
  };
  return { app, page, root, paths, remotePort, close, gatewayLog: () => readLog(log) };
}

function readLog(path) {
  try {
    return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

/**
 * 接一个真的网页版客户端进来：和用户在电脑浏览器里打开远程地址一样，走配对码配对，
 * 拿到的是远程桥（remote-client），不是桌面窗口的 preload。窗口开得够宽，是电脑上
 * 的网页版，不是手机布局。
 */
export async function openRemoteClient({ app, page, remotePort, width = 1400, height = 900 }) {
  const { pairingCode } = await page.evaluate(() => window.coilcoil.getRemoteAccess());
  if (!pairingCode) throw new Error("远程访问没有开起来，拿不到配对码。");
  const url = `http://127.0.0.1:${remotePort}/`;
  const [client] = await Promise.all([
    app.waitForEvent("window", { timeout: 30_000 }),
    app.evaluate(({ BrowserWindow }, { url, width, height }) => {
      const win = new BrowserWindow({ width, height, show: true, webPreferences: { partition: "e2e-remote-client" } });
      void win.loadURL(url);
    }, { url, width, height }),
  ]);
  await client.waitForLoadState();
  const paired = await client.evaluate(async (code) => (await fetch("/__remote/pair", { method: "POST", body: JSON.stringify({ code, name: "e2e 网页版" }) })).status, pairingCode);
  if (paired !== 200) throw new Error(`配对失败：${paired}`);
  await client.evaluate(() => window.localStorage.setItem("coilcoil.onboarding", JSON.stringify({ completedAt: new Date().toISOString() })));
  await client.reload();
  await client.waitForFunction(() => Boolean(window.coilcoil) && document.documentElement.dataset.client === "remote", undefined, { timeout: 60_000 });
  await client.locator(".agent-mode", { hasText: "Mock 1" }).first().waitFor({ timeout: 60_000 });
  return client;
}

/** Helpers that drive the UI the way a person would. */
export function driver(page) {
  const echoes = () => page.getByText("工具返回", { exact: false }).count();
  return {
    async newConversation(project) {
      await page.getByRole("button", { name: `在 ${project} 中新建对话` }).click();
      await page.waitForTimeout(300);
    },
    /** Types `label MOCK:[...]` into the composer, sends it, waits for the next echo. */
    async send(script, label = "") {
      const before = await echoes();
      await page.locator(".prompt-editor").click();
      await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.insertText(`${label ? `${label} ` : ""}MOCK:${JSON.stringify(script)}`);
      await page.getByRole("button", { name: "发送消息" }).click();
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        if ((await echoes()) > before) { await page.waitForTimeout(800); return; }
        await page.waitForTimeout(200);
      }
      throw new Error(`no reply for ${JSON.stringify(script)}`);
    },
    /** The last echo the mock model wrote into the transcript. */
    async lastEcho() {
      const all = await page.locator("main").innerText();
      return all.slice(all.lastIndexOf("工具返回"));
    },
    /** Browser tabs in the right-hand panel, with whether each carries the Agent badge. */
    async browserTabs() {
      return page.locator(".inspector-tab-select").evaluateAll((elements) => elements.map((element) => ({
        label: element.textContent.trim(),
        agent: (element.getAttribute("title") ?? "").includes("Agent 开的"),
      })));
    },
    async openBrowserPanel() {
      const expand = page.getByRole("button", { name: "展开作业栏" });
      if (await expand.count()) await expand.click();
      await page.waitForTimeout(300);
      await page.getByRole("button", { name: "浏览器", exact: true }).click();
      await page.waitForTimeout(1200);
    },
    async typeAddress(url) {
      const bar = page.getByRole("textbox", { name: "网页地址" });
      await bar.fill(url);
      await bar.press("Enter");
    },
    async openSidebarConversation(title) {
      await page.locator("[class*=sidebar]").getByText(title, { exact: true }).first().click();
      await page.waitForTimeout(1500);
    },
    async waitFor(condition, timeout = 10_000) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (await condition()) return true;
        await page.waitForTimeout(200);
      }
      return false;
    },
  };
}
