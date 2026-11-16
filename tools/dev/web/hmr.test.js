import test from "node:test";
import assert from "node:assert/strict";
import { decide } from "./hmr.js";
const m = (mods) => ({ modules: mods });
const ev = (manifest, o) => ({ manifest, changed: [], added: [], removed: [], other: [], ...o });
const A = { "a.tsx": { digest: "2", refresh: true, kind: "js" }, "s.css": { digest: "2", refresh: true, kind: "css" }, "u.ts": { digest: "2", refresh: false, kind: "js" } };

test("nothing changed and not failed: null", () => assert.equal(decide(ev(m(A))), null));
test("nothing changed after a failure: ok", () => assert.deepEqual(decide(ev(m(A)), true), { type: "ok" }));
test("refresh-capable and css changes: update with digests and kinds", () => {
  assert.deepEqual(decide(ev(m(A), { changed: ["a.tsx", "s.css"] })), { type: "update", modules: [
    { key: "a.tsx", digest: "2", kind: "js" }, { key: "s.css", digest: "2", kind: "css" }] });
});
test("a non-refresh module changed: reload naming it", () => {
  assert.deepEqual(decide(ev(m(A), { changed: ["a.tsx", "u.ts"] })), { type: "reload", reason: "u.ts cannot hot-update" });
});
test("removed modules or npm/index changes: reload", () => {
  assert.equal(decide(ev(m(A), { removed: ["x.ts"] })).type, "reload");
  assert.equal(decide(ev(m(A), { other: ["npm"] })).type, "reload");
});
test("only added modules: null (importers that changed carry them)", () => assert.equal(decide(ev(m(A), { added: ["n.tsx"] })), null));
