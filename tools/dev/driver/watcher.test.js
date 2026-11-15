import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createWatcher } from "./watcher.js";

test("coalesces a burst of events into one change", async () => {
  const fake = new EventEmitter(); fake.close = async () => {};
  const w = createWatcher({ root: "/r", debounceMs: 10, watch: () => fake });
  const calls = [];
  w.on("change", (p) => calls.push(p));
  for (let i = 0; i < 300; i++) fake.emit("all", "change", `/r/f${i}.ts`);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 300);
});

test("real chokidar ignores bazel-*, node_modules and .git", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "watcher-"));
  try {
    const files = ["src/a.ts", "bazel-out/x.js", "node_modules/y.js", ".git/z"];
    for (const f of files) {
      await mkdir(dirname(join(tmp, f)), { recursive: true });
      await writeFile(join(tmp, f), "0");
    }
    const w = createWatcher({ root: tmp, debounceMs: 20 });
    const calls = [];
    w.on("change", (p) => calls.push(p));
    await new Promise((r) => setTimeout(r, 500));
    for (const f of files) await writeFile(join(tmp, f), "1");
    await new Promise((r) => setTimeout(r, 700));
    await w.close();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], [join(tmp, "src/a.ts")]);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
