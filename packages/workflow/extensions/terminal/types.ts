import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import type { WriteStream } from "node:fs";
import type { IDisposable, IPty } from "node-pty";

export const MAX_BUFFER_CHARS = 1_000_000;
export const RETAIN_BUFFER_CHARS = 800_000;
export const MAX_SCREEN_EVENTS = 2_000;
export const MAX_SCREEN_CHARS = 200_000;
export const DEFAULT_READ_LIMIT = 30_000;
export const MAX_COMPLETED_SESSIONS = 8;
export const COMPLETED_SESSION_TTL_MS = 30 * 60_000;
export const MAX_WAIT_TIMEOUT_MS = 30 * 60_000;
export const DEFAULT_BLOCK_UNTIL_MS = 30_000;
export const MAX_COMMAND_TIMEOUT_MS = 24 * 60 * 60_000;
export const DEFAULT_STALLED_MS = 60_000;
export const DEFAULT_STOP_TIMEOUT_MS = 3_000;
export const CLEANUP_POLL_MS = 100;
export const CLEANUP_VERIFY_MS = 750;

export const terminalParameters = Type.Object(
  {
    action: StringEnum(["start", "read", "await", "send", "stop", "list"] as const),
    id: Type.Optional(Type.String({ description: "Terminal id or unique name" })),
    command: Type.Optional(Type.String({ description: "Command to run for action=start" })),
    outputMode: Type.Optional(StringEnum(["screen", "log"] as const, {
      description: "Output mode for action=start: screen merges TUI redraw frames; log preserves line output",
    })),
    cwd: Type.Optional(Type.String({ description: "Working directory for action=start" })),
    name: Type.Optional(Type.String({ maxLength: 60, description: "Optional memorable name for action=start" })),
    cursor: Type.Optional(Type.Integer({ minimum: 0, description: "Output cursor returned by start/read" })),
    waitFor: Type.Optional(Type.String({ maxLength: 500, description: "Wait until this literal text appears in new output" })),
    timeoutMs: Type.Optional(Type.Integer({
      minimum: 0,
      maximum: MAX_WAIT_TIMEOUT_MS,
      description: "Bounded wait for read/start/await/stop; this never becomes a process lifetime timeout",
    })),
    notifyOn: Type.Optional(StringEnum(["exit", "match", "stalled"] as const, {
      description: "For action=start, notify when the process exits, waitFor matches, or output stalls",
    })),
    stalledMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: MAX_WAIT_TIMEOUT_MS })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
    input: Type.Optional(Type.String({ description: "Text sent to the PTY for action=send" })),
    enter: Type.Optional(Type.Boolean({ description: "Append Enter after input for action=send" })),
    key: Type.Optional(StringEnum([
      "enter", "ctrl-c", "ctrl-d", "tab", "escape", "up", "down", "left", "right",
    ] as const, { description: "Special key sent for action=send" })),
    force: Type.Optional(Type.Boolean({ description: "Immediately kill the process tree" })),
    clearExited: Type.Optional(Type.Boolean({ description: "For action=list, remove completed history" })),
    cols: Type.Optional(Type.Integer({ minimum: 20, maximum: 400 })),
    rows: Type.Optional(Type.Integer({ minimum: 5, maximum: 200 })),
  },
  { additionalProperties: false },
);

