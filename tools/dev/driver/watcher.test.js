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
    const w = createWatcher({ root: tmp, roots: [""], debounceMs: 20 });
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

test("watches only the roots and files given", () => {
  const paths = []; const fake = new EventEmitter(); fake.close = async () => {};
  createWatcher({ root: "/r", roots: ["a", ""], files: ["tsconfig.json"], watch: (p) => { paths.push(...p); return fake; } });
  assert.deepEqual(paths, ["/r/a", "/r", "/r/tsconfig.json"]);
});

test("update adds new roots and unwatches removed ones", () => {
  const fake = new EventEmitter(); fake.close = async () => {};
  const added = [], removed = [];
  fake.add = (p) => added.push(...p); fake.unwatch = (p) => removed.push(...p);
  const w = createWatcher({ root: "/r", roots: ["a"], files: [], watch: () => fake });
  w.update({ roots: ["a", "b"], files: ["t.json"] });
  w.update({ roots: ["b"], files: ["t.json"] });
  w.update({ roots: ["b"], files: ["t.json"] });
  assert.deepEqual(added, ["/r/b", "/r/t.json"]);
  assert.deepEqual(removed, ["/r/a"]);
});

test("delivers watcher errors", async () => {
  const fake = new EventEmitter(); fake.close = async () => {};
  const w = createWatcher({ root: "/r", roots: [""], files: [], watch: () => fake });
  const errors = []; w.on("error", (e) => errors.push(e.message));
  fake.emit("error", new Error("ENOSPC"));
  assert.deepEqual(errors, ["ENOSPC"]);
});

/** Write `files` under a temp dir, watch with `opts`, rewrite them all, return the change calls. */
async function realRun(files, opts) {
  const tmp = await mkdtemp(join(tmpdir(), "watcher-"));
  try {
    for (const f of files) {
      await mkdir(dirname(join(tmp, f)), { recursive: true });
      await writeFile(join(tmp, f), "0");
    }
    const w = createWatcher({ root: tmp, debounceMs: 20, ...opts });
    const calls = [];
    w.on("change", (p) => calls.push(p));
    await new Promise((r) => setTimeout(r, 500));
    for (const f of files) await writeFile(join(tmp, f), "1");
    await new Promise((r) => setTimeout(r, 700));
    await w.close();
    return { tmp, calls };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

test("a plain file named bazel-* is not ignored; bazel-out and node_modules are", async () => {
  const { tmp, calls } = await realRun(
    ["src/bazel-utils.ts", "bazel-out/x.js", "node_modules/y.js"], { roots: [""] });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [join(tmp, "src/bazel-utils.ts")]);
});

test("only the roots are watched", async () => {
  const { tmp, calls } = await realRun(["app/a.ts", "other/b.ts"], { roots: ["app"] });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [join(tmp, "app/a.ts")]);
});
