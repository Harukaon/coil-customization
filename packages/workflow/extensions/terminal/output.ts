import { chmodSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
  DEFAULT_STALLED_MS,
  MAX_BUFFER_CHARS,
  MAX_SCREEN_CHARS,
  MAX_SCREEN_EVENTS,
  RETAIN_BUFFER_CHARS,
  type ManagedTerminal,
  type ReadSnapshot,
  type ScreenState,
  type TerminalNotification,
  type TerminalNotificationEvent,
} from "./types.ts";

let ptyModulePromise: Promise<typeof import("node-pty")> | undefined;

export function isRunning(session: ManagedTerminal): boolean {
  return session.status === "running";
}

function cleanTerminalOutput(data: string): string {
  return stripVTControlCharacters(data)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u0008/g, "");
}

export function createScreenState(): ScreenState {
  return { line: "", cursor: 0, ansiRemainder: "", revision: 0, events: [] };
}

function screenEventCharacters(state: ScreenState): number {
  return state.events.reduce((total, event) => total + event.text.length, 0);
}

function trimScreenEvents(state: ScreenState): void {
  while (
    state.events.length > MAX_SCREEN_EVENTS
    || (screenEventCharacters(state) > MAX_SCREEN_CHARS && state.events.length > 1)
  ) {
    const removed = state.events.shift();
    if (removed === state.frameEvent) state.frameEvent = undefined;
  }
  const onlyEvent = state.events[0];
  if (state.events.length === 1 && onlyEvent && onlyEvent.text.length > MAX_SCREEN_CHARS) {
    onlyEvent.text = onlyEvent.text.slice(-MAX_SCREEN_CHARS);
  }
}

function updateScreenFrame(session: ManagedTerminal): void {
  const state = session.screen;
  const text = state.line.replace(/[ \t]+$/g, "");
  if (state.frameEvent?.text === text) return;
  state.revision += 1;
  if (state.frameEvent) {
    state.frameEvent.text = text;
    state.frameEvent.revision = state.revision;
  } else {
    state.frameEvent = { revision: state.revision, text, kind: "frame" };
    state.events.push(state.frameEvent);
  }
  session.outputEnd = state.revision;
  trimScreenEvents(state);
}

function commitScreenLine(session: ManagedTerminal): void {
  const state = session.screen;
  if (state.frameEvent) {
    const index = state.events.indexOf(state.frameEvent);
    if (index >= 0) state.events.splice(index, 1);
    state.frameEvent = undefined;
  }
  state.revision += 1;
  state.events.push({
    revision: state.revision,
    text: state.line.replace(/[ \t]+$/g, ""),
    kind: "line",
  });
  state.line = "";
  state.cursor = 0;
  session.outputEnd = state.revision;
  trimScreenEvents(state);
}

function writeScreenCharacter(state: ScreenState, character: string): void {
  if (state.cursor > state.line.length) state.line += " ".repeat(state.cursor - state.line.length);
  if (state.cursor === state.line.length) state.line += character;
  else state.line = state.line.slice(0, state.cursor) + character + state.line.slice(state.cursor + character.length);
  state.cursor += character.length;
}

