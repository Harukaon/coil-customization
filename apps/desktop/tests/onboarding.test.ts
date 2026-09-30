import assert from "node:assert/strict";
import test from "node:test";
import {
  advance,
  canSkip,
  goBack,
  INITIAL_ONBOARDING,
  isLastStep,
  ONBOARDING_STEPS,
  onboardingStepsFor,
  PERMISSION_TOPICS,
  type OnboardingProgress,
  stepIndex,
} from "../src/renderer/src/features/onboarding/onboardingSteps.ts";

test("引导顺序固定，第一步是介绍，最后一步是挂工作区", () => {
  assert.deepEqual([...ONBOARDING_STEPS], ["intro", "model", "agents", "memory", "permissions", "workspace"]);
  assert.equal(INITIAL_ONBOARDING.step, "intro");
  assert.equal(isLastStep("workspace"), true);
  assert.equal(isLastStep("permissions"), false);
});

test("任何一步都走得下去，引导不会把人卡住", () => {
  // 权限页只介绍每项用途，不要求逐项表态；配置页也都允许跳过。
  // 之后我们什么也不做——等于造了一个没有作用的选择，再拿它把用户挡在门外。用户卡在
  // 那一页出不去：「为什么必须让我选一个场景继续啊？这些是可选的」。
  let progress: OnboardingProgress = INITIAL_ONBOARDING;
  for (const expected of ["model", "agents", "memory", "permissions", "workspace"] as const) {
    const next = advance(progress);
    assert.notDeepEqual(next, progress, `${progress.step} 这一步走不下去了`);
    assert.equal(next.step, expected);
    progress = next;
  }
  // 最后一步之后没有下一步：真正的「完成」由界面调 onDone，不是再 advance 一次。
  assert.deepEqual(advance(progress), progress);
});

test("Windows 和 Linux 不展示无效的 macOS 权限页", () => {
  assert.deepEqual([...onboardingStepsFor("win32")], ["intro", "model", "agents", "memory", "workspace"]);
  assert.deepEqual([...onboardingStepsFor("linux")], ["intro", "model", "agents", "memory", "workspace"]);
  assert.equal(isLastStep("memory", onboardingStepsFor("win32")), false);
  assert.equal(isLastStep("workspace", onboardingStepsFor("win32")), true);
});

test("权限页只是介绍：四项彼此独立，每项都要说清用途", () => {
  // 「完全磁盘访问权限」不包含「App 管理」，也不包含「屏幕录制」——在 macOS 里是三个
  // 各自独立的开关，所以要一项一项地列。
  assert.deepEqual(PERMISSION_TOPICS.map((topic) => topic.id), ["full-disk", "screen-recording", "app-management", "accessibility"]);
  for (const topic of PERMISSION_TOPICS) {
    assert.ok(topic.name.length > 0, `${topic.id} 没有名字`);
    assert.ok(topic.purpose.length > 10, `${topic.id} 没把用途说清楚`);
  }
});

test("只有真的有事情要做的那两步才摆「跳过」", () => {
  // 介绍页和权限页看一眼就够，一个「继续」就行；再摆一个「跳过」反而让人以为漏了什么。
  // Private-deployment build: the model step cannot be skipped.
  assert.equal(canSkip("model"), false);
  assert.equal(canSkip("agents"), true);
  assert.equal(canSkip("memory"), true);
  assert.equal(canSkip("integrations"), true);
  assert.equal(canSkip("workspace"), true);
  assert.equal(canSkip("intro"), false);
  assert.equal(canSkip("permissions"), false);
});

test("往回走，走到第一步就停住", () => {
  assert.equal(goBack({ step: "workspace" }).step, "permissions");
  assert.equal(goBack({ step: "intro" }).step, "intro");
  assert.equal(stepIndex("intro"), 0);
});
