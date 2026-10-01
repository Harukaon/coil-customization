// A customer whose network cannot reach the gateway: saving the key must fail as a whole,
// say why, and leave no half-made provider behind (no key, no made-up "GPT-5" model).
export const description = "定制版：取不到云端模型列表时，密钥不保存、不留占位模型，错误里写明每次尝试的原因";

export const launchOptions = { onboarding: true };

export async function run({ page, check }) {
  await page.evaluate(() => window.localStorage.setItem("coilcoil.sparkBaseUrl", "http://127.0.0.1:9/v1"));
  await page.getByRole("button", { name: /^(继续|开始使用)$/ }).click();
  await page.getByLabel("API Key").fill("sk-e2e-test-key");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  const toast = page.getByText(/获取模型列表失败/).first();
  await toast.waitFor({ timeout: 30_000 });
  const text = await toast.innerText();
  check("提示「没有保存」，并写出每次尝试的原因（有/无 /v1 两个地址都在）", text.includes("没有保存") && text.includes("/v1/models") && text.includes("/models"), text.slice(0, 200));
  const config = await page.evaluate(() => window.coilcoil.request({ type: "get_configuration" }));
  check("没有留下 Spark 服务商和占位的 GPT-5", !config.models.some((model) => model.provider === "sparkai"));
  check("「继续」仍然点不了", await page.getByRole("button", { name: /^(继续|开始使用)$/ }).isDisabled());
}