function numberParam(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function handleCsiSequence(state: ScreenState, sequence: string): void {
  const final = sequence.at(-1);
  if (!final) return;
  const body = sequence.slice(2, -1).replace(/^\?/, "");
  const first = numberParam(body.split(";")[0], 1);
  switch (final) {
    case "K":
      if (first === 2 || first === 3) {
        state.line = "";
        state.cursor = 0;
      } else if (first === 1) {
        state.line = " ".repeat(Math.min(state.cursor, state.line.length)) + state.line.slice(state.cursor);
      } else state.line = state.line.slice(0, state.cursor);
      return;
    case "G":
    case "`":
      state.cursor = Math.max(0, first - 1);
      return;
    case "C":
    case "a":
      state.cursor += Math.max(1, first);
      return;
    case "D":
      state.cursor = Math.max(0, state.cursor - Math.max(1, first));
      return;
    case "A":
      state.line = "";
      state.cursor = 0;
      return;
    case "J":
      if (first === 2 || first === 3) {
        state.line = "";
        state.cursor = 0;
      }
      return;
    default:
      return;
  }
}

export function consumeScreenOutput(session: ManagedTerminal, rawData: string): void {
  const state = session.screen;
  const data = state.ansiRemainder + rawData;
  state.ansiRemainder = "";
  let changed = false;
  let committed = false;
  for (let index = 0; index < data.length;) {
    const character = data[index];
    if (character === "\u001b") {
      if (index + 1 >= data.length) {
        state.ansiRemainder = data.slice(index);
        break;
      }
      const next = data[index + 1];
      if (next === "[") {
        let end = index + 2;
        while (end < data.length) {
          const code = data.charCodeAt(end);
          if (code >= 0x40 && code <= 0x7e) break;
          end += 1;
        }
        if (end >= data.length) {
          state.ansiRemainder = data.slice(index);
          break;
        }
        handleCsiSequence(state, data.slice(index, end + 1));
        changed = true;
        index = end + 1;
        continue;
      }
      if (next === "]") {
        let end = index + 2;
        let terminated = false;
        while (end < data.length) {
          if (data[end] === "\u0007") {
            end += 1;
            terminated = true;
            break;
          }
          if (data[end] === "\u001b" && data[end + 1] === "\\") {
            end += 2;
            terminated = true;
            break;
          }
          end += 1;
        }
        if (!terminated) {
          state.ansiRemainder = data.slice(index);
          break;
        }
        index = end;
        continue;
      }
      index += 2;
      continue;
    }
    if (character === "\r") {
      state.cursor = 0;
      changed = true;
      index += 1;
      continue;
    }
    if (character === "\n" || character === "\f" || character === "\v") {
      commitScreenLine(session);
      committed = true;
      changed = false;
      index += 1;
      continue;
    }
    if (character === "\b") {
      state.cursor = Math.max(0, state.cursor - 1);
      changed = true;
      index += 1;
      continue;
    }
    if (character === "\t") {
      writeScreenCharacter(state, " ".repeat(8 - (state.cursor % 8)));
      changed = true;
      index += 1;
      continue;
    }
    if (character < " ") {
      index += 1;
      continue;
    }
    writeScreenCharacter(state, character);
    changed = true;
    index += 1;
  }
  if (changed || state.frameEvent) updateScreenFrame(session);
  if (changed || committed || state.frameEvent) {
    session.lastOutputAt = Date.now();
    scheduleStalledNotifications(session);
    notifyListeners(session);
  }
}

export function flushScreenOutput(session: ManagedTerminal): void {
  const state = session.screen;
  if (state.ansiRemainder) state.ansiRemainder = "";
  if (state.line.length > 0 || state.frameEvent) commitScreenLine(session);
}

function ensureSpawnHelperExecutable(): void {
  if (process.platform === "win32") return;
  try {
    const require = createRequire(import.meta.url);
    const packageRoot = resolve(dirname(require.resolve("node-pty")), "..");
    const candidates = [
      resolve(packageRoot, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
      resolve(packageRoot, "build", "Release", "spawn-helper"),
    ];
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue;
      const mode = statSync(candidate).mode;
      if ((mode & 0o100) === 0) chmodSync(candidate, mode | 0o755);
    }
  } catch {
    // node-pty provides the actionable load/spawn error.
  }
}

export async function loadPty(): Promise<typeof import("node-pty")> {
  ensureSpawnHelperExecutable();
  ptyModulePromise ??= import("node-pty");
  return ptyModulePromise;
}

export function notifyListeners(session: ManagedTerminal): void {
  for (const listener of [...session.listeners]) listener();
  checkNotifications(session);
}

export function appendLogOutput(session: ManagedTerminal, rawData: string): void {
  const data = cleanTerminalOutput(rawData);
  if (!data) return;
  session.buffer += data;
  session.outputEnd += data.length;
  if (session.buffer.length > MAX_BUFFER_CHARS) {
    const trimCount = session.buffer.length - RETAIN_BUFFER_CHARS;
    session.buffer = session.buffer.slice(trimCount);
    session.bufferStart += trimCount;
  }
  session.lastOutputAt = Date.now();
  scheduleStalledNotifications(session);
  notifyListeners(session);
}

export function appendOutput(session: ManagedTerminal, rawData: string): void {
  if (!rawData) return;
  session.outputStream?.write(cleanTerminalOutput(rawData));
  if (session.outputMode === "screen") consumeScreenOutput(session, rawData);
  else appendLogOutput(session, rawData);
}

export function flushTerminalOutput(session: ManagedTerminal): void {
  if (session.outputMode === "screen") flushScreenOutput(session);
}

function screenOutputSince(session: ManagedTerminal, requestedCursor: number): string {
  return session.screen.events
    .filter((event) => event.revision > requestedCursor)
    .map((event) => event.text)
    .join("\n");
}

export function snapshotOutput(session: ManagedTerminal, requestedCursor: number, limit: number): ReadSnapshot {
  if (session.outputMode === "screen") {
    const firstEvent = session.screen.events[0];
    const truncatedBeforeCursor = firstEvent !== undefined && requestedCursor < firstEvent.revision - 1;
    let output = screenOutputSince(session, requestedCursor);
    let truncated = truncatedBeforeCursor;
    if (output.length > limit) {
      output = output.slice(-limit);
      truncated = true;
    }
    return {
      output,
      cursor: session.screen.revision,
      startCursor: requestedCursor,
      bufferStart: firstEvent?.revision ?? session.screen.revision,
      outputEnd: session.screen.revision,
      truncatedBeforeCursor: truncated,
      hasMore: false,
    };
  }
  const truncatedBeforeCursor = requestedCursor < session.bufferStart;
  const startCursor = Math.max(session.bufferStart, Math.min(requestedCursor, session.outputEnd));
  const available = session.buffer.slice(startCursor - session.bufferStart);
  const output = available.slice(0, limit);
  const cursor = startCursor + output.length;
  return {
    output,
    cursor,
    startCursor,
    bufferStart: session.bufferStart,
    outputEnd: session.outputEnd,
    truncatedBeforeCursor,
    hasMore: cursor < session.outputEnd,
  };
}

export function outputSince(session: ManagedTerminal, requestedCursor: number): string {
  if (session.outputMode === "screen") return screenOutputSince(session, requestedCursor);
  const startCursor = Math.max(session.bufferStart, Math.min(requestedCursor, session.outputEnd));
  return session.buffer.slice(startCursor - session.bufferStart);
}

export function clearNotificationTimers(session: ManagedTerminal): void {
  for (const notification of session.notifications) {
    if (notification.timer) clearTimeout(notification.timer);
    notification.timer = undefined;
  }
}

function fireNotification(
  session: ManagedTerminal,
  notification: TerminalNotification,
  event: TerminalNotificationEvent,
): void {
  if (notification.fired) return;
  notification.fired = true;
  if (notification.timer) clearTimeout(notification.timer);
  notification.timer = undefined;
  session.notifyEvent?.(event);
}

export function checkNotifications(session: ManagedTerminal): void {
  for (const notification of session.notifications) {
    if (notification.fired) continue;
    if (!isRunning(session) && notification.mode === "stalled") {
      notification.fired = true;
      if (notification.timer) clearTimeout(notification.timer);
      notification.timer = undefined;
      continue;
    }
    if (notification.mode === "exit" && !isRunning(session)) {
      if (session.stopRequested && !session.timeoutRequested) {
        notification.fired = true;
        continue;
      }
      fireNotification(session, notification, { mode: "exit" });
      continue;
    }
    const output = outputSince(session, notification.cursor);
    if (notification.mode === "match" && notification.pattern && output.includes(notification.pattern)) {
      fireNotification(session, notification, { mode: "match", pattern: notification.pattern });
    } else if (notification.mode === "regex" && notification.regex && notification.regex.test(output)) {
      fireNotification(session, notification, { mode: "regex", pattern: notification.pattern });
    }
  }
}

export function scheduleStalledNotifications(session: ManagedTerminal): void {
  for (const notification of session.notifications) {
    if (notification.mode !== "stalled" || notification.fired) continue;
    if (notification.timer) clearTimeout(notification.timer);
    const stalledMs = notification.stalledMs ?? DEFAULT_STALLED_MS;
    notification.timer = setTimeout(() => {
      if (isRunning(session) && Date.now() - session.lastOutputAt >= stalledMs) {
        fireNotification(session, notification, { mode: "stalled" });
      } else if (!notification.fired) scheduleStalledNotifications(session);
    }, stalledMs);
  }
}

export function armNotification(session: ManagedTerminal, notification: TerminalNotification): void {
  if (session.notifications.some((current) => current.mode === notification.mode && current.pattern === notification.pattern)) return;
  session.notifications.push(notification);
  scheduleStalledNotifications(session);
  checkNotifications(session);
}
