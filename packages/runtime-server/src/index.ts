import { CoilCoilRuntime, runGitAction, type CoilCoilRuntimeOptions } from "@coilcoil/runtime-core";
import {
  isRuntimeCommandEnvelope,
  SESSION_OPEN_SUPERSEDED_ERROR,
  type RuntimeCommand,
  type RuntimeCommandEnvelope,
  type RuntimeEvent,
  type RuntimeResponseEnvelope,
  type SessionSnapshot,
  type SessionSummary,
  type RuntimeWireMessage,
} from "@coilcoil/runtime-protocol";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  DIAGNOSTIC_LEVEL_ENV,
  DIAGNOSTIC_LOG_DIRECTORY,
  DiagnosticLog,
  installProcessErrorHandlers,
  levelFromEnvironment,
  processStartupData,
} from "@coilcoil/diagnostics";
import { selectWorkspaceSessionPath } from "./workspace-session.js";

type WireSink = (message: RuntimeWireMessage) => void;
type RuntimeFactory = (options: CoilCoilRuntimeOptions) => CoilCoilRuntime;

const MAX_RETAINED_IDLE_SESSION_RUNTIMES = 6;

export interface RuntimeServerDependencies {
  createRuntime?: RuntimeFactory;
  createRuntimeId?: () => string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeSessionPath(path: string): string {
  const absolute = resolve(path);
  let existing = absolute;
  const missingSegments: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return absolute;
    missingSegments.unshift(basename(existing));
    existing = parent;
  }
  try {
    return resolve(realpathSync(existing), ...missingSegments);
  } catch {
    return absolute;
  }
}

/**
 * Reads that answer from the workspace's own configuration files.
 *
 * They name their `cwd` and read it off disk, so the runtime they are addressed
 * to is only a host — any live one gives the same answer. That matters because
 * an idle session runtime is retired behind the renderer's back, and the panels
 * keep the id they were opened with: opening 技能 or MCP after that produced
 * 「所选会话运行时已失效，请重新打开会话」 (74 times in the user's log), asking
 * them to reopen a conversation to read a setting that never belonged to it.
 *
 * Session-scoped commands keep the error. Their answers and their events belong
 * to one conversation, so silently serving them from another runtime would put
 * the renderer on a session it is not showing.
 */
function answersFromWorkspaceConfiguration(command: RuntimeCommand): boolean {
  return command.type === "get_mcp_configuration"
    || command.type === "get_mcp_json"
    || command.type === "get_mcp_status"
    || command.type === "get_memory_configuration"
    || command.type === "get_subagent_configuration"
    || command.type === "get_session_naming_configuration"
    || command.type === "save_session_naming_configuration"
    || command.type === "get_skill_configuration";
}

function eventChangesSnapshot(event: RuntimeEvent): boolean {
  return event.type === "message_started"
    || event.type === "prompt_queue_updated"
    || event.type === "message_delta"
    || event.type === "message_finished"
    || event.type === "tool_started"
    || event.type === "tool_updated"
    || event.type === "tool_finished"
    || event.type === "plan_updated"
    || event.type === "plan_approval_updated"
    || event.type === "goal_updated"
    || event.type === "subagents_updated"
    || event.type === "project_updated"
    || event.type === "metrics_updated"
    || event.type === "runtime_inspection_updated"
    || event.type === "session_fast_updated"
    || event.type === "run_state";
}

export class RuntimeServer {
  readonly runtime: CoilCoilRuntime;

  /** Shared with every runtime this server owns, so one file holds them all. */
  readonly log: DiagnosticLog;
  private readonly send: WireSink;
  private readonly options: CoilCoilRuntimeOptions;
  private readonly createRuntime: RuntimeFactory;
  private readonly createRuntimeId: () => string;
  private readonly runtimes = new Map<string, CoilCoilRuntime>();
  private readonly sessionPaths = new Map<string, string>();
  private readonly runtimePaths = new Map<string, string>();
  private readonly runtimeAccess = new Map<string, number>();
  private readonly runningRuntimes = new Set<string>();
  private readonly memoryBusyRuntimes = new Set<string>();
  private readonly subagentBusyRuntimes = new Set<string>();
  private readonly dirtyRuntimes = new Set<string>();
  private readonly runtimeSnapshots = new Map<string, SessionSnapshot>();
  private readonly openingSessions = new Map<string, Promise<SessionSnapshot>>();
  private sessionOpenTail: Promise<void> = Promise.resolve();
  private desiredSessionPath?: string;
  private defaultRuntimeId?: string;
  private disposed = false;