export const bashParameters = Type.Object(
  {
    command: Type.String({ description: "Shell command to execute" }),
    cwd: Type.Optional(Type.String({ description: "Working directory, relative to the project or absolute" })),
    is_background: Type.Optional(Type.Boolean({
      description: "Return immediately and keep the command running in a managed background terminal",
    })),
    block_until_ms: Type.Optional(Type.Integer({
      minimum: 0,
      maximum: MAX_WAIT_TIMEOUT_MS,
      default: DEFAULT_BLOCK_UNTIL_MS,
      description: "Wait this long for completion, then automatically move a still-running command to the background",
    })),
    timeout_ms: Type.Optional(Type.Integer({
      minimum: 1,
      maximum: MAX_COMMAND_TIMEOUT_MS,
      description: "Optional hard process lifetime; unlike block_until_ms, reaching it stops the process",
    })),
    timeout: Type.Optional(Type.Number({
      exclusiveMinimum: 0,
      maximum: MAX_COMMAND_TIMEOUT_MS / 1_000,
      description: "Legacy hard process timeout in seconds; prefer timeout_ms",
    })),
    notify_on_output: Type.Optional(Type.String({
      maxLength: 500,
      description: "Regular expression that triggers an asynchronous notification when new output matches",
    })),
    output_mode: Type.Optional(StringEnum(["screen", "log"] as const, {
      description: "screen coalesces redraws; log preserves emitted lines",
    })),
    name: Type.Optional(Type.String({ maxLength: 60, description: "Optional memorable background shell name" })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
  },
  { additionalProperties: false },
);

export type TerminalParameters = Static<typeof terminalParameters>;
export type BashParameters = Static<typeof bashParameters>;
export type TerminalStatus = "running" | "exited" | "failed" | "stopped" | "cleanup_failed";
export type WaitOutcome = "matched" | "output" | "exit" | "timeout" | "aborted";
export type CleanupSignal = "SIGINT" | "SIGTERM" | "SIGKILL";
export type TerminalNotifyOn = "exit" | "match" | "regex" | "stalled";

export interface CleanupReport {
  forceRequested: boolean;
  gracefulAttempted: boolean;
  gracefulSucceeded: boolean;
  escalatedToSigkill: boolean;
  signal?: CleanupSignal;
  descendantsFound: number;
  targetedPids: number[];
  terminatedPids: number[];
  sigkillPids: number[];
  residualPids: number[];
  verified: boolean;
  enumerationError?: string;
}

export interface ProcessRecord {
  pid: number;
  ppid: number;
  pgid: number;
  sessionId: number;
  state: string;
  tty: string;
}

export interface ProcessScan {
  table: Map<number, ProcessRecord>;
  owned: ProcessRecord[];
  rootAlive: boolean;
}

export interface TerminalNotification {
  mode: TerminalNotifyOn;
  cursor: number;
  pattern?: string;
  regex?: RegExp;
  stalledMs?: number;
  fired: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

export interface TerminalNotificationEvent {
  mode: TerminalNotifyOn;
  pattern?: string;
}

export interface ScreenEvent {
  revision: number;
  text: string;
  kind: "line" | "frame";
}

export interface ScreenState {
  line: string;
  cursor: number;
  ansiRemainder: string;
  revision: number;
  events: ScreenEvent[];
  frameEvent?: ScreenEvent;
}

export interface ManagedTerminal {
  id: string;
  ownerToolCallId: string;
  name: string;
  command: string;
  cwd: string;
  pid: number;
  pty: IPty;
  status: TerminalStatus;
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
  signal?: number;
  stopRequested: boolean;
  timeoutRequested?: boolean;
  background: boolean;
  processSessionId?: number;
  tty?: string;
  cleanup?: CleanupReport;
  cleanupPromise?: Promise<CleanupReport>;
  hardTimeoutTimer?: ReturnType<typeof setTimeout>;
  outputMode: "screen" | "log";
  outputPath: string;
  outputStream?: WriteStream;
  buffer: string;
  bufferStart: number;
  outputEnd: number;
  defaultCursor: number;
  screen: ScreenState;
  lastOutputAt: number;
  notifications: TerminalNotification[];
  notifyEvent?: (event: TerminalNotificationEvent) => void;
  listeners: Set<() => void>;
  dataDisposable?: IDisposable;
  exitDisposable?: IDisposable;
}

export interface ReadSnapshot {
  output: string;
  cursor: number;
  startCursor: number;
  bufferStart: number;
  outputEnd: number;
  truncatedBeforeCursor: boolean;
  hasMore: boolean;
}

export const KEY_SEQUENCES: Record<NonNullable<TerminalParameters["key"]>, string> = {
  enter: "\r",
  "ctrl-c": "\u0003",
  "ctrl-d": "\u0004",
  tab: "\t",
  escape: "\u001b",
  up: "\u001b[A",
  down: "\u001b[B",
  left: "\u001b[D",
  right: "\u001b[C",
};
