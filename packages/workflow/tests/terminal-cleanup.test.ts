import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import terminalExtension from "../extensions/terminal.ts";

function createHarness() {
  const handlers = new Map<string, Array<(...args: any[]) => any>>();
  const tools = new Map<string, any>();
  const messages: any[] = [];
  const entries: any[] = [];
  const pi = {
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    on(name: string, handler: (...args: any[]) => any) {
      const current = handlers.get(name) ?? [];
      current.push(handler);
      handlers.set(name, current);
    },
    sendMessage(message: any, options: any) {
      messages.push({ message, options });
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({ customType, data });
    },
  };

  terminalExtension(pi as any);
  const ctx = { cwd: process.cwd() };
  const run = (params: Record<string, unknown>) =>
    tools.get("terminal").execute("test-terminal-call", params, undefined, undefined, ctx);
  const runBash = (params: Record<string, unknown>, onUpdate?: (result: any) => void) =>
    tools.get("bash").execute("test-bash-call", params, undefined, onUpdate, ctx);
  const shutdown = async () => {
    for (const handler of handlers.get("session_shutdown") ?? []) {
      await handler({}, ctx);
    }
  };
  const emit = async (name: string) => {
    for (const handler of handlers.get(name) ?? []) {
      await handler({ type: name }, ctx);
    }
  };

  return { run, runBash, shutdown, emit, messages, entries, tools };
}