  constructor(options: CoilCoilRuntimeOptions, send: WireSink, dependencies: RuntimeServerDependencies = {}) {
    this.send = send;
    this.options = options;
    this.log = options.log ?? new DiagnosticLog({
      directory: join(options.agentDir, DIAGNOSTIC_LOG_DIRECTORY),
      process: "runtime",
      level: levelFromEnvironment(process.env[DIAGNOSTIC_LEVEL_ENV]),
    });
    this.createRuntime = dependencies.createRuntime ?? ((runtimeOptions) => new CoilCoilRuntime(runtimeOptions));
    this.createRuntimeId = dependencies.createRuntimeId ?? randomUUID;
    this.runtime = this.createManagedRuntime();
  }

  async handle(envelope: RuntimeCommandEnvelope): Promise<RuntimeResponseEnvelope> {
    try {
      const result = await this.dispatch(envelope.command, envelope.runtimeId);
      return { id: envelope.id, ok: true, result };
    } catch (error) {
      this.log.error("command", "command_failed", error, { command: envelope.command.type }, {
        runtimeId: envelope.runtimeId,
      });
      return { id: envelope.id, ok: false, error: errorMessage(error) };
    }
  }

  private createManagedRuntime(runtimeId?: string, modelRuntimePromise?: CoilCoilRuntimeOptions["modelRuntimePromise"]): CoilCoilRuntime {
    return this.createRuntime({
      ...this.options,
      log: this.log,
      modelRuntimePromise,
      onEvent: (event) => this.sendRuntimeEvent(runtimeId, event),
    });
  }

  private sendRuntimeEvent(runtimeId: string | undefined, event: RuntimeEvent): void {
    if (runtimeId && !this.runtimes.has(runtimeId)) return;
    if (runtimeId && eventChangesSnapshot(event)) this.dirtyRuntimes.add(runtimeId);
    if (runtimeId && event.type === "run_state") {
      if (event.running) this.runningRuntimes.add(runtimeId);
      else {
        this.runningRuntimes.delete(runtimeId);
        this.retireExcessIdleRuntimes(runtimeId);
      }
    }
    if (runtimeId && event.type === "runtime_inspection_updated" && event.inspection.memory) {
      const memory = event.inspection.memory;
      const wasMemoryBusy = this.memoryBusyRuntimes.has(runtimeId);
      if (memory.state === "running") this.memoryBusyRuntimes.add(runtimeId);
      else if (wasMemoryBusy) {
        this.memoryBusyRuntimes.delete(runtimeId);
        this.retireExcessIdleRuntimes(runtimeId);
      }
      const workspacePath = normalizeSessionPath(memory.cwd);
      for (const [otherRuntimeId, snapshot] of this.runtimeSnapshots) {
        if (otherRuntimeId === runtimeId) continue;
        if (normalizeSessionPath(snapshot.session.cwd) === workspacePath) {
          this.dirtyRuntimes.add(otherRuntimeId);
        }
      }
    }
    if (runtimeId && event.type === "subagents_updated") {
      const wasSubagentBusy = this.subagentBusyRuntimes.has(runtimeId);
      const hasLiveSubagents = event.subagents.some((subagent) =>
        (subagent.status === "pending" || subagent.status === "running") && subagent.controlReady === true,
      );
      if (hasLiveSubagents) this.subagentBusyRuntimes.add(runtimeId);
      else if (wasSubagentBusy) {
        this.subagentBusyRuntimes.delete(runtimeId);
        this.retireExcessIdleRuntimes(runtimeId);
      }
    }
    if (event.type === "model_provider_auth_updated" && event.state.status === "succeeded") {
      // Includes the runtime that just authenticated: it is the one most likely
      // to be holding a connection opened with the credential that just changed.
      this.refreshAllSessionModels();
    }
    const scopedEvent = runtimeId && event.type === "session_snapshot"
      ? { ...event, snapshot: this.decorateSnapshot(runtimeId, event.snapshot) }
      : event;
    this.send(runtimeId ? { runtimeId, event: scopedEvent } : { event: scopedEvent });
  }

