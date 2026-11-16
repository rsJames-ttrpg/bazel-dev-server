import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("persistent worker speaks the JSON protocol", async () => {
  const dir = mkdtempSync(join(tmpdir(), "worker-"));
  const tsconfig = resolve("tsconfig.json");
  const src = join(dir, "a.ts");
  writeFileSync(src, "export const n: number = 1;\n");
  const argsfile = join(dir, "args");
  writeFileSync(argsfile, ["--src", src, "--out", join(dir, "1.js"), "--meta", join(dir, "1.meta.json"), "--key", "app/a.ts", "--dev", "false", "--tsconfig", tsconfig].join("\n") + "\n");
  const requests = [
    { arguments: [`@${argsfile}`], requestId: 1 },
    { arguments: ["--src", src, "--out", join(dir, "2.js"), "--meta", join(dir, "2.meta.json"), "--key", "app/a.ts", "--dev", "false", "--tsconfig", tsconfig], requestId: 2 },
    { arguments: ["--src", src, "--meta", join(dir, "3.meta.json"), "--key", "app/a.ts", "--dev", "false", "--tsconfig", tsconfig], requestId: 3 },
  ];
  const child = spawn(process.execPath, [resolve("tools/transform/worker.js"), "--persistent_worker"], {
    env: { ...process.env, BAZEL_BINDIR: "." },
    stdio: ["pipe", "pipe", "inherit"],
  });
  let stdout = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stdin.end(requests.map((r) => JSON.stringify(r)).join("\n") + "\n");
  await new Promise((res) => child.on("close", res));

  const lines = stdout.split("\n").filter((l) => l !== "");
  assert.equal(lines.length, 3);
  assert.ok(stdout.endsWith("\n"));
  const [r1, r2, r3] = lines.map((l) => JSON.parse(l));
  assert.deepEqual([r1.requestId, r2.requestId, r3.requestId], [1, 2, 3]);
  assert.equal(r1.exitCode, 0);
  assert.equal(r2.exitCode, 0);
  for (const n of [1, 2]) {
    assert.ok(existsSync(join(dir, `${n}.js`)));
    assert.ok(existsSync(join(dir, `${n}.meta.json`)));
  }
  for (const n of [1, 2]) assert.equal(JSON.parse(readFileSync(join(dir, `${n}.meta.json`), "utf8")).kind, "js");
  assert.equal(r3.exitCode, 1);
  assert.match(r3.output, /--out/);
});

test("one-shot worker transforms a css file into css, module and meta", async () => {
  const dir = mkdtempSync(join(tmpdir(), "worker-css-"));
  const src = join(dir, "a.css");
  writeFileSync(src, ".a { color: red }\n");
  const out = { out: join(dir, "a.css.js"), meta: join(dir, "a.css.js.meta.json"), css: join(dir, "a.out.css") };
  const child = spawn(process.execPath, [resolve("tools/transform/worker.js"), "--src", src, "--out", out.out, "--meta", out.meta, "--css-out", out.css, "--key", "app/a.css", "--dev", "false", "--tsconfig", resolve("tsconfig.json")], {
    env: { ...process.env, BAZEL_BINDIR: "." },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const code = await new Promise((res) => child.on("close", res));
  assert.equal(code, 0);
  assert.ok(existsSync(out.out));
  assert.match(readFileSync(out.css, "utf8"), /color:\s*red/);
  assert.equal(JSON.parse(readFileSync(out.meta, "utf8")).kind, "css");
});

test("css module class names hash from the key, not the source path", async () => {
  /** @param {string} sub */
  async function run(sub) {
    const dir = mkdtempSync(join(tmpdir(), "worker-cssmod-"));
    const srcDir = join(dir, sub);
    mkdirSync(srcDir, { recursive: true });
    const src = join(srcDir, "x.module.css");
    writeFileSync(src, ".title { color: red }\n");
    const out = { out: join(dir, "x.module.css.js"), meta: join(dir, "x.module.css.js.meta.json"), css: join(dir, "x.out.css") };
    const child = spawn(process.execPath, [resolve("tools/transform/worker.js"), "--src", src, "--out", out.out, "--meta", out.meta, "--css-out", out.css, "--key", "app/x.module.css", "--dev", "false", "--tsconfig", resolve("tsconfig.json")], {
      env: { ...process.env, BAZEL_BINDIR: "." },
      stdio: ["ignore", "inherit", "inherit"],
    });
    assert.equal(await new Promise((res) => child.on("close", res)), 0);
    return { meta: JSON.parse(readFileSync(out.meta, "utf8")), code: readFileSync(out.out, "utf8") };
  }
  const a = await run("app");
  const b = await run("bazel-out/k8-fastbuild/bin/app");
  assert.deepEqual(a.meta.exports, b.meta.exports);
  assert.match(a.code, /^import "\.\/x\.module\.css";/);
});
