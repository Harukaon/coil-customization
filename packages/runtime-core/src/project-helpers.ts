import {
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  OPENAI_RESPONSES_WS_PROVIDER_ID,
} from "@coilcoil/openai-responses-ws/config";
import {
  type ChangeStatus,
  type ChangedFile,
  type FileNode,
} from "@coilcoil/runtime-protocol";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  readFile,
  readdir,
  stat,
} from "node:fs/promises";
import {
  dirname,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { resolvePackageDirectory } from "./package-resolution.js";
import {
  IGNORED_DIRECTORIES,
  MAX_CHANGE_FILES,
  MAX_PATCH_CHARS,
  execFileAsync,
  require
} from "./runtime-constants.js";
import {
  RuntimeResources,
  WorkflowManifest
} from "./runtime-state.js";
import {
  clampText,
  ensureInside,
  isRecord,
  safeRealPath
} from "./runtime-utils.js";

export { resolvePackageDirectory } from "./package-resolution.js";

export function statusFromPorcelain(code: string): ChangeStatus {
  if (code === "??") return "untracked";
  if (code.includes("U") || code === "AA" || code === "DD") return "conflicted";
  if (code.includes("R")) return "renamed";
  if (code.includes("D")) return "deleted";
  if (code.includes("A")) return "added";
  return "modified";
}

export async function directoryNodes(cwd: string, requestedPath = ""): Promise<FileNode[]> {
  const directory = requestedPath ? ensureInside(cwd, requestedPath) : safeRealPath(cwd);
  const directoryStat = await stat(directory);
  if (!directoryStat.isDirectory()) throw new Error("所选路径不是文件夹。");
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  });
  return entries.flatMap((entry): FileNode[] => {
    if ((entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) || entry.name === ".DS_Store") return [];
    const absolute = join(directory, entry.name);
    const path = relative(cwd, absolute) || entry.name;
    if (entry.isDirectory()) return [{ name: entry.name, path, kind: "directory" }];
    if (entry.isFile() || entry.isSymbolicLink()) return [{ name: entry.name, path, kind: "file" }];
    return [];
  });
}