  private decorateSnapshot(runtimeId: string, snapshot: SessionSnapshot): SessionSnapshot {
    const decorated = { ...snapshot, runtimeId };
    this.runtimeSnapshots.set(runtimeId, decorated);
    this.dirtyRuntimes.delete(runtimeId);
    if (snapshot.running) this.runningRuntimes.add(runtimeId);
    else this.runningRuntimes.delete(runtimeId);
    if (snapshot.runtimeInspection?.memory?.state === "running") this.memoryBusyRuntimes.add(runtimeId);
    else this.memoryBusyRuntimes.delete(runtimeId);
    // Subagent liveness is process-local. A persisted snapshot may contain a
    // run interrupted by an earlier process, so only live activity events can
    // pin a runtime in memory.
    this.runtimeAccess.set(runtimeId, Date.now());
    if (snapshot.session.path) {
      const normalizedPath = normalizeSessionPath(snapshot.session.path);
      this.sessionPaths.set(normalizedPath, runtimeId);
      this.runtimePaths.set(runtimeId, normalizedPath);
    }
    return decorated;
  }

  private touchRuntime(runtimeId: string): void {
    this.runtimeAccess.set(runtimeId, Date.now());
  }

  private removeRuntimeReferences(runtimeId: string): CoilCoilRuntime | undefined {
    const runtime = this.runtimes.get(runtimeId);
    if (runtime) this.send({ runtimeId, event: { type: "runtime_released" } });
    this.runtimes.delete(runtimeId);
    this.runtimeAccess.delete(runtimeId);
    this.runningRuntimes.delete(runtimeId);
    this.memoryBusyRuntimes.delete(runtimeId);
    this.subagentBusyRuntimes.delete(runtimeId);
    this.dirtyRuntimes.delete(runtimeId);
    this.runtimeSnapshots.delete(runtimeId);
    const sessionPath = this.runtimePaths.get(runtimeId);
    this.runtimePaths.delete(runtimeId);
    if (sessionPath && this.sessionPaths.get(sessionPath) === runtimeId) this.sessionPaths.delete(sessionPath);
    if (this.defaultRuntimeId === runtimeId) this.defaultRuntimeId = undefined;
    return runtime;
  }

  private retireExcessIdleRuntimes(protectedRuntimeId: string): void {
    const idleRuntimeIds = [...this.runtimes.keys()]
      .filter((runtimeId) => !this.runningRuntimes.has(runtimeId)
        && !this.memoryBusyRuntimes.has(runtimeId)
        && !this.subagentBusyRuntimes.has(runtimeId))
      .sort((left, right) => (this.runtimeAccess.get(left) ?? 0) - (this.runtimeAccess.get(right) ?? 0));
    let excess = idleRuntimeIds.length - MAX_RETAINED_IDLE_SESSION_RUNTIMES;
    if (excess <= 0) return;
    for (const runtimeId of idleRuntimeIds) {
      if (excess <= 0) break;
      if (runtimeId === protectedRuntimeId || runtimeId === this.defaultRuntimeId) continue;
      const runtime = this.removeRuntimeReferences(runtimeId);
      if (!runtime) continue;
      excess -= 1;
      void runtime.dispose().catch((error) => {
        this.send({ event: { type: "runtime_error", message: `旧会话运行时清理失败：${errorMessage(error)}` } });
      });
    }
  }

  private runtimeById(runtimeId: string): CoilCoilRuntime {
    const runtime = this.runtimes.get(runtimeId);
    if (!runtime) throw new Error("所选会话运行时已失效，请重新打开会话。");
    return runtime;
  }

