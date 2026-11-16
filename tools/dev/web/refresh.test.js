import test from "node:test";
import assert from "node:assert/strict";
import { classMapChanged, registerExportsForReactRefresh, shouldReloadAfterUpdate, validateRefreshBoundary } from "./refresh.js";

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
test("class map: same keys and values unchanged", () => {
  assert.equal(classMapChanged({ title: "_h_title", b: "_h_b _h_a" }, { b: "_h_b _h_a", title: "_h_title" }), false);
  assert.equal(classMapChanged({}, {}), false);
});
test("class map: added, removed, renamed or re-hashed class changed", () => {
  assert.equal(classMapChanged({ title: "_h_title" }, { title: "_h_title", sub: "_h_sub" }), true);
  assert.equal(classMapChanged({ title: "_h_title", sub: "_h_sub" }, { title: "_h_title" }), true);
  assert.equal(classMapChanged({ title: "_h_title" }, { heading: "_h_heading" }), true);
  assert.equal(classMapChanged({ title: "_h_title" }, { title: "_h_title _h_base" }), true);
});
test("class map: non-object treated as empty", () => {
  assert.equal(classMapChanged(undefined, {}), false);
  assert.equal(classMapChanged(null, undefined), false);
  assert.equal(classMapChanged("x", { a: "_h_a" }), true);
  assert.equal(classMapChanged({ a: "_h_a" }, 1), true);
});

test("update while the overlay shows and no JS module is registered: reload", () => {
  assert.equal(shouldReloadAfterUpdate([{ key: "app/App.tsx", kind: "js" }], new Set(), true), true);
});
test("update while the overlay shows with a registered JS module: hot-update", () => {
  const updates = [{ key: "app/App.tsx", kind: "js" }, { key: "app/x.ts", kind: "js" }];
  assert.equal(shouldReloadAfterUpdate(updates, new Set(["app/App.tsx"]), true), false);
});
test("update without the overlay: never reload", () => {
  assert.equal(shouldReloadAfterUpdate([{ key: "app/App.tsx", kind: "js" }], new Set(), false), false);
});
test("css-only update while the overlay shows: reload", () => {
  assert.equal(shouldReloadAfterUpdate([{ key: "app/App.module.css", kind: "css" }], new Set(), true), true);
});
