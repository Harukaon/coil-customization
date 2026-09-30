// Spark AI in Settings: like the other built-in providers it offers "保留内置" (follow the
// gateway's list) and "自定义目录" (hide models, change a context window), and what the
// user kept is exactly what the model picker lists. Runs on the mock gateway.
export const description = "定制版设置页：Spark AI 的模型目录——保留内置 / 自定义目录（隐藏模型、改上下文），选择器跟着变";

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
  check("首次引导后目录是云端的三个模型", (await ids()) === "spark-a,spark-b,spark-c", await ids());

  await page.getByRole("button", { name: "设置" }).click();
  await page.getByText("模型目录", { exact: true }).waitFor({ timeout: 30_000 });
  check("默认是「保留内置」，摘要里列着云端模型", (await page.locator(".provider-builtins-summary").innerText()).includes("Spark B"));
  await shot("builtin");

  await page.getByRole("button", { name: "自定义目录" }).click();
  await page.getByLabel("显示 Spark B").uncheck();
  await page.getByLabel("Spark A 上下文长度").fill("64000");
  await shot("custom");
  await page.getByRole("button", { name: "保存设置" }).click();
  await page.getByText("已保存。", { exact: true }).waitFor({ timeout: 30_000 });
  const custom = await sparkModels();
  check("自定义目录：取消勾选的模型不再出现在选择器里", !custom.some((model) => model.id === "spark-b"), await ids());
  check("自定义目录：保留的两个还在", custom.length === 2, await ids());
  check("自定义目录：改过的上下文长度生效", custom.find((model) => model.id === "spark-a")?.contextWindow === 64000, JSON.stringify(custom));

  // Leaving and coming back must recognise the catalog as custom and keep the choices.
  await page.getByRole("button", { name: "返回工作区" }).click();
  await page.getByRole("button", { name: "设置" }).click();
  await page.getByText("模型目录", { exact: true }).waitFor({ timeout: 30_000 });
  await page.getByLabel("显示 Spark B").waitFor({ timeout: 15_000 });
  check("重新打开设置，自定义的勾选还在", !(await page.getByLabel("显示 Spark B").isChecked()) && (await page.getByLabel("显示 Spark A").isChecked()));

  await page.getByRole("button", { name: "保留内置" }).click();
  await page.getByRole("button", { name: "保存设置" }).click();
  await page.getByText(/已保存，并获取到最新的模型列表/).waitFor({ timeout: 30_000 });
  const allBack = await ui.waitFor(async () => (await ids()) === "spark-a,spark-b,spark-c", 15_000);
  check("选回「保留内置」后云端三个模型全部回来", allBack, await ids());
}