  private selectedRuntime(runtimeId?: string): CoilCoilRuntime {
    if (runtimeId) return this.runtimeById(runtimeId);
    if (this.defaultRuntimeId) return this.runtimeById(this.defaultRuntimeId);
    return this.runtime;
  }

  private async openWorkspace(cwd: string): Promise<{ sessions: SessionSummary[]; snapshot?: SessionSnapshot }> {
    const sessions = await this.runtime.listSessions(cwd);
    const current = this.defaultRuntimeId ? this.runtimeSnapshots.get(this.defaultRuntimeId) : undefined;
    const sessionPath = selectWorkspaceSessionPath(sessions, current, cwd, normalizeSessionPath);
    if (!sessionPath) {
      // A workspace restore without a valid current session is intentionally an
      // empty composer state. Never let the pinned-first list order turn this
      // into an unexpected navigation to a historical conversation.
      this.defaultRuntimeId = undefined;
      this.desiredSessionPath = undefined;
      return { sessions };
    }
    return { sessions, snapshot: await this.openSession(cwd, sessionPath) };
  }

  private async createSession(
    cwd: string,
    model?: Extract<RuntimeCommand, { type: "create_session" }>["model"],
    agentMode?: Extract<RuntimeCommand, { type: "create_session" }>["agentMode"],
  ): Promise<SessionSnapshot> {
    // Creating a blank conversation is a newer navigation intent than any
    // historical restore that may still be queued or running.
    this.desiredSessionPath = undefined;
    const runtimeId = this.createRuntimeId();
    const runtime = this.createManagedRuntime(runtimeId, this.runtime.sharedModelRuntime());
    this.runtimes.set(runtimeId, runtime);
    try {
      const snapshot = this.decorateSnapshot(runtimeId, await runtime.createSession(cwd, model, agentMode));
      this.defaultRuntimeId = runtimeId;
      this.retireExcessIdleRuntimes(runtimeId);
      return snapshot;
    } catch (error) {
      this.removeRuntimeReferences(runtimeId);
      await runtime.dispose().catch(() => undefined);
      throw error;
    }
  }

  private async openSession(cwd: string, sessionPath: string): Promise<SessionSnapshot> {
    const normalizedPath = normalizeSessionPath(sessionPath);
    this.desiredSessionPath = normalizedPath;
    const existingId = this.sessionPaths.get(normalizedPath);
    if (existingId && this.runtimes.has(existingId)) {
      this.defaultRuntimeId = existingId;
      this.touchRuntime(existingId);
      const cached = this.runtimeSnapshots.get(existingId);
      if (cached && !this.dirtyRuntimes.has(existingId)) return cached;
      return this.decorateSnapshot(existingId, await this.runtimeById(existingId).snapshot());
    }
    const opening = this.openingSessions.get(normalizedPath);
    if (opening) return opening;

    let releaseSlot = (): void => undefined;
    const slot = new Promise<void>((resolveSlot) => { releaseSlot = resolveSlot; });
    const predecessor = this.sessionOpenTail.catch(() => undefined);
    this.sessionOpenTail = predecessor.then(() => slot);

    let task!: Promise<SessionSnapshot>;
    task = (async () => {
      await predecessor;
      if (this.disposed || this.desiredSessionPath !== normalizedPath) {
        throw new Error(SESSION_OPEN_SUPERSEDED_ERROR);
      }

      const runtimeId = this.createRuntimeId();
      const runtime = this.createManagedRuntime(runtimeId, this.runtime.sharedModelRuntime());
      this.runtimes.set(runtimeId, runtime);
      this.touchRuntime(runtimeId);
      try {
        const snapshot = this.decorateSnapshot(runtimeId, await runtime.openSession(cwd, sessionPath));
        if (this.disposed) {
          throw new Error(SESSION_OPEN_SUPERSEDED_ERROR);
        }
        if (this.desiredSessionPath === normalizedPath) this.defaultRuntimeId = runtimeId;
        this.retireExcessIdleRuntimes(runtimeId);
        return snapshot;
      } catch (error) {
        this.removeRuntimeReferences(runtimeId);
        await runtime.dispose().catch(() => undefined);
        throw error;
      }
    })().finally(() => {
      if (this.openingSessions.get(normalizedPath) === task) this.openingSessions.delete(normalizedPath);
      releaseSlot();
    });
    this.openingSessions.set(normalizedPath, task);
    return task;
  }

