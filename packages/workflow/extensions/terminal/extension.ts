import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createWriteStream, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  bashParameters,
  COMPLETED_SESSION_TTL_MS,
  DEFAULT_BLOCK_UNTIL_MS,
  DEFAULT_READ_LIMIT,
  DEFAULT_STALLED_MS,
  DEFAULT_STOP_TIMEOUT_MS,
  KEY_SEQUENCES,
  MAX_COMPLETED_SESSIONS,
  terminalParameters,
  type BashParameters,
  type ManagedTerminal,
  type TerminalNotification,
  type TerminalParameters,
  type WaitOutcome,
} from "./types.ts";
import { createNoticeDispatcher } from "./notify.ts";
import {
  appendOutput,
  armNotification,
  clearNotificationTimers,
  createScreenState,
  flushTerminalOutput,
  isRunning,
  loadPty,
  notifyListeners,
  outputSince,
  scheduleStalledNotifications,
  snapshotOutput,
} from "./output.ts";
import { scanTerminalProcesses, stopTerminal } from "./process-cleanup.ts";
import { terminalShell } from "./shell.ts";
import {
  createTerminalRunToken,
  outputPathFor,
  pruneTerminalOutput,
  serializeSession,
  toolResult,
} from "./results.ts";
import { waitForTerminal, waitForTerminalExit } from "./wait.ts";

interface StartRequest {
  ownerToolCallId: string;
  command: string;
  cwd?: string;
  name?: string;
  outputMode: "screen" | "log";
  initialBackground: boolean;
  waitFor?: string;
  waitTimeoutMs: number;
  waitForExitOnly: boolean;
  hardTimeoutMs?: number;
  notifyOn?: "exit" | "match" | "stalled";
  notifyOutputRegex?: string;
  stalledMs?: number;
  limit?: number;
  cols?: number;
  rows?: number;
  autoNotifyExit: boolean;
  onUpdate?: (result: {
    content: Array<{ type: "text"; text: string }>;
    details: unknown;
  }) => void;
}

interface StartResult {
  session: ManagedTerminal;
  wait: WaitOutcome;
  poppedOutIntoBackground: boolean;
  output: string;
  cursor: number;
  hasMore: boolean;
}

const TERMINAL_RUN_ENTRY_TYPE = "coilcoil-terminal-run";

function notificationReason(session: ManagedTerminal, event: { mode: string; pattern?: string }): string {
  if (event.mode === "exit") {
    if (session.timeoutRequested) return `进程达到硬超时并已停止（${session.status}）`;
    return `进程已退出（${session.status}）`;
  }
  if (event.mode === "match") return `匹配到：${event.pattern}`;
  if (event.mode === "regex") return `输出匹配正则：${event.pattern}`;
  const stalled = session.notifications.find((item) => item.mode === "stalled")?.stalledMs ?? DEFAULT_STALLED_MS;
  return `超过 ${stalled}ms 无新输出`;
}

