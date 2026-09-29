// Private-deployment first launch: key-only model step (cannot be skipped), the
// gateway's model list becoming the catalog, the Agent step prefilled in order,
// and a real chat on the default model. The gateway is the mock one, so no key or
// network is needed.
export const description = "定制版首次启动：填 Key → 拉模型列表 → Agent 步骤按顺序预填 → 用默认模型对话";

export const launchOptions = {
  onboarding: true,
  sparkModels: [{ id: "spark-a", name: "Spark A" }, { id: "spark-b", name: "Spark B" }, { id: "spark-c", name: "Spark C" }],
};

export async function run({ page, ui, check, shot }) {
  const next = page.getByRole("button", { name: /^(继续|开始使用)$/ });
  const skip = page.getByRole("button", { name: "跳过这一步" });

  await next.click(); // intro -> model
  await page.getByRole("heading", { name: "配一个模型" }).waitFor();
  check("模型这一步没有「跳过这一步」", (await skip.count()) === 0);
  check("没填 Key 之前「继续」点不了", await next.isDisabled());

  await page.getByLabel("API Key").fill("sk-e2e-test-key");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByRole("button", { name: "已配置" }).waitFor({ timeout: 30_000 });
  check("保存 Key 之后「继续」可以点了", await next.isEnabled());

  await next.click(); // model -> agents
  await page.getByRole("heading", { name: "把 Agent 配完整" }).waitFor();
  const slot = (name) => page.getByRole("button", { name: `${name} 模型` });
  await slot("Explore").getByText("Spark A").waitFor({ timeout: 15_000 });
  check("Explore 预填了第 1 个模型", (await slot("Explore").innerText()).includes("Spark A"));
  check("Worker 预填了第 2 个模型", (await slot("Worker").innerText()).includes("Spark B"));
  check("Reviewer 预填了第 3 个模型", (await slot("Reviewer").innerText()).includes("Spark C"));
  check("会话命名用第 4 个（模型不够时从头循环）", (await page.getByRole("button", { name: "会话命名模型" }).innerText()).includes("Spark A"));
  await shot("agent-step");

  // Already-chosen slots are kept: change Worker, go back and forward, it must stay.
  await slot("Worker").click();
  await page.getByRole("option", { name: /Spark C/ }).first().click();
  await page.getByRole("button", { name: /保存配置/ }).click();
  await page.getByRole("button", { name: /已保存/ }).waitFor({ timeout: 10_000 });
  await page.getByRole("button", { name: "上一步" }).click();
  await page.getByRole("heading", { name: "配一个模型" }).waitFor();
  await next.click();
  await slot("Worker").getByText("Spark C").waitFor({ timeout: 15_000 });
  check("手动改过的 Worker 回来后没被覆盖", (await slot("Worker").innerText()).includes("Spark C"));
  check("其余空位不受影响，Explore 仍是第 1 个", (await slot("Explore").innerText()).includes("Spark A"));

  for (const heading of ["决定记忆怎么工作", "接入 MCP 和 Skill", "系统权限", "挂一个工作区"]) {
    await next.click();
    await page.getByRole("heading", { name: heading }).waitFor();
  }
  await next.click(); // 开始使用

  await page.locator(".agent-mode", { hasText: "Spark A" }).first().waitFor({ timeout: 30_000 });
  check("进主界面后默认模型是第 1 个", true);
  await ui.newConversation("projA");
  await ui.send([{ tool: "read", args: { path: "README.md" } }, { echo: true }], "首聊");
  const echo = await ui.lastEcho();
  check("默认模型能完成一轮真实对话", echo.includes("projA"), echo.slice(0, 120));
  await shot("chat");
}