  private async releaseSession(sessionPath: string): Promise<void> {
    const normalizedPath = normalizeSessionPath(sessionPath);
    const runtimeId = this.sessionPaths.get(normalizedPath);
    if (!runtimeId) return;
    const wasDefault = this.defaultRuntimeId === runtimeId;
    const runtime = this.removeRuntimeReferences(runtimeId);
    if (wasDefault) this.defaultRuntimeId = this.runtimes.keys().next().value;
    await runtime?.dispose();
  }

  private async dispatch(command: RuntimeCommand, runtimeId?: string): Promise<unknown> {
    if (command.type === "create_session") return this.createSession(command.cwd, command.model, command.agentMode);
    // Git 面板的操作只认工作区，不借用任何会话的运行时：会话被回收了也照样能用。
    if (command.type === "git") return runGitAction(command.cwd, command.action);
    if (command.type === "open_session") return this.openSession(command.cwd, command.sessionPath);
    if (command.type === "open_workspace") return this.openWorkspace(command.cwd);
    if (command.type === "move_session") {
      // Relocating rewrites the session header on disk, so the live runtime has
      // to let go of the file first; a still-open SessionManager would append
      // over the move. Releasing also tells the renderer to drop this session's
      // cached snapshot and workspace-scoped panels.
      const runtimeId = this.sessionPaths.get(normalizeSessionPath(command.sessionPath));
      if (runtimeId && this.runningRuntimes.has(runtimeId)) {
        throw new Error("请先停止正在运行的会话，再移动到其他工作区。");
      }
      await this.releaseSession(command.sessionPath);
      return this.dispatchTo(this.runtime, command);
    }

    const alwaysControl = command.type === "bootstrap"
      || command.type === "list_sessions"
      || command.type === "list_archived_sessions"
      || command.type === "archive_session"
      || command.type === "delete_session"
      || command.type === "delete_workspace_sessions"
      || command.type === "restore_session"
      || command.type === "configure_model"
      || command.type === "start_model_provider_oauth"
      || command.type === "respond_model_provider_oauth"
      || command.type === "cancel_model_provider_oauth";
    if ((command.type === "set_session_model" || command.type === "set_session_fast") && !runtimeId) {
      throw new Error("修改当前会话模型参数时缺少会话标识，请重新打开会话后再试。");
    }
    const addressedRuntimeGone = runtimeId !== undefined && !this.runtimes.has(runtimeId);
    const useControlRuntime = alwaysControl
      || (addressedRuntimeGone && answersFromWorkspaceConfiguration(command));
    const runtime = useControlRuntime ? this.runtime : this.selectedRuntime(runtimeId);
    const result = await this.dispatchTo(runtime, command);
    if (command.type === "archive_session" || command.type === "delete_session") {
      await this.releaseSession(command.sessionPath);
    }
    if (
      command.type === "save_openai_responses_ws_configuration"
      || command.type === "save_model_provider_configuration"
      || command.type === "remove_model_provider_configuration"
      || command.type === "remove_provider_auth"
      // configure_model persists the context-window override, which open
      // sessions carry on their own Model snapshot.
      || command.type === "configure_model"
    ) {
      this.refreshAllSessionModels();
    }
    return result;
  }

  /**
   * Rebind every open session to the saved configuration.
   *
   * This deliberately includes the runtime that handled the save. Settings sends
   * the current runtimeId, so excluding the handler meant the conversation the
   * user was editing config from was the only one left on the stale model — the
   * exact opposite of what they were asking for.
   */
  private refreshAllSessionModels(): void {
    this.runtime.refreshSessionModelFromRegistry();
    for (const sessionRuntime of this.runtimes.values()) {
      if (sessionRuntime === this.runtime) continue;
      sessionRuntime.refreshSessionModelFromRegistry();
    }
  }

