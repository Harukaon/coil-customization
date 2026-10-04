import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManagedTerminal } from "./types.ts";
import { isRunning } from "./output.ts";
import { signalName } from "./process-cleanup.ts";

export function serializeSession(session: ManagedTerminal): Record<string, unknown> {
  const normalizedSignal = signalName(session.signal);
  const running = isRunning(session);
  return {
    id: session.id,
    background_shell_id: session.id,
    name: session.name,
    pid: session.pid,
    status: session.status,
    background: session.background,
    is_running_in_background: running && session.background,
    running_for_ms: (session.endedAt ?? Date.now()) - session.startedAt,
    cwd: session.cwd,
    command: session.command,
    startedAt: new Date(session.startedAt).toISOString(),
    endedAt: session.endedAt ? new Date(session.endedAt).toISOString() : undefined,
    exitCode: normalizedSignal ? null : session.exitCode,
    signal: normalizedSignal,
    rawSignal: session.signal || undefined,
    cleanup: session.cleanup,
    outputMode: session.outputMode,
    output_location: session.outputPath,
    cursor: session.outputEnd,
  };
}

/** Terminal output kept on disk for runs that ended this long ago is deleted on startup. */
export const TERMINAL_OUTPUT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

function terminalOutputRoot(): string {
  const root = process.env.PI_CODING_AGENT_DIR?.trim()
    || join(tmpdir(), "coilcoil", String(process.pid));
  return join(root, "terminal-output");
}

/**
 * A directory name that no other terminal extension instance can produce.
 *
 * Terminal ids restart at `term-1` for every agent session, and the agent
 * directory is shared by every project and window, so writing `term-1.log`
 * straight into it made unrelated sessions append into one another's files:
 * one project's shell output showed up in another project's terminal log.
 * Each extension instance therefore gets its own subdirectory.
 */
export function createTerminalRunToken(): string {
  return `${Date.now().toString(36)}-${process.pid.toString(36)}-${randomBytes(4).toString("hex")}`;
}

export function outputPathFor(runToken: string, id: string): string {
  const directory = join(terminalOutputRoot(), runToken);
  mkdirSync(directory, { recursive: true });
  return join(directory, `${id}.log`);
}

/**
 * Drop terminal output left behind by earlier runs.
 *
 * Nothing else removes these files, so without this the agent directory grows
 * without bound. Legacy flat `term-*.log` files from before runs were isolated
 * are removed too, since they are the ones that hold mixed-project output.
 */
export function pruneTerminalOutput(now = Date.now(), retentionMs = TERMINAL_OUTPUT_RETENTION_MS): string[] {
  const root = terminalOutputRoot();
  const removed: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return removed;
  }
  for (const entry of entries) {
    const path = join(root, entry);
    try {
      const stats = statSync(path);
      const legacyLog = stats.isFile() && /^term-\d+\.log$/.test(entry);
      if (!legacyLog && now - stats.mtimeMs < retentionMs) continue;
      rmSync(path, { recursive: true, force: true });
      removed.push(path);
    } catch {
      // A concurrent run may be writing or removing the same entry.
    }
  }
  return removed;
}

export function toolResult(details: unknown): {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
} {
  return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
}