export default function terminalExtension(pi: ExtensionAPI): void {
  const sessions = new Map<string, ManagedTerminal>();
  // Terminal ids restart at term-1 in every extension instance, so the run token
  // is what keeps this session's output files apart from every other project's.
  const runToken = createTerminalRunToken();
  pruneTerminalOutput();
  let nextId = 1;
  // Terminal events reach the Agent through one coalescing dispatcher: every
  // delivery costs an LLM turn, so a burst of exits must not become a burst of
  // turns, and an event a tool call already reported must not become a turn at
  // all.
  const notices = createNoticeDispatcher({
    send: (payload, delivery) => {
      try {
        pi.sendMessage({
          customType: "terminal-notification",
          content: payload.content,
          display: true,
          details: payload.details,
        }, { triggerTurn: true, deliverAs: delivery });
      } catch {
        // The owning Agent may shut down while a completion event is emitted.
      }
    },
  });
  pi.on("agent_start", () => {
    notices.setAgentRunning(true);
  });
  pi.on("agent_settled", () => {
    notices.setAgentRunning(false);
  });

  const publishTerminalState = (session: ManagedTerminal): void => {
    const snapshot = snapshotOutput(session, Math.max(0, session.outputEnd - DEFAULT_READ_LIMIT), DEFAULT_READ_LIMIT);
    const status = session.status === "running"
      ? "running"
      : session.status === "exited"
        ? "succeeded"
        : session.status === "stopped"
          ? "stopped"
          : "failed";
    try {
      pi.appendEntry(TERMINAL_RUN_ENTRY_TYPE, {
        id: session.id,
        ownerToolCallId: session.ownerToolCallId,
        command: session.command,
        cwd: session.cwd,
        output: snapshot.output,
        status,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        exitCode: session.signal ? undefined : session.exitCode,
      });
    } catch {
      // Persistence may already be closed during session shutdown.
    }
  };

  const findSession = (idOrName: string | undefined): ManagedTerminal => {
    if (!idOrName) throw new Error("terminal action requires id");
    const direct = sessions.get(idOrName);
    if (direct) return direct;
    const byName = [...sessions.values()].filter((session) => session.name === idOrName);
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) throw new Error(`Terminal name is ambiguous: ${idOrName}; use its id`);
    throw new Error(`Terminal not found: ${idOrName}`);
  };

  const pruneSessions = (clearExited = false): string[] => {
    const now = Date.now();
    const removed: string[] = [];
    const completed = [...sessions.values()]
      .filter((session) => !isRunning(session) && session.cleanup !== undefined)
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
    for (const [index, session] of completed.entries()) {
      const expired = session.endedAt !== undefined && now - session.endedAt >= COMPLETED_SESSION_TTL_MS;
      if (!clearExited && !expired && index < MAX_COMPLETED_SESSIONS) continue;
      clearNotificationTimers(session);
      if (session.hardTimeoutTimer) clearTimeout(session.hardTimeoutTimer);
      session.outputStream?.end();
      sessions.delete(session.id);
      removed.push(session.id);
    }
    return removed;
  };

  const startManagedSession = async (
    request: StartRequest,
    signal: AbortSignal | undefined,
    projectCwd: string,
  ): Promise<StartResult> => {
    const command = request.command.trim();
    if (!command) throw new Error("shell command is required");
    if (request.notifyOn === "match" && !request.waitFor?.trim()) throw new Error("notifyOn=match requires waitFor");
    if (!request.notifyOn && request.stalledMs !== undefined) throw new Error("stalledMs requires notifyOn=stalled");

    let outputRegex: RegExp | undefined;
    if (request.notifyOutputRegex) {
      try {
        outputRegex = new RegExp(request.notifyOutputRegex);
      } catch (error) {
        throw new Error(`notify_on_output 不是有效正则：${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const id = `term-${nextId++}`;
    const name = request.name?.trim() || `terminal-${id.slice(5)}`;
    if ([...sessions.values()].some((session) => session.name === name && isRunning(session))) {
      throw new Error(`A running terminal already uses name: ${name}`);
    }
    const cwd = resolve(projectCwd, request.cwd?.trim() || ".");
    let cwdStat;
    try {
      cwdStat = statSync(cwd);
    } catch {
      throw new Error(`Terminal cwd does not exist: ${cwd}`);
    }
    if (!cwdStat.isDirectory()) throw new Error(`Terminal cwd is not a directory: ${cwd}`);

    const pty = await loadPty();
    const { shell, args: shellArgs } = terminalShell();
    const child = pty.spawn(shell, shellArgs(command), {
      name: "xterm-256color",
      cols: request.cols ?? 120,
      rows: request.rows ?? 40,
      cwd,
      env: { ...process.env, TERM: "xterm-256color" },
    });
    const outputPath = outputPathFor(runToken, id);
    const outputStream = createWriteStream(outputPath, { flags: "w", mode: 0o600 });
    outputStream.on("error", () => undefined);
    const session: ManagedTerminal = {
      id,
      ownerToolCallId: request.ownerToolCallId,
      name,
      command,
      cwd,
      pid: child.pid,
      pty: child,
      status: "running",
      startedAt: Date.now(),
      stopRequested: false,
      background: request.initialBackground,
      outputMode: request.outputMode,
      outputPath,
      outputStream,
      buffer: "",
      bufferStart: 0,
      outputEnd: 0,
      defaultCursor: 0,
      screen: createScreenState(),
      lastOutputAt: Date.now(),
      notifications: [],
      listeners: new Set(),
    };
    let acceptingUpdates = true;
    let updateTimer: ReturnType<typeof setTimeout> | undefined;
    let lastUpdateAt = 0;
    const emitUpdate = (): void => {
      if (!acceptingUpdates || !request.onUpdate) return;
      if (updateTimer) clearTimeout(updateTimer);
      updateTimer = undefined;
      lastUpdateAt = Date.now();
      const snapshot = snapshotOutput(session, 0, request.limit ?? DEFAULT_READ_LIMIT);
      request.onUpdate({
        content: [{ type: "text", text: snapshot.output }],
        details: { ...serializeSession(session), output: snapshot.output, cursor: snapshot.cursor },
      });
    };
    const scheduleUpdate = (): void => {
      if (!acceptingUpdates || !request.onUpdate) return;
      const delay = 100 - (Date.now() - lastUpdateAt);
      if (delay <= 0) emitUpdate();
      else updateTimer ??= setTimeout(emitUpdate, delay);
    };
    session.notifyEvent = (event) => {
      notices.enqueue({
        terminalId: session.id,
        mode: event.mode,
        status: session.status,
        reason: notificationReason(session, event),
        output: outputSince(session, Math.max(0, session.outputEnd - 4_000)).slice(-4_000),
        at: Date.now(),
      });
    };
    sessions.set(id, session);
    emitUpdate();

    const initialNotifications: TerminalNotification[] = [];
    if (request.notifyOn) {
      initialNotifications.push({
        mode: request.notifyOn,
        cursor: 0,
        pattern: request.waitFor?.trim() || undefined,
        stalledMs: request.stalledMs ?? DEFAULT_STALLED_MS,
        fired: false,
      });
    }
    if (outputRegex && request.notifyOutputRegex) {
      initialNotifications.push({
        mode: "regex",
        cursor: 0,
        pattern: request.notifyOutputRegex,
        regex: outputRegex,
        fired: false,
      });
    }
    for (const notification of initialNotifications) armNotification(session, notification);
    scheduleStalledNotifications(session);

    session.dataDisposable = child.onData((data) => {
      appendOutput(session, data);
      scheduleUpdate();
    });
    session.exitDisposable = child.onExit(({ exitCode, signal: exitSignal }) => {
      flushTerminalOutput(session);
      if (session.hardTimeoutTimer) clearTimeout(session.hardTimeoutTimer);
      session.hardTimeoutTimer = undefined;
      session.exitCode = exitCode;
      session.signal = exitSignal;
      session.endedAt = Date.now();
      session.status = session.cleanup?.residualPids.length
        ? "cleanup_failed"
        : session.timeoutRequested
          ? "failed"
          : session.stopRequested
            ? "stopped"
            : exitSignal
              ? "failed"
              : exitCode === 0 ? "exited" : "failed";
      emitUpdate();
      if (session.background) publishTerminalState(session);
      notifyListeners(session);
      session.dataDisposable?.dispose();
      session.exitDisposable?.dispose();
      session.outputStream?.end();
      session.outputStream = undefined;
      if (!session.stopRequested) {
        void stopTerminal(session, false, DEFAULT_STOP_TIMEOUT_MS).finally(() => {
          if (session.background) publishTerminalState(session);
          pruneSessions();
        });
      } else pruneSessions();
    });

    try {
      await scanTerminalProcesses(session, new Set<number>());
    } catch {
      // Stop retries process enumeration and reports a failure if it stays unavailable.
    }
    if (request.hardTimeoutMs) {
      session.hardTimeoutTimer = setTimeout(() => {
        if (!isRunning(session)) return;
        session.timeoutRequested = true;
        void stopTerminal(session, false, DEFAULT_STOP_TIMEOUT_MS).finally(() => {
          publishTerminalState(session);
          notifyListeners(session);
        });
      }, request.hardTimeoutMs);
    }

    const wait = request.waitForExitOnly
      ? await waitForTerminalExit(session, request.waitTimeoutMs, signal)
      : await waitForTerminal(session, 0, request.waitFor, request.waitTimeoutMs, signal);
    if (wait === "aborted" && !request.initialBackground && isRunning(session)) {
      await stopTerminal(session, false, DEFAULT_STOP_TIMEOUT_MS);
    }
    const poppedOutIntoBackground = !request.initialBackground && wait === "timeout" && isRunning(session);
    if (isRunning(session) && (request.initialBackground || wait !== "exit")) session.background = true;
    if (session.background && request.autoNotifyExit) {
      armNotification(session, { mode: "exit", cursor: session.outputEnd, fired: false });
    }
    emitUpdate();
    acceptingUpdates = false;
    if (updateTimer) clearTimeout(updateTimer);
    const snapshot = snapshotOutput(session, 0, request.limit ?? DEFAULT_READ_LIMIT);
    session.defaultCursor = snapshot.cursor;
    pruneSessions();
    return {
      session,
      wait,
      poppedOutIntoBackground,
      output: snapshot.output,
      cursor: snapshot.cursor,
      hasMore: snapshot.hasMore,
    };
  };

  pi.registerTool({
    name: "bash",
    label: "Shell",
    description: "Run a shell command. Commands get a bounded foreground window and automatically continue as managed background terminals instead of being killed.",
    promptSnippet: "Run shell commands with automatic background handoff",
    promptGuidelines: [
      `Ordinary commands wait up to ${DEFAULT_BLOCK_UNTIL_MS}ms; if still running, they move to the background and return background_shell_id.`,
      "For known servers, watchers, monitors, or other persistent commands, set is_background=true; do not append &.",
      "block_until_ms only bounds this tool call. timeout_ms is an optional hard process lifetime that stops the process.",
      "Use terminal read/await/send/stop with background_shell_id. Never poll with shell sleep; await is event-driven and bounded.",
      "A healthy long-running service may remain in the background. Stop temporary processes before finishing unless the user asks to keep them.",
    ],
    parameters: bashParameters,
    executionMode: "parallel",
    async execute(toolCallId, params: BashParameters, signal, onUpdate, ctx) {
      const hardTimeoutMs = params.timeout_ms ?? (params.timeout ? Math.round(params.timeout * 1_000) : undefined);
      const started = await startManagedSession({
        ownerToolCallId: toolCallId,
        command: params.command,
        cwd: params.cwd,
        name: params.name,
        outputMode: params.output_mode ?? "log",
        initialBackground: params.is_background === true,
        waitTimeoutMs: params.is_background ? 0 : (params.block_until_ms ?? DEFAULT_BLOCK_UNTIL_MS),
        waitForExitOnly: true,
        hardTimeoutMs,
        notifyOutputRegex: params.notify_on_output,
        limit: params.limit,
        autoNotifyExit: true,
        onUpdate,
      }, signal, ctx.cwd);
      if (!isRunning(started.session)) notices.markObserved(started.session.id);
      return toolResult({
        ...serializeSession(started.session),
        ok: started.session.status !== "failed" && started.session.status !== "cleanup_failed",
        wait: started.wait,
        popped_out_into_background: started.poppedOutIntoBackground,
        output: started.output,
        cursor: started.cursor,
        hasMore: started.hasMore,
      });
    },
  });

  pi.registerTool({
    name: "terminal",
    label: "Terminal",
    description: "Control managed shell sessions: start, read, await, send input, stop, or list them.",
    promptSnippet: "Control managed background and interactive shell sessions",
    promptGuidelines: [
      "Use the id returned by bash or terminal start for read, await, send, and stop.",
      `Use bounded event-driven await calls (default ${DEFAULT_BLOCK_UNTIL_MS}ms), not repeated shell sleep commands or unbounded polling.`,
      "Use screen mode for TUI redraws and log mode when every emitted line matters.",
    ],
    parameters: terminalParameters,
    executionMode: "parallel",
    async execute(toolCallId, params: TerminalParameters, signal, onUpdate, ctx) {
      if (params.action === "list") {
        if (params.clearExited) {
          await Promise.all([...sessions.values()]
            .filter((session) => !isRunning(session) && (!session.cleanup?.verified || session.cleanup.residualPids.length > 0))
            .map((session) => stopTerminal(session, false, DEFAULT_STOP_TIMEOUT_MS)));
        }
        const removed = pruneSessions(params.clearExited ?? false);
        const items = [...sessions.values()].map(serializeSession);
        return toolResult({
          count: items.length,
          running: items.filter((item) => item.status === "running").length,
          completed: items.filter((item) => item.status !== "running").length,
          removed,
          retention: { maxCompleted: MAX_COMPLETED_SESSIONS, ttlMinutes: COMPLETED_SESSION_TTL_MS / 60_000 },
          sessions: items,
        });
      }
      if (params.action === "start") {
        const started = await startManagedSession({
          ownerToolCallId: toolCallId,
          command: params.command ?? "",
          cwd: params.cwd,
          name: params.name,
          outputMode: params.outputMode ?? "screen",
          initialBackground: (params.timeoutMs ?? 0) === 0 && !params.waitFor,
          waitFor: params.waitFor,
          waitTimeoutMs: params.timeoutMs ?? (params.waitFor ? 10_000 : 0),
          waitForExitOnly: false,
          notifyOn: params.notifyOn,
          stalledMs: params.stalledMs,
          limit: params.limit,
          cols: params.cols,
          rows: params.rows,
          autoNotifyExit: false,
          onUpdate,
        }, signal, ctx.cwd);
        if (!isRunning(started.session)) notices.markObserved(started.session.id);
        return toolResult({
          ...serializeSession(started.session),
          wait: started.wait,
          popped_out_into_background: started.poppedOutIntoBackground,
          output: started.output,
          cursor: started.cursor,
          hasMore: started.hasMore,
        });
      }

      const session = findSession(params.id);
      if (params.action === "read" || params.action === "await") {
        const cursor = params.cursor ?? session.defaultCursor;
        const timeoutMs = params.timeoutMs ?? (params.action === "await" ? DEFAULT_BLOCK_UNTIL_MS : params.waitFor ? 10_000 : 0);
        const wait = params.action === "await" && !params.waitFor
          ? await waitForTerminalExit(session, timeoutMs, signal)
          : await waitForTerminal(session, cursor, params.waitFor, timeoutMs, signal);
        const snapshot = snapshotOutput(session, cursor, params.limit ?? DEFAULT_READ_LIMIT);
        session.defaultCursor = snapshot.cursor;
        notices.markObserved(session.id);
        return toolResult({
          ...serializeSession(session),
          wait,
          output: snapshot.output,
          cursor: snapshot.cursor,
          hasMore: snapshot.hasMore,
          truncatedBeforeCursor: snapshot.truncatedBeforeCursor,
          bufferStart: snapshot.bufferStart,
          outputEnd: snapshot.outputEnd,
        });
      }
      if (params.action === "send") {
        if (!isRunning(session)) throw new Error(`Terminal ${session.id} is not running`);
        let data = params.input ?? "";
        if (params.enter) data += "\r";
        if (params.key) data += KEY_SEQUENCES[params.key];
        if (!data) throw new Error("terminal send requires input, enter, or key");
        session.pty.write(data);
        return toolResult({ ...serializeSession(session), sentCharacters: Array.from(data).length });
      }
      if (params.action === "stop") {
        const cleanup = await stopTerminal(session, params.force ?? false, params.timeoutMs ?? DEFAULT_STOP_TIMEOUT_MS);
        publishTerminalState(session);
        notices.markObserved(session.id);
        return toolResult({ ...serializeSession(session), cleanup });
      }
      throw new Error(`Unsupported terminal action: ${params.action}`);
    },
  });

  pi.on("session_shutdown", async () => {
    notices.dispose();
    for (const session of sessions.values()) {
      clearNotificationTimers(session);
      if (session.hardTimeoutTimer) clearTimeout(session.hardTimeoutTimer);
    }
    await Promise.all([...sessions.values()]
      .filter((session) => !session.cleanup?.verified || session.cleanup.residualPids.length > 0)
      .map((session) => stopTerminal(session, false, DEFAULT_STOP_TIMEOUT_MS)));
  });
}
