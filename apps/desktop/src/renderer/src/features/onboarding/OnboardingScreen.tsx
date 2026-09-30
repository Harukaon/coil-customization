import { FolderOpen, FolderTree } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { RuntimeConfiguration } from "@coilcoil/runtime-protocol";
import type { MacPermissions, ProjectSelection } from "../../../../shared/desktop-api";
import { rendererPlatform } from "../../platform";
import { SparkAiEditor } from "../settings/SparkAiEditor";
import { WindowDragBar } from "../../ui/WindowDragBar";
import { OnboardingAgentSetup } from "./OnboardingAgentSetup";
import { OnboardingIntegrationsSetup } from "./OnboardingIntegrationsSetup";
import { OnboardingMemorySetup } from "./OnboardingMemorySetup";
import {
  advance,
  canSkip,
  goBack,
  INITIAL_ONBOARDING,
  isLastStep,
  ONBOARDING_STEP_LABELS,
  onboardingStepsFor,
  PERMISSION_TOPICS,
  type OnboardingProgress,
  type OnboardingStepId,
  stepIndex,
} from "./onboardingSteps";
import "./onboarding.css";

/** 引导各步的标题和导语。集中一处，保证标题块始终一致。 */
const HEADINGS: Record<OnboardingStepId, { title: React.ReactNode; lead: string }> = {
  intro: {
    title: <>让 AI 和你<br />待在同一个界面里</>,
    lead: "它开的网页、跑的命令、改的文件都在你眼前，而不是在你看不见的地方。",
  },
  model: {
    title: "配一个模型",
    lead: "填上 API Key，保存后就能开始使用。",
  },
  agents: {
    title: "把 Agent 配完整",
    lead: "子 Agent 和会话命名可以用独立模型。这里不配置也不影响主 Agent，之后可以在设置里补上。",
  },
  memory: {
    title: "决定记忆怎么工作",
    lead: "选择要不要把全局记忆、项目记忆注入对话，以及后台整理的频率和规则。",
  },
  integrations: {
    title: "接入 MCP 和 Skill",
    lead: "扫描这台机器已有的 MCP 配置，查看 CoilCoil 发现的 Skill；导入后由 CoilCoil 自己管理。",
  },
  permissions: {
    title: "系统权限",
    lead: "下面每一项在 macOS 里都是独立的开关，给不给都由你定。这里只说明它可能被用来做什么——macOS 拒绝的时候不会报错，功能只会悄悄消失。",
  },
  workspace: {
    title: "挂一个工作区",
    lead: "选一个本地文件夹，CoilCoil 就在它里面干活。之后在左侧栏随时能再加，现在跳过也行。",
  },
};

/** 三条产品理念。放在这里而不是散在 JSX 里，改文案不用动结构。 */
const PRINCIPLES: readonly { label: string; body: string }[] = [
  { label: "同一个界面", body: "Agent 打开的网页、跑的终端、改的文件，都画在你眼前那一排标签里。你随时能点进去接着用，也能直接关掉。" },
  { label: "一区一世界", body: "每个工作区各自的会话、浏览器登录状态和记忆互不串门。换一个项目，就是换一整套环境。" },
  { label: "在你机器上", body: "读你本地的目录，用你已经登录好的浏览器。代码不用搬走，东西还是你的。" },
];

/**
 * 首次启动的引导。整屏一层，走完才进工作区，设置里可以随时重来。
 *
 * 规则（哪几步、哪一步能跳、问哪些权限）在 onboardingSteps.ts，这里只管画。唯一的
 * 硬约束是权限那一步每一项都要表态——原因写在那个文件里。
 *
 * 视觉上刻意不用卡片和描边：分隔靠留白和发丝线，背景是一团慢慢飘的墨，和产品自己
 * 那个墨团标志是同一套语言。
 */
