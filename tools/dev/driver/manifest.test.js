import test from "node:test";
import assert from "node:assert/strict";
import { diffManifests } from "./manifest.js";
const mk = (mods) => ({ version: 1, modules: Object.fromEntries(Object.entries(mods).map(([k, d]) => [k, { digest: d, output: k, refresh: false, imports: [] }])) });

test("changed, added, removed by digest", () => {
  const d = diffManifests(mk({ a: "1", b: "1", c: "1" }), mk({ a: "2", b: "1", d: "1" }));
  assert.deepEqual(d, { changed: ["a"], added: ["d"], removed: ["c"] });
});
test("equal digests change nothing", () => {
  assert.deepEqual(diffManifests(mk({ a: "1" }), mk({ a: "1" })), { changed: [], added: [], removed: [] });
});
test("null previous means everything is added", () => {
  assert.deepEqual(diffManifests(null, mk({ a: "1" })).added, ["a"]);
});
