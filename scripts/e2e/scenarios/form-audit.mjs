// Records how every text field, multi-line field, label, form and footer really ends up
// looking, screen by screen, so a change to the form styles can be proved to change nothing.
//
//   FORM_AUDIT_OUT=/tmp/before.json npm run e2e -- form-audit     (before the change)
//   FORM_AUDIT_OUT=/tmp/after.json  npm run e2e -- form-audit     (after)
//   node scripts/form-audit-diff.mjs /tmp/before.json /tmp/after.json
//
// For each control it stores the browser's final computed style (all properties), its box, the
// placeholder style and what focusing it changes (asked from Chromium with a forced :focus /
// :focus-visible, so nothing is really focused and nothing reacts to a blur). Every screen is
// also read again with the dark theme on.
//
// Without FORM_AUDIT_OUT it only checks that every field on every screen comes from the shared
// form components (they carry data-ui), which is what keeps new fields from going wrong.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const description = "控件样式审计：逐屏记录所有输入框/多行框/标签/表单的最终样式（改样式前后对比用）；平时检查每个输入控件都来自公共控件";

const OUT = process.env.FORM_AUDIT_OUT;

/** Runs in the page: one entry per field, label, form and footer on the current screen. */
const collect = () => {
  const props = (element, pseudo) => {
    const style = getComputedStyle(element, pseudo);
    const result = {};
    for (const name of style) result[name] = style.getPropertyValue(name);
    return result;
  };
  const pick = (all, names) => Object.fromEntries(names.map((name) => [name, all[name]]));
  const box = (element) => {
    const rect = element.getBoundingClientRect();
    return [rect.x, rect.y, rect.width, rect.height].map((value) => Math.round(value * 2) / 2);
  };
  const entries = {};
  const seen = { input: 0, textarea: 0, label: 0, form: 0, footer: 0 };
  const idOf = new Map();
  for (const element of document.querySelectorAll("input, textarea, label, form, footer")) {
    const tag = element.tagName.toLowerCase();
    const id = `${tag}#${seen[tag]++}`;
    idOf.set(element, id);
    const hint = (element.getAttribute("aria-label") || element.getAttribute("placeholder") || element.textContent || "").trim().slice(0, 28);
    const entry = { id, tag, type: element.type ?? "", hint, ui: element.dataset.ui ?? "", classes: typeof element.className === "string" ? element.className : "", surface: Boolean(element.closest(".settings-screen, .settings-surface")), wrapper: element.parentElement ? `${element.parentElement.tagName.toLowerCase()}.${String(element.parentElement.className).split(" ").filter(Boolean).join(".")}` : "", style: props(element), box: box(element) };
    if (tag === "input" || tag === "textarea") {
      entry.placeholder = pick(props(element, "::placeholder"), ["color", "opacity", "font-size", "font-style", "font-family", "font-weight", "letter-spacing", "text-transform"]);
    }
    entries[id] = entry;
  }
  const order = [...document.querySelectorAll("input, textarea")].map((element) => idOf.get(element));
  return { entries, order };
};

