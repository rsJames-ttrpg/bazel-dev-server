import test from "node:test";
import assert from "node:assert/strict";
import { buildManifest } from "./write_manifest.js";

test("builds a version 1 manifest keyed by workspace path", () => {
  const m = buildManifest({
    pkg: "examples/hello", entry: "examples/hello/src/main.tsx", indexHtml: "bazel-out/x/bin/examples/hello/index.html",
    modules: [{ key: "examples/hello/src/main.tsx", output: "bazel-out/x/bin/m.js", meta: { digest: "ab", refresh: false, imports: ["./App"] } }],
    npm: { dir: "bazel-out/x/bin/examples/hello/hello.npm", entries: { react: "react.js" } }, packages: {},
  });
  assert.equal(m.version, 1);
  assert.deepEqual(Object.keys(m.modules), ["examples/hello/src/main.tsx"]);
  assert.equal(m.modules["examples/hello/src/main.tsx"].digest, "ab");
  assert.deepEqual(m.modules["examples/hello/src/main.tsx"].imports, ["./App"]);
  assert.equal(m.npm.entries.react, "react.js");
});
test("module keys are sorted so the file is stable", () => {
  const m = buildManifest({ pkg: "p", entry: "p/b.ts", indexHtml: "i", packages: {}, npm: { dir: "", entries: {} },
    modules: [{ key: "p/b.ts", output: "o", meta: { digest: "1", refresh: false, imports: [] } }, { key: "p/a.ts", output: "o", meta: { digest: "2", refresh: false, imports: [] } }] });
  assert.deepEqual(Object.keys(m.modules), ["p/a.ts", "p/b.ts"]);
});