  private dispatchTo(runtime: CoilCoilRuntime, command: Exclude<RuntimeCommand, { type: "create_session" } | { type: "open_session" } | { type: "open_workspace" }>): Promise<unknown> {
    switch (command.type) {
      case "bootstrap":
        return runtime.initialize();
      case "get_configuration":
        return runtime.getConfiguration();
      case "get_openai_responses_ws_configuration":
        return runtime.getOpenAIResponsesWsConfiguration();
      case "save_openai_responses_ws_configuration":
        return runtime.saveOpenAIResponsesWsConfiguration(command.input);
      case "get_model_provider_configuration":
        return runtime.getModelProviderConfiguration();
      case "save_model_provider_configuration":
        return runtime.saveModelProviderConfiguration(command.input);
      case "remove_model_provider_configuration":
        return runtime.removeModelProviderConfiguration(command.provider);
      case "configure_model":
        return runtime.configureModel(command);
      case "set_session_model":
        return runtime.setSessionModel(command);
      case "set_session_fast":
        return runtime.setSessionFast(command.enabled);
      case "set_tool_purpose_audit_enabled":
        return runtime.setToolPurposeAuditEnabled(command.enabled);
      case "remove_provider_auth":
        return runtime.removeProviderAuth(command.provider);
      case "start_model_provider_oauth":
        return runtime.startModelProviderOAuth(command.provider);
      case "respond_model_provider_oauth":
        return runtime.respondModelProviderOAuth(command.flowId, command.promptId, command.value);
      case "cancel_model_provider_oauth":
        return runtime.cancelModelProviderOAuth(command.flowId);
      case "fetch_provider_models":
        return runtime.fetchProviderModels(command.input);
      case "test_provider_connection":
        return runtime.testProviderConnection(command.input);
      case "get_mcp_configuration":
        return runtime.getMcpConfiguration(command.cwd);
      case "get_mcp_json":
        return runtime.getMcpJson();
      case "save_mcp_json":
        return runtime.saveMcpJson(command.content, command.cwd);
      case "get_mcp_status":
        return runtime.getMcpStatus();
      case "save_mcp_server":
        return runtime.saveMcpServer(command.server, command.previousName, command.cwd);
      case "remove_mcp_server":
        return runtime.removeMcpServer(command.name, command.scope, command.cwd);
      case "set_mcp_server_enabled":
        return runtime.setMcpServerEnabled(command.name, command.enabled, command.cwd);
      case "enable_mcp_imports":
        return runtime.enableMcpImports(command.imports, command.cwd);
      case "discover_mcp_servers":
        return runtime.discoverMcpServers(command.cwd);
      case "import_mcp_servers":
        return runtime.importMcpServers(command.input);
      case "connect_mcp_server":
        return runtime.connectMcpServer(command.name);
      case "start_mcp_auth":
        return runtime.startMcpAuth(command.name);
      case "await_mcp_auth":
        return runtime.awaitMcpAuthCallback(command.name);
      case "finish_mcp_auth":
        return runtime.finishMcpAuth(command.name);
      case "cancel_mcp_auth":
        return runtime.cancelMcpAuth(command.name);
      case "complete_mcp_auth":
        return runtime.completeMcpAuth(command.name, command.input);
      case "logout_mcp_server":
        return runtime.logoutMcpServer(command.name);
      case "get_memory_configuration":
        return runtime.getMemoryConfiguration(command.cwd);
      case "save_memory_configuration":
        return runtime.saveMemoryConfiguration(command.input, command.cwd);
      case "get_subagent_configuration":
        return runtime.getSubagentConfiguration();
      case "get_session_naming_configuration":
        return runtime.getSessionNamingConfiguration();
      case "get_summarization_model_configuration":
        return runtime.getSummarizationModelConfiguration();
      case "save_summarization_model_configuration":
        return runtime.saveSummarizationModelConfiguration(command.input);
      case "save_session_naming_configuration":
        return runtime.saveSessionNamingConfiguration(command.input);
      case "save_subagent_configuration":
        return runtime.saveSubagentConfiguration(command.input);
      case "get_skill_configuration":
        return runtime.getSkillConfiguration(command.cwd);
      case "set_skill_enabled":
        return runtime.setSkillEnabled(command.filePath, command.enabled, command.cwd);
      case "remove_skill":
        return runtime.removeSkill(command.filePath, command.cwd);
      case "delete_skill":
        return runtime.deleteSkill(command.filePath, command.cwd);
      case "add_skill_path":
        return runtime.addSkillPath(command.path, command.cwd);
      case "remove_skill_path":
        return runtime.removeSkillPath(command.path, command.cwd);
      case "set_enable_skill_commands":
        return runtime.setEnableSkillCommands(command.enabled, command.cwd);
      case "get_runtime_inspection":
        return runtime.getRuntimeInspection();
      case "set_session_system_prompt":
        return runtime.setSessionSystemPrompt(command.prompt);
      case "set_session_skill_enabled":
        return runtime.setSessionSkillEnabled(command.filePath, command.enabled);
      case "set_session_mcp_server_enabled":
        return runtime.setSessionMcpServerEnabled(command.name, command.enabled);
      case "approve_plan":
        return runtime.approvePlan(command.planId, command.target, command.agent);
      case "reject_plan":
        return runtime.rejectPlan(command.planId);
      case "run_memory_now":
        return runtime.runMemoryNow();
      case "run_compaction_now":
        return runtime.compactNow(command.instructions);
      case "remove_original_session_item":
        return runtime.removeOriginalSessionItem(command.entryId);
      case "stop_subagent":
        return runtime.stopSubagent(command.id, command.background);
      case "resume_subagent":
        return runtime.resumeSubagent(command.id);
      case "list_sessions":
        return runtime.listSessions(command.cwd);
      case "list_archived_sessions":
        return runtime.listArchivedSessions(command.cwd);
      case "archive_session":
        return runtime.archiveSession(command.cwd, command.sessionPath);
      case "delete_session":
        return runtime.deleteSession(command.cwd, command.sessionPath);
      case "delete_workspace_sessions":
        return runtime.deleteWorkspaceSessions(command.cwd);
      case "restore_session":
        return runtime.restoreSession(command.cwd, command.sessionPath);
      case "rename_session":
        return runtime.renameSession(command.cwd, command.sessionPath, command.name);
      case "pin_session":
        return runtime.pinSession(command.cwd, command.sessionPath, command.pinned);
      case "fork_session":
        return runtime.forkSession(command.cwd, command.sessionPath);
      case "move_session":
        return runtime.moveSession(command.cwd, command.sessionPath, command.targetCwd);
      case "prompt":
        return runtime.prompt(command.text, command.images, command.clientMessageId, command.promptDocument);
      case "rewind_prompt":
        return runtime.rewindPrompt(command.entryId, command.text, command.images, command.clientMessageId, command.promptDocument, command.restoreCode === true);
      case "rewind_preview":
        return runtime.rewindPreview(command.entryId);
      case "steer":
        return runtime.steer(command.text, command.images, command.clientMessageId, command.promptDocument);
      case "abort":
        return runtime.abort();
      case "stop_goal":
        return runtime.stopGoal();
      case "cancel_queued_prompt":
        return runtime.cancelQueuedPrompt(command.id);
      case "promote_queued_prompt":
        return runtime.promoteQueuedPrompt(command.id);
      case "refresh_project":
        return runtime.refreshProject();
      case "list_directory":
        return runtime.listProjectDirectory(command.path);
      case "read_file":
        return runtime.readProjectFile(command.path, command.maxBytes);
      case "git":
        return runGitAction(command.cwd, command.action);
      default: {
        const exhaustive: never = command;
        throw new Error(`未知运行时命令：${(exhaustive as { type?: string }).type ?? "unknown"}`);
      }
    }
  }

