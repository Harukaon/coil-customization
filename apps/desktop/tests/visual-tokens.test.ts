import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

/*
 * 全局视觉约定的防回归：圆角和滚动条这两档阶梯，一处一个数字就没法整体调。
 *
 * 这里原来还盯着「浮层一律不描边、投影统一走令牌」，那是 #19 加的。用户实际
 * 用下来说「不如之前的效果」，让按 git 复原，所以描边和原来那组投影数值都回来了，
 * 对应的两条断言随之删掉——浮层带一圈细描边是用户选的样子，不要再当成缺陷去改。
 */

const rendererRoot = resolve(import.meta.dirname, "../src/renderer/src");
const read = (file: string): string => readFileSync(resolve(rendererRoot, file), "utf8");

const styles = read("styles.css");

/** 取出某条规则花括号里的声明。规则有单行写法也有多行写法，都按块匹配。 */
function declarations(css: string, selector: string, label: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`).exec(css);
  assert.ok(match, `${label} 里找不到 ${selector} 这条规则`);
  return match[1];
}

/* 圆角同理：一处一个数字，用户说一句「再圆一点」就得满仓库改。
   所以除了几个不参与阶梯的特例，圆角一律引用 --radius-* 令牌。 */

const RADIUS_SHEETS = [
  "styles.css",
  "bubble.css",
  "mobile.css",
  "ui/dialog/dialog.css",
  "ui/toast/toast.css",
  "features/settings/settings.css",
  "features/composer/mobile-model-picker.css",
  "features/memory/memory.css",
  "features/files/preview.css",
  "features/terminal/terminal.css",
];

// 不参与阶梯的写法：正圆、跟随父级、直角，以及 2~3px 这种「几乎是直角」的小色块。
const RADIUS_EXEMPT = /^(0|50%|100%|inherit|2px|3px|2px 2px 0 0)$/;

test("圆角一律走 --radius-* 令牌，不散落具体数值", () => {
  for (const sheet of RADIUS_SHEETS) {
    for (const [, value] of read(sheet).matchAll(/border-radius:\s*([^;}]+)/g)) {
      const trimmed = value.trim();
      if (RADIUS_EXEMPT.test(trimmed)) continue;
      for (const part of trimmed.split(/\s+/)) {
        assert.ok(
          part === "0" || part.startsWith("var(--radius-"),
          `${sheet} 里还有写死的圆角：border-radius: ${trimmed}`,
        );
      }
    }
  }
});

test("--radius-* 是一条从小到大的阶梯，档与档之间没有拉平", () => {
  const root = declarations(styles, ":root", "styles.css");
  const steps = ["xs", "sm", "md", "lg", "xl", "2xl", "3xl", "4xl", "5xl", "6xl", "7xl", "8xl", "9xl"];
  const values = steps.map((step) => {
    const match = new RegExp(`--radius-${step}:\\s*(\\d+)px`).exec(root);
    assert.ok(match, `styles.css 的 :root 里没有 --radius-${step}`);
    return Number.parseInt(match[1], 10);
  });
  for (let i = 1; i < values.length; i += 1) {
    assert.ok(values[i] > values[i - 1], `--radius-${steps[i]} 没有比 --radius-${steps[i - 1]} 大，阶梯被拉平了`);
  }
  // 最小的一档仍然是「圆角」而不是胶囊，最大的一档也还看得出是个矩形。
  assert.ok(values[0] >= 4 && values[values.length - 1] <= 24);
  assert.match(root, /--radius-pill:\s*999px/);
});

test("滚动条滑块三态是一档比一档实，但都很淡", () => {
  const root = declarations(styles, ":root", "styles.css");
  const alphas = ["", "-hover", "-active"].map((state) => {
    const match = new RegExp(`--scrollbar-thumb${state}:[^;]*\\/\\s*(\\d+)%\\)`).exec(root);
    assert.ok(match, `styles.css 的 :root 里没有 --scrollbar-thumb${state}`);
    return Number.parseInt(match[1], 10);
  });
  assert.ok(alphas[0] < alphas[1] && alphas[1] < alphas[2], "静止 < 悬浮 < 按下，这个次序不能乱");
  // 用户嫌深过一次：静止那一档只能是个影子，最实的一档也不许压过正文。
  assert.ok(alphas[0] <= 22, `静止态 ${alphas[0]}% 太深`);
  assert.ok(alphas[2] <= 48, `按下态 ${alphas[2]}% 太深`);
});

/* 「排队中」和「介入中」这两个还没送到的状态，用户指名要虚线边框。这里盯着它，
   因为它被顺手改掉过一次：那次是在做「聊天气泡一律不描边」，连带把这两条也去了。 */

test("还没送到的两种消息用虚线边框标出来", () => {
  for (const state of ["queued", "steering"]) {
    const block = declarations(styles, `.user-bubble.${state}`, "styles.css");
    assert.match(block, /border:\s*1px dashed /, `.user-bubble.${state} 的虚线边框没了`);
  }
});
