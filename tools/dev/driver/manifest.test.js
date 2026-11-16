import test from "node:test";
import assert from "node:assert/strict";
import { diffManifests } from "./manifest.js";
const mk = (mods, { npm = "n", index = "i" } = {}) => ({ version: 1, indexDigest: index, npm: { dir: "d", digest: npm, entries: {} }, modules: Object.fromEntries(Object.entries(mods).map(([k, d]) => [k, { digest: d, output: k, refresh: false, imports: [] }])) });

test("changed, added, removed by digest", () => {
  const d = diffManifests(mk({ a: "1", b: "1", c: "1" }), mk({ a: "2", b: "1", d: "1" }));
  assert.deepEqual(d, { changed: ["a"], added: ["d"], removed: ["c"], other: [] });
});
test("equal digests change nothing", () => {
  assert.deepEqual(diffManifests(mk({ a: "1" }), mk({ a: "1" })), { changed: [], added: [], removed: [], other: [] });
});
test("null previous means everything is added", () => {
  assert.deepEqual(diffManifests(null, mk({ a: "1" })).added, ["a"]);
});
test("npm and index digest changes are reported in other", () => {
  assert.deepEqual(diffManifests(mk({ a: "1" }), mk({ a: "1" }, { npm: "n2" })).other, ["npm"]);
  assert.deepEqual(diffManifests(mk({ a: "1" }), mk({ a: "1" }, { index: "i2" })).other, ["index"]);
  assert.deepEqual(diffManifests(mk({ a: "1" }), mk({ a: "1" }, { npm: "n2", index: "i2" })).other, ["npm", "index"]);
  assert.deepEqual(diffManifests(null, mk({ a: "1" })).other, []);
});
test("a change to packages is reported in other", () => {
  const withPkgs = (packages) => ({ ...mk({ a: "1" }), packages });
  assert.deepEqual(diffManifests(withPkgs({ "@x/ui": "lib/ui" }), withPkgs({ "@x/ui2": "lib/ui" })).other, ["packages"]);
  assert.deepEqual(diffManifests(withPkgs({ "@x/ui": "lib/ui" }), withPkgs({ "@x/ui": "lib/ui2" })).other, ["packages"]);
  assert.deepEqual(diffManifests(withPkgs({ "@x/ui": "lib/ui" }), withPkgs({ "@x/ui": "lib/ui" })).other, []);
  assert.deepEqual(diffManifests(mk({ a: "1" }), withPkgs({})).other, []);
  assert.deepEqual(diffManifests(mk({ a: "1" }), { ...mk({ a: "1" }, { npm: "n2" }), packages: { p: "q" } }).other, ["npm", "packages"]);
});
