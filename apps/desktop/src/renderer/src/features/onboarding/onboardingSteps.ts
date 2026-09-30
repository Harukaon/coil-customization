import type { DesktopPlatform, MacPermissionId } from "../../../../shared/desktop-api";

/**
 * 首次启动的引导：有哪几步、每一步讲什么。
 *
 * 规则单独放一份是为了能被测到，界面改版不该把它一起改没了。
 */

export type OnboardingStepId = "intro" | "model" | "agents" | "memory" | "integrations" | "permissions" | "workspace";

export const ONBOARDING_STEPS: readonly OnboardingStepId[] = [
  "intro",
  "model",
  "agents",
  "memory",
  // Private-deployment build: the MCP/Skill step is not part of onboarding (skills are
  // bundled; MCP and skills stay reachable in Settings). Its screen code is untouched.
  "permissions",
  "workspace",
];

/** Windows/Linux 没有 macOS 那套权限开关，引导里不应展示一个无效的权限页。 */
export function onboardingStepsFor(platform: DesktopPlatform): readonly OnboardingStepId[] {
  return platform === "darwin" ? ONBOARDING_STEPS : ONBOARDING_STEPS.filter((step) => step !== "permissions");
}

/**
 * 引导里会介绍到的系统权限。
 *
 * 这一页**只是介绍**：说清楚每一项可能被用来做什么，给一个直达系统设置的入口，
 * 然后就可以继续。四项在 macOS 里是彼此独立的开关——「完全磁盘访问权限」既不包含
 * 「App 管理」也不包含「屏幕录制」——所以一项一项地列。
 *
 * 这里不做推荐，也不拦人。第一版做成了「每一项都要选给还是不给，选完才能继续」，
 * 而那个「不用」按钮点完之后我们什么也不做，等于造了一个没有作用的选择再拿它把用户
 * 挡在门外。用户的原话：「为什么必须让我选一个场景继续啊？这些是可选的」。
 */
export interface PermissionTopic {
  id: MacPermissionId;
  name: string;
  /** Agent 可能拿它来做什么。一句话，说事实，不劝。 */
  purpose: string;
}

export const PERMISSION_TOPICS: readonly PermissionTopic[] = [
  { id: "full-disk", name: "完全磁盘访问权限", purpose: "读系统保护起来的目录，以及把你已有浏览器的登录状态导进内置浏览器。" },
  { id: "screen-recording", name: "屏幕录制与截屏", purpose: "Agent 想看一眼页面真正渲染成什么样，或者录一段复现步骤。macOS 把截屏和录屏放在同一个开关里。" },
  { id: "app-management", name: "App 管理", purpose: "让 Agent 改动或更新「应用程序」里的 App。这一项不包含在完全磁盘访问权限里。" },
  { id: "accessibility", name: "辅助功能", purpose: "让 Agent 代你点按、输入，去操作别的 App。" },
];

export interface OnboardingProgress {
  step: OnboardingStepId;
}

export const INITIAL_ONBOARDING: OnboardingProgress = { step: "intro" };

export function stepIndex(step: OnboardingStepId, steps: readonly OnboardingStepId[] = ONBOARDING_STEPS): number {
  return steps.indexOf(step);
}

export function isLastStep(step: OnboardingStepId, steps: readonly OnboardingStepId[] = ONBOARDING_STEPS): boolean {
  return stepIndex(step, steps) === steps.length - 1;
}

/**
 * 这一步有没有「跳过」按钮。
 *
 * 模型和工作区有：这两步真的有事情要做，明说一句「不做也行」比让人猜要好。介绍页和
 * 权限页没有——它们本来就只是看一眼，一个「继续」就够了，再摆一个「跳过」反而让人
 * 以为漏了什么。**每一步都能往下走，任何一步都不会把人卡住。**
 */
export function canSkip(step: OnboardingStepId): boolean {
  return step === "agents" || step === "memory" || step === "integrations" || step === "workspace";
}

export function advance(progress: OnboardingProgress, steps: readonly OnboardingStepId[] = ONBOARDING_STEPS): OnboardingProgress {
  const next = steps[stepIndex(progress.step, steps) + 1];
  return next ? { step: next } : progress;
}

export function goBack(progress: OnboardingProgress, steps: readonly OnboardingStepId[] = ONBOARDING_STEPS): OnboardingProgress {
  const previous = steps[stepIndex(progress.step, steps) - 1];
  return previous ? { step: previous } : progress;
}

export const ONBOARDING_STEP_LABELS: Record<OnboardingStepId, string> = {
  intro: "认识",
  model: "模型",
  agents: "Agent",
  memory: "记忆",
  integrations: "扩展",
  permissions: "权限",
  workspace: "工作区",
};
