import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Pi package lists only loadable extension factories", async () => {
  const packageUrl = new URL("../package.json", import.meta.url);
  const manifest = JSON.parse(await readFile(packageUrl, "utf8")) as {
    pi?: { extensions?: string[] };
  };
  const extensions = manifest.pi?.extensions ?? [];

  assert.ok(extensions.length > 0);

  for (const path of extensions) {
    const module = await import(new URL(`../${path}`, import.meta.url).href);
    assert.equal(typeof module.default, "function", `${path} 缺少默认扩展工厂`);
  }
});
