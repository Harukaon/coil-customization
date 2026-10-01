// Spark AI in Settings is a page like the other built-in providers: key, then a model
// catalog with "保留内置" (follow the gateway's list) and "自定义目录" (the usual model
// cards: remove a model, change its context window, add one). What the user kept is
// exactly what the model picker lists. Runs on the mock gateway.
export const description = "定制版设置页：Spark AI 和其他内置服务商同一套页面——保留内置 / 自定义目录（移除模型、改上下文），选择器跟着变";

export const launchOptions = {
  onboarding: true,
  sparkModels: [{ id: "spark-a", name: "Spark A" }, { id: "spark-b", name: "Spark B" }, { id: "spark-c", name: "Spark C" }],
};

export async function run({ page, ui, check, shot }) {
  const next = page.getByRole("button", { name: /^(继续|开始使用)$/ });
  await next.click();
  await page.getByLabel("API Key").fill("sk-e2e-test-key");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByRole("button", { name: "已配置" }).waitFor({ timeout: 30_000 });
  for (let step = 0; step < 8; step += 1) {
    const last = (await next.innerText()) === "开始使用";
    await next.click();
    if (last) break;
  }

  const sparkModels = async () => {
    const config = await page.evaluate(() => window.coilcoil.request({ type: "get_configuration" }));
    return config.models.filter((model) => model.provider === "sparkai").map((model) => ({ id: model.id, contextWindow: model.contextWindow }));
  };
  const ids = async () => (await sparkModels()).map((model) => model.id).sort().join(",");
  const mode = () => page.locator(".provider-model-mode button.active").innerText();
  const openSettings = async () => {
    await page.getByRole("button", { name: "设置" }).click();
    await page.getByText("模型目录", { exact: true }).waitFor({ timeout: 30_000 });
    // The catalog mode is worked out from the gateway a moment after the page opens.
    await ui.waitFor(async () => (await page.locator(".provider-model-mode").count()) === 1, 15_000);
  };
  check("首次引导后目录是云端的三个模型，默认上下文均为 200K", (await ids()) === "spark-a,spark-b,spark-c" && (await sparkModels()).every((model) => model.contextWindow === 200000), JSON.stringify(await sparkModels()));

  await openSettings();
  check("Spark AI 页面有「启用此服务商」「清除配置」和 API key 一栏，和其他内置服务商一样", (await page.getByText("启用此服务商").count()) === 1 && (await page.getByRole("button", { name: "清除配置" }).count()) === 1 && (await page.getByText(/^API key/).count()) >= 1);
  check("默认是「保留内置」，摘要里写着 3 个模型", (await mode()) === "保留内置" && (await page.locator(".provider-builtins-summary").innerText()).includes("3 个模型"), await mode());
  await shot("builtin");

  await page.getByRole("button", { name: "自定义目录" }).click();
  check("自定义目录里是完整的模型卡列表（3 张）和搜索框", (await page.locator(".provider-model-card").count()) === 3 && (await page.getByLabel("搜索模型").count()) === 1);
  await page.locator(".provider-model-card", { hasText: "Spark B" }).getByRole("button", { name: /移除模型/ }).click();
  await page.locator(".provider-model-card", { hasText: "Spark A" }).getByRole("button", { expanded: false }).first().click();
  await page.locator(".provider-model-card", { hasText: "Spark A" }).getByText("上下文窗口").locator("input").fill("64000");
  await shot("custom");
  await page.getByRole("button", { name: "保存设置" }).click();
  await page.getByText("已保存设置。", { exact: true }).waitFor({ timeout: 30_000 });
  const custom = await sparkModels();
  check("自定义目录：移除的模型不再出现在选择器里", !custom.some((model) => model.id === "spark-b"), await ids());
  check("自定义目录：保留的两个还在", custom.length === 2, await ids());
  check("自定义目录：改过的上下文长度生效", custom.find((model) => model.id === "spark-a")?.contextWindow === 64000, JSON.stringify(custom));

  // Leaving and coming back must recognise the catalog as custom and keep the choices.
  await page.getByRole("button", { name: "返回工作区" }).click();
  await openSettings();
  check("重新打开设置，仍是「自定义目录」，移除的模型没回来", (await mode()) === "自定义目录" && (await page.locator(".provider-model-card").count()) === 2, `${await mode()} / ${await page.locator(".provider-model-card").count()}`);

  await page.getByRole("button", { name: "保留内置" }).click();
  await page.getByRole("button", { name: "保存设置" }).click();
  await page.getByText("已保存设置。", { exact: true }).waitFor({ timeout: 30_000 });
  const allBack = await ui.waitFor(async () => (await ids()) === "spark-a,spark-b,spark-c", 15_000);
  check("选回「保留内置」后云端三个模型全部回来", allBack, await ids());
  const restored = await sparkModels();
  check("选回「保留内置」后上下文恢复默认 200K", restored.every((model) => model.contextWindow === 200000), JSON.stringify(restored));
}