/** In the main process: what :focus and :focus-visible change on every field, without focusing anything. */
async function focusDeltas(app, url) {
  return app.evaluate(async ({ BrowserWindow }, url) => {
    const win = BrowserWindow.getAllWindows().find((item) => !item.isDestroyed() && item.webContents.getURL() === url);
    if (!win) return [];
    const debug = win.webContents.debugger;
    let attached = false;
    try { debug.attach("1.3"); attached = true; } catch { /* already attached */ }
    try {
      await debug.sendCommand("DOM.enable");
      await debug.sendCommand("CSS.enable");
      const { root } = await debug.sendCommand("DOM.getDocument", { depth: 0 });
      const { nodeIds } = await debug.sendCommand("DOM.querySelectorAll", { nodeId: root.nodeId, selector: "input, textarea" });
      const deltas = [];
      for (const nodeId of nodeIds) {
        const base = await debug.sendCommand("CSS.getComputedStyleForNode", { nodeId });
        await debug.sendCommand("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["focus", "focus-visible"] });
        const focused = await debug.sendCommand("CSS.getComputedStyleForNode", { nodeId });
        await debug.sendCommand("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] });
        const before = Object.fromEntries(base.computedStyle.map((item) => [item.name, item.value]));
        const delta = {};
        for (const item of focused.computedStyle) if (before[item.name] !== item.value) delta[item.name] = [before[item.name], item.value];
        deltas.push(delta);
      }
      return deltas;
    } finally {
      if (attached) debug.detach();
    }
  }, url);
}

export async function run({ app, page, ui, site, check, shot, root, paths }) {
  const result = { screens: {}, skipped: {} };
  const missing = [];
  page.setDefaultTimeout(8_000);

  // Entrance animations (onboarding steps fade and slide in) would otherwise be caught mid-flight and show up as a difference.
  const settled = (target) => target.evaluate(async () => {
    const wait = (work, limit) => Promise.race([work, new Promise((resolve) => setTimeout(resolve, limit))]);
    await wait(document.fonts.ready, 3_000); // a font swap re-wraps text, which moves sizes
    await wait(Promise.all(document.getAnimations()
      .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
      .map((animation) => animation.finished.catch(() => undefined))), 3_000);
  });
  const audit = async (name, target = page, settle = 450, { withDark = true, loop = true, focus = true } = {}) => {
    await target.waitForTimeout(settle);
    await settled(target);
    // Whatever happened to be focused would otherwise decide the border of the field around it.
    if (focus) await target.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
    // Things arrive late (a model list, a config path): read until two reads in a row agree.
    let light = await target.evaluate(collect);
    for (let attempt = 0; loop && attempt < 12; attempt += 1) {
      await target.waitForTimeout(200);
      const again = await target.evaluate(collect);
      const stable = JSON.stringify(again) === JSON.stringify(light);
      light = again;
      if (stable) break;
    }
    if (focus) {
      const deltas = await focusDeltas(app, target.url());
      light.order.forEach((id, index) => { light.entries[id].focus = deltas[index] ?? {}; });
    }
    const screen = { entries: light.entries };
    if (OUT && withDark) {
      await target.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
      await settled(target);
      screen.dark = (await target.evaluate(collect)).entries;
      await target.evaluate(() => document.documentElement.removeAttribute("data-theme"));
    }
    result.screens[name] = screen;
    for (const entry of Object.values(light.entries)) {
      if ((entry.tag === "input" || entry.tag === "textarea") && !entry.ui) missing.push(`${name}: ${entry.id} ${entry.hint}`);
    }
  };
  const optional = new Set(["oauth-dialog", "mobile-picker", "bubble", "value-picker"]);
  const step = async (name, action) => {
    try { await action(); } catch (error) {
      result.skipped[name] = String(error.message).split("\n").slice(0, 4).join(" ").slice(0, 300);
      await page.screenshot({ path: join("/tmp", `form-audit-skip-${name}.png`) }).catch(() => undefined);
      await page.keyboard.press("Escape").catch(() => undefined);
    }
  };
  const closeDialog = async () => {
    for (const name of ["取消", "关闭"]) {
      const button = page.getByRole("dialog").getByRole("button", { name }).first();
      if (await button.count()) { await button.click(); await page.waitForTimeout(250); return; }
    }
  };
  const escape = async () => {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    if (await page.getByRole("dialog").count()) await closeDialog();
  };
  const backToWorkspace = async () => {
    const back = page.getByRole("button", { name: "返回工作区" });
    if (await back.count()) { await back.click(); await page.waitForTimeout(300); }
  };
  const openSettings = async (section) => {
    if (!(await page.getByRole("button", { name: "返回工作区" }).count())) await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "返回工作区" }).waitFor({ timeout: 10_000 });
    if (section) await page.getByRole("navigation", { name: "设置栏目" }).getByRole("button", { name: section, exact: true }).click();
    await page.waitForTimeout(500);
  };
  const inspectorTab = async (name) => {
    const expand = page.getByRole("button", { name: "展开作业栏" });
    if (await expand.count()) await expand.click();
    await page.waitForTimeout(300);
    const choice = page.getByRole("button", { name, exact: true }).first();
    if (!(await choice.count())) {
      await page.getByRole("button", { name: "打开面板" }).first().click();
      await page.waitForTimeout(300);
    }
    const item = page.getByRole("menuitem", { name, exact: true });
    if (await item.count()) await item.first().click();
    else await page.getByRole("button", { name, exact: true }).first().click();
    await page.waitForTimeout(700);
  };

  await audit("main");

  await step("conversation", async () => {
    await ui.newConversation("projA");
    await ui.send([{ tool: "read", args: { path: "README.md" } }, { echo: true }], "审计");
    await audit("conversation");
  });

  await step("model-popover", async () => {
    await page.locator(".agent-mode").first().click();
    await page.locator(".model-popover-search input").waitFor({ timeout: 5_000 });
    await audit("model-popover");
    await escape();
  });

  await step("archived", async () => {
    await page.getByRole("button", { name: "归档会话" }).click();
    await page.locator(".archive-search input").waitFor({ timeout: 5_000 });
    await audit("archived");
    await escape();
  });

  await step("files", async () => {
    await inspectorTab("文件");
    await page.getByText("README.md", { exact: true }).last().click();
    await page.getByRole("button", { name: /编辑/ }).first().click();
    await page.locator("textarea.text-editor").waitFor({ timeout: 5_000 });
    await audit("files-edit");
  });

  await step("browser", async () => {
    await inspectorTab("浏览器");
    await ui.send([{ tool: "browser_open", args: { url: site.url("find.html") } }, { echo: true }], "浏览");
    await page.waitForTimeout(1200);
    await audit("browser-bar");
    const box = await page.locator(".browser-live-page").boundingBox();
    await page.mouse.click(box.x + 40, box.y + 40);
    await page.keyboard.press("ControlOrMeta+F");
    await page.locator(".browser-find-bar").waitFor({ timeout: 5_000 });
    await audit("browser-find");
    await page.keyboard.press("Escape");
  });

  await step("value-picker", async () => {
    await ui.send([{ tool: "browser_open", args: { url: site.url("pickers.html") } }, { echo: true }], "选择器");
    await page.waitForTimeout(1200);
    const area = await page.locator(".browser-live-page").boundingBox();
    const layout = await app.evaluate(({ webContents }) => {
      const contents = webContents.getAllWebContents().find((item) => !item.isDestroyed() && item.getURL().includes("pickers.html"));
      return contents.executeJavaScript("JSON.stringify({ d: document.getElementById('d').getBoundingClientRect(), width: innerWidth, height: innerHeight })");
    });
    const { d, width, height } = JSON.parse(layout);
    const scale = Math.min(area.width / width, area.height / height);
    // The page is still settling right after it opens, so a click can land beside the icon: try again.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await page.mouse.click(area.x + (d.right - 12) * scale, area.y + (d.y + d.height / 2) * scale);
      if (await page.locator(".browser-value-picker").waitFor({ timeout: 2_500 }).then(() => true, () => false)) break;
    }
    await page.locator(".browser-value-picker").waitFor({ timeout: 2_500 });
    await audit("value-picker", page, 0, { withDark: false, loop: false, focus: false }); // the popup closes by itself: one read, no focus probe, light only
    await page.keyboard.press("Escape");
  });

  await step("browser-data", async () => {
    await page.getByRole("button", { name: "登录状态" }).click();
    await page.waitForTimeout(400);
    await audit("browser-data");
    await escape();
  });

  await step("git", async () => {
    const git = (...args) => execFileSync("git", ["-C", paths.projA, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    git("init", "-q", "-b", "main");
    git("config", "user.name", "E2E");
    git("config", "user.email", "e2e@example.com");
    git("config", "commit.gpgsign", "false");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    writeFileSync(join(paths.projA, "README.md"), "# projA\n\n改动\n");
    await inspectorTab("Git");
    await page.locator(".git-commit textarea").waitFor({ timeout: 10_000 });
    await audit("git");
    await page.getByRole("button", { name: "切换分支" }).click();
    await page.locator(".git-branch-create input").waitFor({ timeout: 5_000 });
    await audit("git-branch");
    await escape();
  });

  await step("runtime", async () => {
    await inspectorTab("运行时");
    await audit("runtime");
    await page.getByRole("button", { name: /系统提示词|System Prompt|提示词/ }).first().click();
    await page.waitForTimeout(500);
    await audit("runtime-prompt");
    const edit = page.getByRole("button", { name: /^编辑/ });
    if (await edit.count()) { await edit.first().click(); await page.locator(".runtime-prompt-modal textarea").waitFor({ timeout: 5_000 }); await audit("runtime-prompt-edit"); }
    await escape();
  });

  await step("memory", async () => {
    await page.getByRole("button", { name: "记忆", exact: true }).click();
    await page.locator(".memory-control-group").first().waitFor({ timeout: 10_000 });
    await audit("memory");
    await backToWorkspace();
    await page.keyboard.press("Escape");
  });

  // ---- Settings ----
  await step("settings-models", async () => {
    await openSettings("模型与服务商");
    await audit("models-default");
    const summary = page.locator(".provider-model-summary").first();
    if (await summary.count()) { await summary.click(); await audit("models-card-open"); }
    for (const details of await page.locator("details.provider-advanced > summary").all()) { await details.click().catch(() => undefined); }
    await audit("models-details-open");
    await page.getByRole("button", { name: "添加自定义服务商" }).click();
    await audit("models-new-custom");
    const pick = async (label) => { await page.locator(".provider-catalog").getByRole("button", { name: new RegExp(label) }).first().click(); await page.waitForTimeout(500); };
    await pick("Amazon Bedrock");
    await audit("models-bedrock");
    for (const details of await page.locator("details.provider-advanced > summary").all()) { await details.click().catch(() => undefined); }
    await audit("models-bedrock-advanced");
    await page.getByRole("button", { name: "自定义目录" }).click();
    await audit("models-bedrock-custom");
    await page.locator(".provider-model-summary").first().click();
    await audit("models-bedrock-card");
    await pick("Anthropic");
    await audit("models-anthropic");
    await step("oauth-dialog", async () => {
      await page.getByRole("button", { name: /登录/ }).first().click();
      await page.locator(".provider-oauth-prompt").first().waitFor({ timeout: 8_000 });
      await audit("oauth-dialog");
      await closeDialog();
    });
    await pick("OpenAI Response");
    await audit("models-ws");
    await page.locator(".provider-catalog-search input").fill("open");
    await audit("models-search");
    await page.locator(".provider-catalog-search input").fill("");
    await pick("Azure OpenAI");
    await audit("models-azure");
  });

  await step("settings-mcp", async () => {
    await openSettings("MCP");
    await audit("mcp");
    await page.locator(".mcp-add-button").click();
    await audit("mcp-add");
    await page.locator(".mcp-snippet-toggle").click();
    await audit("mcp-snippet");
    const json = page.getByRole("button", { name: /打开 JSON 配置/ });
    if (await json.count()) { await json.click(); await page.waitForTimeout(500); await audit("mcp-json"); await escape(); }
  });

  await step("settings-remote", async () => {
    await openSettings("远程控制");
    await audit("remote");
  });
  await step("settings-appearance", async () => {
    await openSettings("外观");
    await audit("appearance");
  });
  await step("settings-skills", async () => {
    await openSettings("技能");
    await audit("skills");
  });

  await step("onboarding", async () => {
    mkdirSync(join(root, "home", ".cursor"), { recursive: true });
    writeFileSync(join(root, "home", ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { demo: { command: "npx", args: ["-y", "demo-server"] }, other: { url: "https://example.com/mcp" } } }));
    await page.getByRole("button", { name: "重新查看引导" }).click();
    await page.waitForTimeout(700);
    const next = page.getByRole("button", { name: /^(继续|开始使用)$/ });
    for (let index = 1; index <= 8; index += 1) {
      await audit(`onboarding-${index}`);
      const scan = page.getByRole("button", { name: "扫描系统 MCP" });
      if (await scan.count()) {
        await scan.click();
        await page.locator("[role=dialog] input[type=checkbox]").first().waitFor({ timeout: 8_000 }).catch(() => undefined);
        await audit("mcp-discovery");
        await closeDialog();
      }
      const last = (await next.innerText()) === "开始使用";
      if (last) break;
      if (await next.isDisabled()) {
        // The private build cannot leave the model step without a key: point Spark AI at the mock gateway and save one.
        const { baseUrl } = JSON.parse(readFileSync(join(root, "data", "agent", "models.json"), "utf8")).providers.mock;
        await page.evaluate((url) => window.localStorage.setItem("coilcoil.sparkBaseUrl", url), baseUrl);
        await page.getByLabel("API Key").fill("sk-audit");
        await page.getByRole("button", { name: "保存", exact: true }).click();
        await page.getByRole("button", { name: "已配置" }).waitFor({ timeout: 30_000 });
        await audit("onboarding-key-saved");
      }
      await next.click();
    }
  });

  // Last, because it leaves the sidebar in a half-edited state.
  await step("leave-onboarding", async () => {
    const done = page.getByRole("button", { name: "开始使用" });
    if (await done.count()) await done.click();
    await page.waitForTimeout(500);
  });
  // The private build's Spark AI page, once a key is saved: standard provider page with its own catalog.
  await step("spark", async () => {
    await openSettings("模型与服务商");
    const spark = page.locator(".provider-catalog").getByRole("button", { name: /Spark AI/ });
    if (!(await spark.count())) { await backToWorkspace(); return; }
    await spark.first().click();
    await page.waitForTimeout(800);
    await audit("spark-page");
    await page.getByRole("button", { name: "自定义目录" }).click();
    await audit("spark-custom");
    await page.locator(".provider-model-summary").first().click();
    await audit("spark-card");
    await backToWorkspace();
  });

  await step("rename", async () => {
    await page.locator("[class*=sidebar]").getByText("审计", { exact: false }).first().click({ button: "right" });
    await page.getByText("重命名", { exact: true }).click();
    await page.locator(".conversation-rename-input").first().waitFor({ timeout: 5_000 });
    await audit("rename");
    await page.locator(".conversation-rename-input").first().press("Escape");
  });

  if (OUT) {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(result));
  }
  const screens = Object.keys(result.screens);
  const skipped = Object.entries(result.skipped).filter(([name]) => !optional.has(name));
  console.log(`form-audit: ${screens.length} screens, ${screens.reduce((sum, name) => sum + Object.keys(result.screens[name].entries).length, 0)} elements`);
  for (const [name, reason] of skipped) console.log(`  SKIPPED ${name}: ${reason}`);
  check("每屏都读到了", skipped.length === 0, skipped.map(([name, reason]) => `${name}: ${reason}`).join(" | "));
  if (!OUT) check("所有输入框/多行框都来自公共控件（带 data-ui）", missing.length === 0, missing.slice(0, 8).join(" | "));
}
