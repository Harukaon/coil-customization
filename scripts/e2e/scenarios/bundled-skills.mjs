// The private build ships eleven Anthropic skills. The runtime must load all of them as
// built-in, and their folders must be real files on disk. (The settings list hides
// built-in skills by design, see skillPolicy.ts, so this reads the runtime directly.)
import { existsSync } from "node:fs";
export const description = "定制版内置技能：运行时加载了 11 个，都是内置且在真实磁盘上";

const EXPECTED = ["docx", "pptx", "xlsx", "pdf", "frontend-design", "canvas-design", "algorithmic-art", "theme-factory", "web-artifacts-builder", "mcp-builder", "internal-comms"];

export async function run({ page, check }) {
  const snapshot = await page.evaluate(() => window.coilcoil.request({ type: "get_skill_configuration" }));
  const bundled = snapshot.skills.filter((skill) => skill.source === "bundled");
  const names = bundled.map((skill) => skill.name).sort();
  for (const name of EXPECTED) check(`内置技能 ${name} 已加载`, names.includes(name), names.join(","));
  check("恰好这 11 个内置", names.length === EXPECTED.length, String(names.length));
  check("都是启用状态", bundled.every((skill) => skill.enabled));
  check("每个技能目录在真实磁盘上（脚本能被外部程序读到）", bundled.every((skill) => existsSync(skill.filePath)), bundled.find((skill) => !existsSync(skill.filePath))?.filePath);
  check("加载过程没有报告问题", snapshot.diagnostics.length === 0, JSON.stringify(snapshot.diagnostics).slice(0, 200));
}