/** 项目摘要用：读不到时带上原因，界面不会把它显示成「没有改动」。 */
export async function readGitChanges(cwd: string): Promise<{ changes: ChangedFile[]; changesError?: string }> {
  try {
    return { changes: await gitChanges(cwd) };
  } catch (error) {
    return { changes: [], changesError: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 项目摘要里的改动列表（最多 MAX_CHANGE_FILES 条）。
 *
 * 未跟踪的文件按文件夹聚合（git 默认的 normal）：一个上层文件夹里放着很多小项目时，
 * 逐个列出未跟踪文件会有几万条、几 MB，既读不完也用不上。读失败要抛出去，让调用方
 * 区分「读不到」和「没有改动」，不能返回空列表假装工作区是干净的。不是 git 仓库照旧
 * 当作没有改动。
 */
export async function gitChanges(cwd: string): Promise<ChangedFile[]> {
  let statusOutput = "";
  try {
    const result = await execFileAsync("git", ["-C", cwd, "status", "--porcelain=v1", "--untracked-files=normal"], {
      maxBuffer: 32 * 1024 * 1024,
    });
    statusOutput = result.stdout;
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "");
    if (/not a git repository/i.test(stderr)) return [];
    throw new Error(`读取 git 改动失败：${(stderr || (error as Error).message).trim().split("\n").slice(-3).join(" ")}`);
  }

  const records = statusOutput
    .split("\n")
    .filter(Boolean)
    .slice(0, MAX_CHANGE_FILES)
    .map((line) => {
      const code = line.slice(0, 2);
      const rawPath = line.slice(3).trim();
      const path = rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1) || rawPath : rawPath;
      return { code, path: path.replace(/^"|"$/g, "") };
    });

  const numstat = new Map<string, { additions: number; deletions: number; }>();
  try {
    const result = await execFileAsync("git", ["-C", cwd, "diff", "--numstat", "HEAD", "--", "."], {
      maxBuffer: 32 * 1024 * 1024,
    });
    for (const line of result.stdout.split("\n")) {
      const [added, deleted, ...pathParts] = line.split("\t");
      const path = pathParts.join("\t");
      if (!path) continue;
      numstat.set(path, {
        additions: added === "-" ? 0 : Number.parseInt(added || "0", 10) || 0,
        deletions: deleted === "-" ? 0 : Number.parseInt(deleted || "0", 10) || 0,
      });
    }
  } catch {
    // A repository without HEAD can still expose status and untracked files.
  }

  return Promise.all(
    records.map(async ({ code, path }) => {
      const stats = numstat.get(path) ?? { additions: 0, deletions: 0 };
      const status = statusFromPorcelain(code);
      let patch: string | undefined;
      if (status === "untracked") {
        try {
          const target = ensureInside(cwd, path);
          const fileStat = await stat(target);
          if (fileStat.isFile() && fileStat.size <= 256 * 1024) {
            const source = await readFile(target, "utf8");
            const lines = source.split("\n");
            stats.additions = lines.length;
            patch = clampText(
              [`diff --git a/${path} b/${path}`, "new file", "--- /dev/null", `+++ b/${path}`, ...lines.map((line) => `+${line}`)].join("\n"),
              MAX_PATCH_CHARS,
            );
          }
        } catch {
          // Binary, unreadable, or concurrently removed files remain listed without a patch.
        }
      } else {
        try {
          const result = await execFileAsync("git", ["-C", cwd, "diff", "--no-ext-diff", "--unified=3", "HEAD", "--", path], {
            maxBuffer: 2 * 1024 * 1024,
          });
          patch = clampText(result.stdout, MAX_PATCH_CHARS) || undefined;
        } catch {
          patch = undefined;
        }
      }
      return { path, status, ...stats, patch } satisfies ChangedFile;
    }),
  );
}

export function resolveWorkflowDirectory(explicit?: string): string {
  if (explicit) return resolve(explicit);
  const manifestPath = require.resolve("@coilcoil/workflow/package.json");
  return dirname(manifestPath);
}

/**
 * 任务面板那条后台运行专用的扩展。
 *
 * 它故意不在 workflow 的 pi.extensions 清单里——普通对话不该看到 issue_reply /
 * issue_ask 这两个工具——所以路径在这里单独给出来，由起那条运行的人挂上去。
 */
export function issueAgentExtensionPath(workflowDirectory?: string): string {
  return join(resolveWorkflowDirectory(workflowDirectory), "extensions", "issue-agent.ts");
}

/**
 * Skills ship scripts that other programs (python, node, a shell) have to open, and
 * those cannot see inside app.asar. The desktop build unpacks the skills folder
 * next to the archive (asarUnpack); point at that copy when it exists.
 */
export function realFilesystemPath(path: string): string {
  const marker = `app.asar${sep}`;
  const at = path.indexOf(marker);
  if (at < 0) return path;
  const unpacked = `${path.slice(0, at)}app.asar.unpacked${sep}${path.slice(at + marker.length)}`;
  return existsSync(unpacked) ? unpacked : path;
}

export function resourcesFromManifest(directory: string): RuntimeResources {
  const manifestPath = join(directory, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as WorkflowManifest;
  return {
    extensions: (manifest.pi?.extensions ?? []).map((path) => resolve(directory, path)),
    skills: (manifest.pi?.skills ?? []).map((path) => realFilesystemPath(resolve(directory, path))),
    prompts: (manifest.pi?.prompts ?? []).map((path) => resolve(directory, path)),
  };
}

export function bundledRuntimeResources(workflowDirectory: string): RuntimeResources {
  const packageDirectories = [
    workflowDirectory,
    resolvePackageDirectory("@coilcoil/openai-responses-ws"),
  ];
  const resources = packageDirectories.map(resourcesFromManifest);
  return {
    extensions: resources.flatMap((entry) => entry.extensions),
    skills: resources.flatMap((entry) => entry.skills),
    prompts: resources.flatMap((entry) => entry.prompts),
  };
}

export function seedLegacyConfiguration(agentDir: string, legacyAgentDir: string): boolean {
  mkdirSync(agentDir, { recursive: true });
  let migrated = false;
  const authPath = join(agentDir, "auth.json");
  const legacyAuthPath = join(legacyAgentDir, "auth.json");
  if (!existsSync(authPath) && existsSync(legacyAuthPath)) {
    copyFileSync(legacyAuthPath, authPath);
    try {
      const mode = statSync(legacyAuthPath).mode & 0o777;
      chmodSync(authPath, mode || 0o600);
    } catch {
      // The copied credential remains usable even when permissions cannot be mirrored.
    }
    migrated = true;
  }

  const modelsPath = join(agentDir, "models.json");
  const legacyModelsPath = join(legacyAgentDir, "models.json");
  if (!existsSync(modelsPath) && existsSync(legacyModelsPath)) {
    copyFileSync(legacyModelsPath, modelsPath);
  }

  const settingsPath = join(agentDir, "settings.json");
  const legacySettingsPath = join(legacyAgentDir, "settings.json");
  if (!existsSync(settingsPath) && existsSync(legacySettingsPath)) {
    try {
      const legacy = JSON.parse(readFileSync(legacySettingsPath, "utf8")) as Record<string, unknown>;
      const selected = Object.fromEntries(
        ["defaultProvider", "defaultModel", "defaultThinkingLevel", "transport"].flatMap((key) =>
          legacy[key] === undefined ? [] : [[key, legacy[key]]],
        ),
      );
      writeFileSync(settingsPath, `${JSON.stringify(selected, null, 2)}\n`, { mode: 0o600 });
    } catch {
      // Invalid legacy settings are intentionally ignored instead of copied wholesale.
    }
  }
  return migrated;
}

export function migrateLegacyResponsesWsIdentity(agentDir: string): void {
  const settings = SettingsManager.create(process.cwd(), agentDir);
  if (settings.getDefaultProvider() === "cliproxyapi" && settings.getDefaultModel()) {
    settings.setDefaultModelAndProvider(OPENAI_RESPONSES_WS_PROVIDER_ID, settings.getDefaultModel()!);
  }

  const runtimeOptionsPath = join(agentDir, "model-runtime-options.json");
  if (!existsSync(runtimeOptionsPath)) return;
  try {
    const value = JSON.parse(readFileSync(runtimeOptionsPath, "utf8")) as Record<string, unknown>;
    if (!isRecord(value) || !isRecord(value.cliproxyapi) || value[OPENAI_RESPONSES_WS_PROVIDER_ID] !== undefined) return;
    value[OPENAI_RESPONSES_WS_PROVIDER_ID] = value.cliproxyapi;
    delete value.cliproxyapi;
    const temporaryPath = `${runtimeOptionsPath}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, runtimeOptionsPath);
  } catch {
    // A malformed optional override file must not block the runtime from starting.
  }
}