async function waitUntil(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function processRecord(pid: number): string | undefined {
  try {
    const output = execFileSync(
      "/bin/ps",
      ["-o", "pid=,ppid=,pgid=,stat=,comm=", "-p", String(pid)],
      { encoding: "utf8" },
    ).trim();
    return output || undefined;
  } catch {
    return undefined;
  }
}

test("bash exposes bounded foreground wait instead of a default hard timeout", async (context) => {
  const { runBash, shutdown, tools, entries } = createHarness();
  context.after(shutdown);

  const properties = tools.get("bash").parameters.properties;
  assert.equal(properties.block_until_ms.default, 30_000);
  assert.equal(properties.timeout_ms.default, undefined);

  const result = await runBash({
    command: "sleep 0.05; printf DONE",
    block_until_ms: 2_000,
  });
  assert.equal(result.details.wait, "exit");
  assert.equal(result.details.popped_out_into_background, false);
  assert.equal(result.details.is_running_in_background, false);
  assert.equal(result.details.status, "exited");
  assert.match(result.details.output, /DONE/);
  assert.equal(entries.length, 0, "foreground completion is already represented by its tool result");
});

test("bash streams partial output while it is inside the foreground window", async (context) => {
  const { runBash, shutdown } = createHarness();
  context.after(shutdown);
  const updates: any[] = [];

  const result = await runBash({
    command: "printf START; sleep 0.15; printf END",
    block_until_ms: 2_000,
  }, (update) => updates.push(update));

  assert.ok(updates.some((update) => /START/.test(update.content[0]?.text ?? "")));
  assert.equal(result.details.status, "exited");
  assert.match(result.details.output, /START.*END/s);
});

test("bash automatically hands a long command to the terminal manager", async (context) => {
  const { run, runBash, shutdown } = createHarness();
  let terminalId: string | undefined;
  context.after(async () => {
    if (terminalId) await run({ action: "stop", id: terminalId, force: true, timeoutMs: 1_000 }).catch(() => undefined);
    await shutdown();
  });

  const startedAt = Date.now();
  const result = await runBash({
    command: "printf READY; sleep 30",
    block_until_ms: 50,
  });
  terminalId = result.details.background_shell_id;
  assert.ok(Date.now() - startedAt < 2_000);
  assert.match(terminalId ?? "", /^term-/);
  assert.equal(result.details.wait, "timeout");
  assert.equal(result.details.popped_out_into_background, true);
  assert.equal(result.details.is_running_in_background, true);
  assert.match(result.details.output, /READY/);

  const listed = await run({ action: "list" });
  assert.ok(listed.details.sessions.some((session: any) => session.id === terminalId && session.status === "running"));
});

test("is_background returns immediately without shell ampersands", async (context) => {
  const { run, runBash, shutdown } = createHarness();
  let terminalId: string | undefined;
  context.after(async () => {
    if (terminalId) await run({ action: "stop", id: terminalId, force: true, timeoutMs: 1_000 }).catch(() => undefined);
    await shutdown();
  });

  const startedAt = Date.now();
  const result = await runBash({ command: "sleep 30", is_background: true });
  terminalId = result.details.background_shell_id;
  assert.ok(Date.now() - startedAt < 1_000);
  assert.equal(result.details.popped_out_into_background, false);
  assert.equal(result.details.is_running_in_background, true);
});

test("timeout_ms is a separate hard lifetime and reports failure", async (context) => {
  const { run, runBash, shutdown } = createHarness();
  context.after(shutdown);

  const started = await runBash({
    command: "sleep 30",
    is_background: true,
    timeout_ms: 100,
  });
  const completed = await run({
    action: "await",
    id: started.details.background_shell_id,
    timeoutMs: 5_000,
  });
  assert.equal(completed.details.wait, "exit");
  assert.equal(completed.details.status, "failed");
  assert.equal(completed.details.is_running_in_background, false);
});

test("background bash completion wakes the Agent and keeps a readable output file", async (context) => {
  const { runBash, shutdown, messages, entries } = createHarness();
  context.after(shutdown);

  const started = await runBash({
    command: "sleep 0.05; printf FINISHED",
    is_background: true,
  });
  await waitUntil(() => messages.length > 0);

  assert.equal(messages.length, 1, "one background exit costs the Agent one wake-up");
  assert.ok(messages.some((entry) => entry.message.details.mode === "exit"));
  assert.ok(messages.some((entry) => entry.options.triggerTurn === true));
  assert.ok(entries.some((entry) => entry.customType === "coilcoil-terminal-run"
    && entry.data.status === "succeeded"
    && entry.data.ownerToolCallId === "test-bash-call"));
  assert.match(await readFile(started.details.output_location, "utf8"), /FINISHED/);
});

test("notify_on_output uses a regular expression without ending the background shell", async (context) => {
  const { run, runBash, shutdown, messages } = createHarness();
  let terminalId: string | undefined;
  context.after(async () => {
    if (terminalId) await run({ action: "stop", id: terminalId, force: true, timeoutMs: 1_000 }).catch(() => undefined);
    await shutdown();
  });

  const started = await runBash({
    command: "printf 'Listening on 4321\\n'; sleep 30",
    is_background: true,
    notify_on_output: "Listening on \\d+",
  });
  terminalId = started.details.background_shell_id;
  await waitUntil(() => messages.length > 0);

  assert.equal(started.details.is_running_in_background, true);
  assert.ok(messages.some((entry) => entry.message.details.mode === "regex"));
});

test(
  "stop removes a background job in a separate process group",
  { skip: process.platform === "win32" },
  async (context) => {
    const { run, shutdown } = createHarness();
    let terminalId: string | undefined;
    context.after(async () => {
      if (terminalId) {
        await run({
          action: "stop",
          id: terminalId,
          force: true,
          timeoutMs: 1_000,
        }).catch(() => undefined);
      }
      await shutdown();
    });

    const started = await run({
      action: "start",
      command:
        "set -m; sleep 300 & child=$!; echo CHILD_PID=$child SHELL_PID=$$ READY; wait",
      waitFor: "READY",
      timeoutMs: 5_000,
    });
    terminalId = started.details.id;

    const match = started.details.output.match(
      /CHILD_PID=(\d+)\s+SHELL_PID=(\d+)\s+READY/,
    );
    assert.ok(match, `PID output missing: ${started.details.output}`);
    const childPid = Number(match[1]);
    const shellPid = Number(match[2]);
    const childBefore = processRecord(childPid);
    const shellBefore = processRecord(shellPid);
    assert.ok(childBefore);
    assert.ok(shellBefore);
    assert.notEqual(
      childBefore.trim().split(/\s+/)[2],
      shellBefore.trim().split(/\s+/)[2],
      "background process must use a distinct PGID for this regression",
    );

    const stopped = await run({
      action: "stop",
      id: terminalId,
      timeoutMs: 4_000,
    });
    terminalId = undefined;

    assert.equal(processRecord(shellPid), undefined);
    assert.equal(processRecord(childPid), undefined);
    assert.equal(stopped.details.status, "stopped");
    assert.equal(stopped.details.cleanup.gracefulSucceeded, true);
    assert.equal(stopped.details.cleanup.escalatedToSigkill, false);
    assert.deepEqual(stopped.details.cleanup.residualPids, []);
  },
);

test(
  "stop reports SIGKILL escalation without contradictory exitCode",
  { skip: process.platform === "win32" },
  async (context) => {
    const { run, shutdown } = createHarness();
    let terminalId: string | undefined;
    context.after(async () => {
      if (terminalId) {
        await run({
          action: "stop",
          id: terminalId,
          force: true,
          timeoutMs: 1_000,
        }).catch(() => undefined);
      }
      await shutdown();
    });

    const started = await run({
      action: "start",
      command: "trap '' INT TERM; echo READY; while true; do sleep 1; done",
      waitFor: "READY",
      timeoutMs: 3_000,
    });
    terminalId = started.details.id;
    const rootPid = started.details.pid;

    const stopped = await run({
      action: "stop",
      id: terminalId,
      force: false,
      timeoutMs: 1_200,
    });
    terminalId = undefined;

    assert.equal(processRecord(rootPid), undefined);
    assert.equal(stopped.details.cleanup.gracefulAttempted, true);
    assert.equal(stopped.details.cleanup.gracefulSucceeded, false);
    assert.equal(stopped.details.cleanup.escalatedToSigkill, true);
    assert.equal(stopped.details.cleanup.signal, "SIGKILL");
    assert.deepEqual(stopped.details.cleanup.residualPids, []);
    assert.equal(stopped.details.exitCode, null);
    assert.equal(stopped.details.signal, "SIGKILL");
    assert.equal(stopped.details.rawSignal, 9);
  },
);

test("list can clear bounded completed history", async (context) => {
  const { run, shutdown } = createHarness();
  context.after(shutdown);

  await run({ action: "start", command: "printf done" });
  await new Promise((resolve) => setTimeout(resolve, 100));

  const before = await run({ action: "list" });
  assert.equal(before.details.running, 0);
  assert.equal(before.details.completed, 1);
  assert.equal(before.details.retention.maxCompleted, 8);
  assert.equal(before.details.retention.ttlMinutes, 30);

  const after = await run({ action: "list", clearExited: true });
  assert.deepEqual(after.details.removed, ["term-1"]);
  assert.equal(after.details.count, 0);
});

test("screen output coalesces carriage-return redraws", async (context) => {
  const { run, shutdown } = createHarness();
  context.after(shutdown);

  const result = await run({
    action: "start",
    command: "printf 'one\\rtwo\\rthree\\n'",
    outputMode: "screen",
    timeoutMs: 2_000,
  });

  assert.match(result.details.output, /three/);
  assert.doesNotMatch(result.details.output, /one.*two/s);
  assert.equal(result.details.outputMode, "screen");
});

test("log output keeps carriage-return lines when requested", async (context) => {
  const { run, shutdown } = createHarness();
  context.after(shutdown);

  const result = await run({
    action: "start",
    command: "printf 'one\\rtwo\\n'",
    outputMode: "log",
    timeoutMs: 2_000,
  });

  assert.match(result.details.output, /one\ntwo/);
  assert.equal(result.details.outputMode, "log");
});

test("await waits for exit without polling", async (context) => {
  const { run, shutdown } = createHarness();
  context.after(shutdown);

  const started = await run({
    action: "start",
    command: "sleep 0.15; printf DONE",
    timeoutMs: 1_000,
  });
  const result = await run({
    action: "await",
    id: started.details.id,
    timeoutMs: 2_000,
  });

  assert.equal(result.details.wait, "exit");
  assert.match(result.details.output, /DONE/);
});

test("notifyOn exit sends a follow-up event once the shell outlives its tool call", async (context) => {
  const { run, shutdown, messages } = createHarness();
  context.after(shutdown);

  const started = await run({
    action: "start",
    command: "sleep 0.2; printf FINISHED",
    notifyOn: "exit",
    timeoutMs: 10,
  });
  assert.equal(started.details.status, "running");
  await waitUntil(() => messages.length > 0);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].message.customType, "terminal-notification");
  assert.equal(messages[0].options.triggerTurn, true);
  assert.equal(messages[0].options.deliverAs, "followUp");
  assert.match(messages[0].message.content, /已退出/);
  assert.match(messages[0].message.content, /FINISHED/);
});

