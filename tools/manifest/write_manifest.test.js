import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildManifest, dirDigest, fileDigest } from "./write_manifest.js";

test("builds a version 1 manifest keyed by workspace path", () => {
  const m = buildManifest({
    pkg: "examples/hello", entry: "examples/hello/src/main.tsx", indexHtml: "bazel-out/x/bin/examples/hello/index.html", indexDigest: "ix",
    modules: [{ key: "examples/hello/src/main.tsx", output: "bazel-out/x/bin/m.js", meta: { digest: "ab", refresh: false, imports: ["./App"] } }],
    npm: { dir: "bazel-out/x/bin/examples/hello/hello.npm", digest: "nd", entries: { react: "react.js" } }, packages: {},
  });
  assert.equal(m.version, 1);
  assert.deepEqual(Object.keys(m.modules), ["examples/hello/src/main.tsx"]);
  assert.equal(m.modules["examples/hello/src/main.tsx"].digest, "ab");
  assert.deepEqual(m.modules["examples/hello/src/main.tsx"].imports, ["./App"]);
  assert.equal(m.npm.entries.react, "react.js");
  assert.equal(m.npm.digest, "nd");
  assert.equal(m.indexDigest, "ix");
});
test("module keys are sorted so the file is stable", () => {
  const m = buildManifest({ pkg: "p", entry: "p/b.ts", indexHtml: "i", indexDigest: "", packages: {}, npm: { dir: "", digest: "", entries: {} },
    modules: [{ key: "p/b.ts", output: "o", meta: { digest: "1", refresh: false, imports: [] } }, { key: "p/a.ts", output: "o", meta: { digest: "2", refresh: false, imports: [] } }] });
  assert.deepEqual(Object.keys(m.modules), ["p/a.ts", "p/b.ts"]);
});
test("npm and index digests follow file names and contents", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "npmdir-"));
  fs.mkdirSync(path.join(dir, "sub"));
  fs.writeFileSync(path.join(dir, "react.js"), "a");
  fs.writeFileSync(path.join(dir, "sub/x.js"), "b");
  const d1 = dirDigest(dir);
  assert.match(d1, /^[0-9a-f]{64}$/);
  assert.equal(dirDigest(dir), d1);
  fs.writeFileSync(path.join(dir, "sub/x.js"), "c");
  const d2 = dirDigest(dir);
  assert.notEqual(d2, d1);
  fs.renameSync(path.join(dir, "react.js"), path.join(dir, "react2.js"));
  assert.notEqual(dirDigest(dir), d2);
  assert.match(dirDigest(""), /^[0-9a-f]{64}$/);
  const index = path.join(dir, "index.html");
  fs.writeFileSync(index, "<html>1</html>");
  const i1 = fileDigest(index);
  fs.writeFileSync(index, "<html>2</html>");
  assert.notEqual(fileDigest(index), i1);
});
