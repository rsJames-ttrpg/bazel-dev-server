import test from "node:test";
import assert from "node:assert/strict";
import { transformSource } from "./transform.js";
const opts = { jsx: "react-jsx", target: "ES2022", useDefineForClassFields: true };

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
