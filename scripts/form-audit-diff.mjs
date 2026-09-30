#!/usr/bin/env node
// Compares two recordings from `npm run e2e -- form-audit` and prints every difference.
//   node scripts/form-audit-diff.mjs before.json after.json [--show=40]
//
// A native checkbox draws itself, so its padding, border, background and text properties change
// nothing on screen; those are left out for checkboxes (its size, position, accent colour and
// focus ring are still compared).
import { readFileSync } from "node:fs";

const [beforePath, afterPath, ...flags] = process.argv.slice(2);
if (!beforePath || !afterPath) {
  console.error("usage: form-audit-diff.mjs before.json after.json [--show=40]");
  process.exit(2);
}
const styleOnly = flags.includes("--style-only");
const show = Number(flags.find((flag) => flag.startsWith("--show="))?.slice(7) ?? 40);
const before = JSON.parse(readFileSync(beforePath, "utf8"));
const after = JSON.parse(readFileSync(afterPath, "utf8"));

const CHECKBOX_IGNORED = /^(padding|border|background|color$|(column|row)-rule-color|outline-color|font|line-height|letter-spacing|text-|word-spacing|-webkit-text|caret-color|outline-offset$|cursor$|-webkit-rtl-ordering|-webkit-border|inline-size|block-size|min-|max-|perspective-origin|transform-origin|margin-(inline|block))/;

function diffStyle(left, right, ignore) {
  const changes = [];
  for (const name of new Set([...Object.keys(left ?? {}), ...Object.keys(right ?? {})])) {
    if (ignore?.test(name)) continue;
    if (left?.[name] !== right?.[name]) changes.push(`${name}: ${left?.[name]} → ${right?.[name]}`);
  }
  return changes;
}

function compareEntry(a, b) {
  const ignore = a.tag === "input" && a.type === "checkbox" ? CHECKBOX_IGNORED : undefined;
  const changes = diffStyle(a.style, b.style, ignore);
  // A position moves by half a pixel when an animation is caught a frame apart; a size never should.
  const moved = a.box.some((value, index) => Math.abs(value - b.box[index]) > (index < 2 ? 0.5 : 0));
  if (moved) changes.push(`box: [${a.box}] → [${b.box}]`);
  if (a.placeholder && !ignore) changes.push(...diffStyle(a.placeholder, b.placeholder, undefined).map((item) => `placeholder ${item}`));
  // Focus: only what the control looks like while focused counts; the resting value it changes from is compared above.
  if (a.focus) changes.push(...diffStyle(Object.fromEntries(Object.entries(a.focus).map(([key, value]) => [key, value[1]])), Object.fromEntries(Object.entries(b.focus ?? {}).map(([key, value]) => [key, value[1]])), ignore).map((item) => `focus ${item}`));
  return changes;
}

let differing = 0;
let total = 0;
const byProperty = new Map();
const problems = [];
for (const name of new Set([...Object.keys(before.screens), ...Object.keys(after.screens)])) {
  const left = before.screens[name];
  const right = after.screens[name];
  if (!left || !right) { problems.push(`screen ${name}: only in ${left ? "before" : "after"}`); continue; }
  for (const [theme, a, b] of [["light", left.entries, right.entries], ["dark", left.dark, right.dark]]) {
    if (!a || !b) continue;
    for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
      total += 1;
      if (!a[id] || !b[id]) { problems.push(`${name}/${theme} ${id}: only in ${a[id] ? "before" : "after"} (${(a[id] ?? b[id]).hint})`); differing += 1; continue; }
      const clock = (text) => text.replace(/\d{1,2}:\d{2}(:\d{2})?/g, "T");
      if (clock(a[id].hint) !== clock(b[id].hint)) problems.push(`${name}/${theme} ${id}: text changed "${a[id].hint}" → "${b[id].hint}"`);
      const changes = compareEntry(a[id], b[id]).filter((change) => !(styleOnly && /^(box|block-size|inline-size|height|width|perspective-origin|transform-origin|grid-template-(rows|columns)|min-block-size)\b/.test(change)));
      if (!changes.length) continue;
      differing += 1;
      for (const change of changes) {
        const property = change.split(":")[0];
        byProperty.set(property, (byProperty.get(property) ?? 0) + 1);
      }
      if (differing <= show) console.log(`\n[${name}/${theme}] ${id} ${a[id].type} "${a[id].hint}"\n  ${changes.slice(0, 12).join("\n  ")}${changes.length > 12 ? `\n  … ${changes.length - 12} more` : ""}`);
    }
  }
}
for (const problem of problems.slice(0, show)) console.log(`\n! ${problem}`);
console.log(`\n${total} elements compared, ${differing} differ${problems.length ? `, ${problems.length} problems` : ""}.`);
if (byProperty.size) console.log("most common properties:", [...byProperty].sort((x, y) => y[1] - x[1]).slice(0, 12).map(([name, count]) => `${name}×${count}`).join(", "));
process.exit(differing || problems.length ? 1 : 0);