  async receive(value: unknown): Promise<void> {
    if (!isRuntimeCommandEnvelope(value)) return;
    this.send(await this.handle(value));
  }

  async warmup(): Promise<void> {
    await this.runtime.initialize();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.desiredSessionPath = undefined;
    for (const runtimeId of this.runtimes.keys()) {
      // Telling clients is a courtesy; closing the runtimes is the job. A sink
      // that fails here (the parent is usually already gone by shutdown) must
      // not stop the disposal below.
      try {
        this.send({ runtimeId, event: { type: "runtime_released" } });
      } catch (error) {
        this.log.warn("process", "release_notice_failed", { runtimeId, message: errorMessage(error) });
      }
    }
    await Promise.allSettled([
      this.runtime.dispose(),
      ...[...this.runtimes.values()].map((runtime) => runtime.dispose()),
    ]);
    this.runtimes.clear();
    this.sessionPaths.clear();
    this.runtimePaths.clear();
    this.runtimeAccess.clear();
    this.runningRuntimes.clear();
    this.memoryBusyRuntimes.clear();
    this.subagentBusyRuntimes.clear();
    this.dirtyRuntimes.clear();
    this.runtimeSnapshots.clear();
    this.openingSessions.clear();
    this.defaultRuntimeId = undefined;
  }
}