test("an exit the Agent already awaited does not wake it again", async (context) => {
  const { run, runBash, shutdown, messages } = createHarness();
  context.after(shutdown);

  const started = await runBash({ command: "sleep 0.15; printf FINISHED", is_background: true });
  const awaited = await run({
    action: "await",
    id: started.details.background_shell_id,
    timeoutMs: 2_000,
  });
  await new Promise((resolve) => setTimeout(resolve, 400));

  assert.equal(awaited.details.wait, "exit");
  assert.match(awaited.details.output, /FINISHED/);
  assert.equal(messages.length, 0, "the await result already carries the exit");
});

test("exits during a run are held until it settles and then wake one turn", async (context) => {
  const { run, runBash, shutdown, emit, messages } = createHarness();
  context.after(shutdown);

  await emit("agent_start");
  const started = await Promise.all([
    runBash({ command: "sleep 0.05; printf ONE", is_background: true }),
    runBash({ command: "sleep 0.05; printf TWO", is_background: true }),
    runBash({ command: "sleep 0.05; printf THREE", is_background: true }),
  ]);
  const ids = started.map((shell) => shell.details.background_shell_id);
  const exited = async (): Promise<boolean> => {
    const listed = await run({ action: "list" });
    return listed.details.sessions
      .filter((session: any) => ids.includes(session.id))
      .every((session: any) => session.status !== "running");
  };
  const deadline = Date.now() + 5_000;
  while (!(await exited()) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(await exited(), "all three background shells finished");
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(messages.length, 0, "a working Agent reads its own terminals");

  await emit("agent_settled");
  await waitUntil(() => messages.length > 0);

  assert.equal(messages.length, 1, "three exits cost one turn, not three");
  const [message] = messages;
  assert.equal(message.options.deliverAs, "followUp");
  assert.equal(message.message.details.count, 3);
  assert.match(message.message.content, /^3 个终端有新的事件：/);
  for (const shell of started) {
    assert.match(message.message.content, new RegExp(shell.details.background_shell_id));
  }
});
