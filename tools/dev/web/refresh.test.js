import test from "node:test";
import assert from "node:assert/strict";
import { registerExportsForReactRefresh, validateRefreshBoundary } from "./refresh.js";

function fakeRuntime() {
  const calls = [];
  return { calls, register: (_t, id) => calls.push(id), isLikelyComponentType: (v) => typeof v === "function" && /^[A-Z]/.test(v.name) };
}
function A() {}
function B() {}

test("registers component exports under key and export name", () => {
  const rt = fakeRuntime();
  registerExportsForReactRefresh(rt, "app/A.tsx", { A, n: 1 });
  assert.deepEqual(rt.calls, ["app/A.tsx export A"]);
});
test("all exports components: boundary valid (null)", () => {
  assert.equal(validateRefreshBoundary(fakeRuntime(), { A, B }, { A, B }), null);
});
test("a changed non-component export invalidates", () => {
  assert.match(validateRefreshBoundary(fakeRuntime(), { A, n: 1 }, { A, n: 2 }), /n/);
});
test("an unchanged non-component export is fine", () => {
  const n = {};
  assert.equal(validateRefreshBoundary(fakeRuntime(), { A, n }, { A, n }), null);
});
test("added or removed export invalidates", () => {
  assert.equal(validateRefreshBoundary(fakeRuntime(), { A, B }, { A }), "export B removed");
  assert.equal(validateRefreshBoundary(fakeRuntime(), { A }, { A, B }), "export B added");
});
test("no exports at all invalidates", () => {
  assert.equal(validateRefreshBoundary(fakeRuntime(), {}, {}), "no exports");
});
