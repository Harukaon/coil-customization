import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

/**
 * Form controls come from one place (renderer/src/ui/form) and get their look from a class,
 * never from where they sit. These checks keep that true; the reasoning is at the top of
 * ui/form/form.css. To see that a style change moved nothing on screen, run the form-audit
 * scenario before and after (scripts/e2e/scenarios/form-audit.mjs).
 */
const root = join(import.meta.dirname, "../src/renderer/src");

function walk(dir: string, extension: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path, extension);
    return path.endsWith(extension) ? [path] : [];
  });
}

test("pages use the shared controls instead of a bare <input> or <textarea>", () => {
  const offenders = walk(root, ".tsx")
    .filter((file) => !relative(root, file).startsWith("ui/form/"))
    .flatMap((file) => readFileSync(file, "utf8").split("\n").flatMap((line, index) => (/<(input|textarea)\b/.test(line) ? [`${relative(root, file)}:${index + 1}`] : [])));
  assert.deepEqual(offenders, [], "use TextField / TextArea / Checkbox from ui/form (look=\"plain\" when the surrounding component draws the box)");
});

/** The selector list ("a, b, c") of every rule, whitespace collapsed. */
function preludes(css: string): string[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...text.matchAll(/([^{}]+)\{/g)].map((match) => match[1].trim().replace(/\s+/g, " ")).filter((prelude) => !prelude.startsWith("@"));
}

/** These reach every control inside them on purpose: the reset, drag behaviour and the models page's focus policy. */
const CONTAINER_RULES_ALLOWED = new Set([
  "button, textarea, input, select",
  ".no-drag, button, textarea, input, select",
  "button:focus-visible, textarea:focus-visible, input:focus-visible, select:focus-visible",
  '.window-drag-bar input, .window-drag-bar textarea, .window-drag-bar [contenteditable="true"]',
  ".resizing-panels iframe, .resizing-panels textarea, .resizing-panels input",
  ".model-provider-settings :is(button, textarea, input):focus, .model-provider-settings :is(button, textarea, input):focus-visible",
]);

test("no stylesheet styles a bare input or textarea by the container it sits in", () => {
  const offenders: string[] = [];
  for (const file of walk(root, ".css")) {
    const name = relative(root, file);
    if (name.startsWith("theme-tokens") || name === "ui/form/form.css") continue;
    for (const selector of preludes(readFileSync(file, "utf8"))) {
      // A tag name counts as bare unless a class comes right after it: input.foo, input[type="number"].foo
      const bare = [...selector.matchAll(/(?<![\w.#-])(input|textarea)(?![\w-])/g)].some((hit) => {
        const rest = selector.slice(hit.index + hit[0].length);
        return !/^(\[[^\]]*\])*\./.test(rest);
      });
      if (bare && !CONTAINER_RULES_ALLOWED.has(selector)) offenders.push(`${name}: ${selector}`);
    }
  }
  assert.deepEqual(offenders, [], "put a class on the control (input.my-field { ... }) instead of styling '.container input'");
});

test("!important in the stylesheets only goes down", () => {
  const count = walk(root, ".css")
    .filter((file) => !relative(root, file).startsWith("theme-tokens"))
    .reduce((sum, file) => sum + (readFileSync(file, "utf8").match(/!important/g) ?? []).length, 0);
  // Was 24 before the form controls moved to one stylesheet; lower this when one is removed.
  assert.ok(count <= 13, `${count} uses of !important; the limit is 13`);
});

test("the form stylesheet loads before every other stylesheet", () => {
  const main = readFileSync(join(root, "main.tsx"), "utf8");
  const imports = [...main.matchAll(/^import\s+(?:[^"']*from\s+)?["']([^"']+)["'];?/gm)].map((match) => match[1]);
  assert.equal(imports[0], "./ui/form/form.css", "a class given to a control can only override the base if the base comes first");
});