export function runtimeOptionsFromEnvironment(): CoilCoilRuntimeOptions {
  const agentDir = process.env.COILCOIL_AGENT_DIR;
  const sessionDir = process.env.COILCOIL_SESSION_DIR;
  if (!agentDir || !sessionDir) {
    throw new Error("COILCOIL_AGENT_DIR and COILCOIL_SESSION_DIR are required.");
  }
  return {
    agentDir,
    sessionDir,
    workflowDir: process.env.COILCOIL_WORKFLOW_DIR,
    legacyAgentDir: process.env.COILCOIL_LEGACY_AGENT_DIR,
  };
}

/**
 * Write to the parent over IPC, tolerating a channel that is already gone.
 *
 * Shutdown starts from `disconnect`: by the time we run, the channel is closed —
 * and `dispose()` still has to tell clients their runtimes were released, so it
 * writes into it. `process.send()` without a callback reports that failure by
 * emitting `error` on `process`, which has no listener, so it arrived as an
 * uncaught exception; with `exitOnUncaught` that killed the process in the
 * middle of `dispose()`, skipping the very cleanup dispose exists to do. It
 * happened on every quit — 53 entries in the user's log before this was fixed.
 *
 * Passing a callback keeps the failure local to the call, and checking
 * `connected` first skips the write entirely once the parent is gone.
 */
function sendOverProcessIpc(message: RuntimeWireMessage): void {
  if (!process.connected || typeof process.send !== "function") return;
  try {
    process.send(message, undefined, undefined, () => undefined);
  } catch {
    // The channel closed between the check and the write; nothing to deliver to.
  }
}

export function attachProcessIpc(options = runtimeOptionsFromEnvironment()): RuntimeServer {
  if (typeof process.send !== "function") throw new Error("The runtime process requires an IPC channel.");
  const server = new RuntimeServer(options, sendOverProcessIpc);
  // An uncaught exception here already ended the process and told the user only
  // "runtime exited with code 1"; keep that ending, and add the reason.
  installProcessErrorHandlers(server.log, { exitOnUncaught: true });
  server.log.info("process", "runtime_started", processStartupData({ agentDir: options.agentDir }));
  void server.warmup().catch((error) => {
    server.log.error("process", "warmup_failed", error);
    process.stderr.write(`[coilcoil-runtime] warmup failed: ${errorMessage(error)}\n`);
  });
  process.on("message", (message) => {
    void server.receive(message);
  });
  const shutdown = (): void => {
    // A dispose that throws used to vanish into an unhandled rejection while the
    // process exited anyway; the runtimes it failed to close left no trace.
    void server.dispose()
      .catch((error) => server.log.error("process", "shutdown_failed", error))
      .finally(() => process.exit(0));
  };
  process.once("disconnect", shutdown);
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  return server;
}

export function attachJsonlStdio(options = runtimeOptionsFromEnvironment()): RuntimeServer {
  const server = new RuntimeServer(options, (message) => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  });
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (line) => {
    try {
      void server.receive(JSON.parse(line));
    } catch (error) {
      process.stdout.write(
        `${JSON.stringify({ id: "invalid", ok: false, error: `Invalid JSON: ${errorMessage(error)}` })}\n`,
      );
    }
  });
  input.once("close", () => {
    void server.dispose();
  });
  return server;
}
