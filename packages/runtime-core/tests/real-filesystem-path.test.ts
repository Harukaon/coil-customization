import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { realFilesystemPath } from "../src/project-helpers.ts";

test("a path inside app.asar maps to the unpacked copy when it exists", () => {
  const root = mkdtempSync(join(tmpdir(), "asar-"));
  const unpacked = join(root, "app.asar.unpacked", "node_modules", "pkg", "skills");
  mkdirSync(unpacked, { recursive: true });
  assert.equal(realFilesystemPath(join(root, "app.asar", "node_modules", "pkg", "skills")), unpacked);
});

test("it leaves the path alone when there is no unpacked copy or no asar", () => {
  const root = mkdtempSync(join(tmpdir(), "asar-"));
  const inside = join(root, "app.asar", "node_modules", "pkg", "skills");
  assert.equal(realFilesystemPath(inside), inside);
  const plain = join(root, "packages", "workflow", "skills");
  assert.equal(realFilesystemPath(plain), plain);
});
