import test from "node:test";
import assert from "node:assert/strict";
import { transformSource } from "./transform.js";
const opts = { jsx: "react-jsx", target: "ES2022", useDefineForClassFields: true, verbatimModuleSyntax: true };

test("strips types and keeps ESM", () => {
  const r = transformSource({ code: "import x from './a'; export const n: number = 1;", filename: "f.ts", dev: false, compilerOptions: opts });
  assert.match(r.code, /import x from ['"]\.\/a['"]/);
  assert.doesNotMatch(r.code, /number/);
  assert.deepEqual(r.meta.imports, ["./a"]);
  assert.match(r.meta.digest, /^[0-9a-f]{64}$/);
});
test("tsx uses the automatic runtime and records the jsx-runtime import", () => {
  const r = transformSource({ code: "export const A = () => <div/>;", filename: "A.tsx", dev: false, compilerOptions: opts });
  assert.ok(r.meta.imports.includes("react/jsx-runtime"));
  assert.equal(r.meta.refresh, false);
});
test("dev tsx has refresh registration", () => {
  const r = transformSource({ code: "export const A = () => <div/>;", filename: "A.tsx", dev: true, compilerOptions: opts });
  assert.match(r.code, /\$RefreshReg\$/);
  assert.equal(r.meta.refresh, true);
});
test("same input gives same digest", () => {
  const a = transformSource({ code: "export const n = 1;", filename: "f.ts", dev: false, compilerOptions: opts });
  const b = transformSource({ code: "export const n = 1;", filename: "f.ts", dev: false, compilerOptions: opts });
  assert.equal(a.meta.digest, b.meta.digest);
});
test("imports hold static imports and re-exports only", () => {
  const r = transformSource({ code: "export { a } from './a'; export const f = () => import('./lazy');", filename: "f.ts", dev: false, compilerOptions: opts });
  assert.ok(r.meta.imports.includes("./a"));
  assert.ok(!r.meta.imports.includes("./lazy"));
});
test("digest hashes the output: a type-only edit keeps it", () => {
  const a = transformSource({ code: "export const n: number = 1;", filename: "f.ts", dev: false, compilerOptions: opts });
  const b = transformSource({ code: "export const n: 1 = 1;", filename: "f.ts", dev: false, compilerOptions: opts });
  assert.equal(a.meta.digest, b.meta.digest);
});
test("digest hashes the output: dev and prod outputs differ", () => {
  const code = "export const A = () => <div/>;";
  const a = transformSource({ code, filename: "A.tsx", dev: true, compilerOptions: opts });
  const b = transformSource({ code, filename: "A.tsx", dev: false, compilerOptions: opts });
  assert.notEqual(a.meta.digest, b.meta.digest);
});

test("dev component module is wrapped for refresh with its key", () => {
  const r = transformSource({ code: "export const A = () => <div/>;", filename: "A.tsx", key: "app/src/A.tsx", dev: true, compilerOptions: opts });
  assert.equal(r.meta.kind, "js");
  assert.equal(r.meta.refresh, true);
  assert.match(r.code, /window\.__devRefresh\.register\(type, "app\/src\/A\.tsx " \+ id\)/);
  assert.match(r.code, /registerModule\("app\/src\/A\.tsx", import\.meta\.url\)/);
  assert.ok(r.code.indexOf("__prevRefreshReg") < r.code.indexOf("$RefreshReg$(_c"), "wrapper head precedes SWC body");
  assert.ok(r.code.lastIndexOf("window.$RefreshReg$ = __prevRefreshReg") > r.code.indexOf("$RefreshReg$(_c"), "wrapper tail follows SWC body");
});
test("dev module without components is not wrapped", () => {
  const r = transformSource({ code: "export const n = 1;", filename: "n.ts", key: "app/n.ts", dev: true, compilerOptions: opts });
  assert.equal(r.meta.refresh, false);
  assert.doesNotMatch(r.code, /__devRefresh/);
});
test("prod component module is never wrapped", () => {
  const r = transformSource({ code: "export const A = () => <div/>;", filename: "A.tsx", key: "app/src/A.tsx", dev: false, compilerOptions: opts });
  assert.doesNotMatch(r.code, /RefreshReg/);
});
