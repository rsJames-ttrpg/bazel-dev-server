import test from "node:test";
import assert from "node:assert/strict";
import { findUnresolved, isBareSpecifier, rewriteImports } from "./rewrite.js";
const manifest = {
  version: 1, entry: "app/src/main.tsx", packages: { "@acme/ui": "libs/ui" },
  npm: { dir: "d", entries: { react: "react.js", "react/jsx-runtime": "react__jsx-runtime.js" } },
  modules: { "app/src/main.tsx": {}, "app/src/App.tsx": {}, "app/src/util/index.ts": {}, "libs/ui/button.tsx": {} },
};
test("npm, relative, index and package imports", () => {
  const r = rewriteImports(
    `import React from "react";\nimport { A } from "./App";\nimport u from "./util";\nimport { B } from "@acme/ui/button";\nimport { jsx } from "react/jsx-runtime";`,
    "app/src/main.tsx", manifest);
  assert.match(r.code, /from "\/npm\/react\.js"/);
  assert.match(r.code, /from "\/app\/src\/App\.tsx"/);
  assert.match(r.code, /from "\/app\/src\/util\/index\.ts"/);
  assert.match(r.code, /from "\/libs\/ui\/button\.tsx"/);
  assert.match(r.code, /from "\/npm\/react__jsx-runtime\.js"/);
  assert.deepEqual(r.unresolved, []);
});
test("unknown bare specifier is left alone and reported", () => {
  const r = rewriteImports(`import x from "lodash";`, "app/src/main.tsx", manifest);
  assert.match(r.code, /from "lodash"/);
  assert.deepEqual(r.unresolved, ["lodash"]);
});
test("a .js suffix resolves to the .ts or .tsx source", () => {
  const r = rewriteImports(`import "./App.js";\nimport u from "./util/index.js";`, "app/src/main.tsx", manifest);
  assert.match(r.code, /import "\/app\/src\/App\.tsx"/);
  assert.match(r.code, /from "\/app\/src\/util\/index\.ts"/);
  assert.deepEqual(r.unresolved, []);
});
test("isBareSpecifier excludes relative and workspace package specifiers", () => {
  assert.equal(isBareSpecifier("lodash", manifest), true);
  assert.equal(isBareSpecifier("./Missing", manifest), false);
  assert.equal(isBareSpecifier("@acme/ui/missing", manifest), false);
});
test("findUnresolved lists every import no resolver can serve", () => {
  const manifest = { entry: "a/main.tsx", packages: { "@x/ui": "ui" }, npm: { dir: "n", entries: { react: "react.js" } },
    modules: { "a/main.tsx": { imports: ["react", "./App", "./Missing", "@x/ui", "@x/ui/Gone", "lodash"] }, "a/App.tsx": { imports: [] }, "ui/index.ts": { imports: [] } } };
  assert.deepEqual(findUnresolved(manifest), [
    { key: "a/main.tsx", specifier: "./Missing" }, { key: "a/main.tsx", specifier: "@x/ui/Gone" }, { key: "a/main.tsx", specifier: "lodash" },
  ]);
});