export function OnboardingScreen({ configuration, onConfigurationSaved, runtimeId, cwd, projects, onOpenProject, onDone }: {
  configuration?: RuntimeConfiguration;
  onConfigurationSaved: (configuration: RuntimeConfiguration) => void;
  runtimeId?: string;
  cwd?: string;
  projects: ProjectSelection[];
  onOpenProject: () => void;
  onDone: () => void;
}): React.JSX.Element {
  const [progress, setProgress] = useState<OnboardingProgress>(INITIAL_ONBOARDING);
  const [permissions, setPermissions] = useState<MacPermissions>();
  const [modelReady, setModelReady] = useState(false);
  const steps = onboardingStepsFor(rendererPlatform());

  const refresh = useCallback(() => {
    if (typeof window.coilcoil?.getMacPermissions !== "function") return;
    void window.coilcoil.getMacPermissions().then(setPermissions).catch(() => undefined);
  }, []);

  // 进到权限这一步就探一次；用户去系统设置点完再切回来，窗口重新拿到焦点时再探一次
  // ——授权之后不用他自己回来按刷新。
  useEffect(() => {
    if (progress.step !== "permissions") return;
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [progress.step, refresh]);

  const index = stepIndex(progress.step, steps);
  const next = (): void => {
    if (isLastStep(progress.step, steps)) onDone();
    else setProgress(advance(progress, steps));
  };

  return (
    <main className="onboarding-screen" aria-labelledby="onboarding-title">
      <div className="onboarding-ink" aria-hidden="true"><i /><i /><i /></div>
      <div className="onboarding-drag window-drag-bar"><WindowDragBar /></div>

      <div className="onboarding-stage">
        <div className="onboarding-inner">
          <nav className="onboarding-rail" aria-label="引导进度">
            {steps.map((step, position) => (
              <span className={position < index ? "done" : position === index ? "current" : ""} key={step}>
                {ONBOARDING_STEP_LABELS[step]}
              </span>
            ))}
          </nav>

          <section className="onboarding-step" key={progress.step}>
            <span className="onboarding-mark" aria-hidden="true">{index + 1}</span>

            {/* 标题块共用同一份结构，换步只换文字。 */}
            <div className="onboarding-headline">
              <h1 id="onboarding-title">{HEADINGS[progress.step].title}</h1>
              <p>{HEADINGS[progress.step].lead}</p>
            </div>

            <div className={`onboarding-body ${["agents", "memory", "integrations"].includes(progress.step) ? "stretch" : ""}`}>
              {progress.step === "intro" ? (
                <div className="onboarding-lines">
                  {PRINCIPLES.map((line, position) => (
                    <div className="onboarding-rise" key={line.label} style={{ "--i": position } as React.CSSProperties}>
                      <strong>{line.label}</strong>
                      <span>{line.body}</span>
                    </div>
                  ))}
                </div>
              ) : null}

              {progress.step === "model" ? (
                <SparkAiEditor onConfiguredChange={setModelReady} onSaved={onConfigurationSaved} runtimeId={runtimeId} />
              ) : null}

              {progress.step === "agents" ? (
                <div className="onboarding-embed onboarding-setup-embed">
                  <OnboardingAgentSetup configuration={configuration} runtimeId={runtimeId} />
                </div>
              ) : null}

              {progress.step === "memory" ? (
                <div className="onboarding-embed onboarding-setup-embed">
                  <OnboardingMemorySetup runtimeId={runtimeId} cwd={cwd} />
                </div>
              ) : null}

              {progress.step === "integrations" ? (
                <div className="onboarding-embed onboarding-setup-embed onboarding-integrations-embed">
                  <OnboardingIntegrationsSetup runtimeId={runtimeId} cwd={cwd} />
                </div>
              ) : null}

              {progress.step === "permissions" ? (
                <div className="onboarding-permissions">
                  {PERMISSION_TOPICS.map((topic, position) => {
                    const granted = permissions?.status[topic.id] === "granted";
                    return (
                      <div className="onboarding-permission onboarding-rise" key={topic.id} style={{ "--i": position } as React.CSSProperties}>
                        <div className="onboarding-permission-name">
                          {topic.name}
                          {granted ? <em>已开启</em> : null}
                        </div>
                        <p className="onboarding-permission-purpose">{topic.purpose}</p>
                        <div className="onboarding-permission-actions">
                          {/* 只有一个动作：去系统设置里开。开不开都能继续，这一页只是介绍。 */}
                          <button type="button" onClick={() => void window.coilcoil.openPermissionSettings(topic.id)}>
                            {granted ? "去设置里看看" : "去开启"}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : null}

              {progress.step === "workspace" ? (
                <div className="onboarding-workspace">
                  <button className="onboarding-pick" type="button" onClick={onOpenProject}><FolderOpen size={15} />选择文件夹</button>
                  {projects.length ? (
                    <ul className="onboarding-mounted">
                      {projects.map((item) => (
                        <li key={item.path}><FolderTree size={14} />{item.name}<small>{item.path}</small></li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </div>
          </section>
        </div>
      </div>

      <footer className="onboarding-footer">
        {index > 0 ? <button className="onboarding-back" type="button" onClick={() => setProgress(goBack(progress, steps))}>上一步</button> : null}
        <span className="spacer" />
        {canSkip(progress.step) ? <button className="onboarding-skip" type="button" onClick={next}>跳过这一步</button> : null}
        <button className="onboarding-next" type="button" disabled={progress.step === "model" && !modelReady} onClick={next}>
          {isLastStep(progress.step) ? "开始使用" : "继续"}
        </button>
      </footer>
    </main>
  );
}
