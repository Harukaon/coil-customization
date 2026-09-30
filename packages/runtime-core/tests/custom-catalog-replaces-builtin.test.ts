import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CoilCoilRuntime } from "../src/index.js";

type Credential = "api_key" | "oauth";

async function withRuntime<T>(credential: Credential, body: (runtime: CoilCoilRuntime) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "coilcoil-catalog-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "auth.json"), JSON.stringify({
    anthropic: credential === "oauth"
      ? { type: "oauth", access: "sk-ant-oat-fake", refresh: "r", expires: Date.now() + 3_600_000 }
      : { type: "api_key", key: "sk-ant-api-fake" },
  }));
  const runtime = new CoilCoilRuntime({ agentDir, sessionDir: join(root, "sessions") });
  try {
    return await body(runtime);
  } finally {
    await runtime.dispose();
    rmSync(root, { recursive: true, force: true });
  }
}

const anthropicIds = async (runtime: CoilCoilRuntime): Promise<string[]> =>
  (await runtime.getConfiguration()).models.filter((model) => model.provider === "anthropic").map((model) => model.id);

for (const credential of ["api_key", "oauth"] as const) {
  const label = credential === "oauth" ? "订阅登录" : "API 密钥";

  test(`${label}：自定义模型目录替换内置目录，选择器里只剩保留的模型`, async () => {
    await withRuntime(credential, async (runtime) => {
      assert.ok((await anthropicIds(runtime)).length > 3, "没自定义前应该有一整套内置模型");
      await runtime.saveModelProviderConfiguration({
        provider: { id: "anthropic", disabled: false, replaceModels: true, models: [{ id: "claude-only-this", name: "Only This" }] },
        preserveApiKeyReference: true,
      } as never);
      assert.deepEqual(await anthropicIds(runtime), ["claude-only-this"]);
    });
  });

  test(`${label}：选回「保留内置」后内置模型全部回来`, async () => {
    await withRuntime(credential, async (runtime) => {
      const before = await anthropicIds(runtime);
      await runtime.saveModelProviderConfiguration({
        provider: { id: "anthropic", disabled: false, replaceModels: true, models: [{ id: "claude-only-this" }] },
        preserveApiKeyReference: true,
      } as never);
      await runtime.saveModelProviderConfiguration({
        provider: { id: "anthropic", disabled: false, replaceModels: false, models: [] },
        preserveApiKeyReference: true,
      } as never);
      assert.deepEqual(await anthropicIds(runtime), before);
    });
  });
}
