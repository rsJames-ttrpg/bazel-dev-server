import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import chokidar from "chokidar";
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

test("events under a removed root are dropped", async () => {
  const fake = new EventEmitter(); fake.close = async () => {};
  fake.add = () => {}; fake.unwatch = () => {};
  const w = createWatcher({ root: "/r", roots: ["a", "b"], files: ["t.json"], debounceMs: 10, watch: () => fake });
  const calls = []; w.on("change", (p) => calls.push(p));
  w.update({ roots: ["b"], files: ["t.json"] });
  fake.emit("all", "change", "/r/a/x.ts");
  fake.emit("all", "change", "/r/b/y.ts");
  fake.emit("all", "change", "/r/t.json");
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(calls, [["/r/b/y.ts", "/r/t.json"]]);
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

test("update re-adds a watched root that was deleted and exists again", () => {
  const fake = new EventEmitter(); fake.close = async () => {};
  const added = []; fake.add = (p) => added.push(p); fake.unwatch = () => {};
  let exists = false;
  const w = createWatcher({ root: "/r", roots: ["a", "b"], files: [], watch: () => fake, exists: () => exists });
  fake.emit("all", "unlinkDir", "/r/a");
  assert.deepEqual(w.update({ roots: ["a", "b"], files: [] }), { added: 0, removed: 0 });
  assert.deepEqual(added, []);
  exists = true;
  assert.deepEqual(w.update({ roots: ["a", "b"], files: [] }), { added: 1, removed: 0 });
  assert.deepEqual(added, [["/r/a"]]);
  w.update({ roots: ["a", "b"], files: [] });
  assert.deepEqual(added, [["/r/a"]]);
});

test("a root deleted with only its files reported is re-added too", () => {
  // chokidar sometimes reports only `unlink` for the files of a deleted root, or only raw events
  const fake = new EventEmitter(); fake.close = async () => {};
  const added = [], unwatched = []; fake.add = (p) => added.push(p); fake.unwatch = (p) => unwatched.push(p);
  let exists = true;
  const w = createWatcher({ root: "/r", roots: ["a", "b"], files: [], watch: () => fake, exists: (p) => exists || p !== "/r/a" && p !== "/r/b" });
  fake.emit("all", "unlink", "/r/a/x.ts");
  fake.emit("raw", "rename", "y.ts", { watchedPath: "/r/b" });
  assert.deepEqual(w.update({ roots: ["a", "b"], files: [] }), { added: 0, removed: 0 });
  exists = false;
  fake.emit("all", "unlink", "/r/a/x.ts");
  fake.emit("raw", "rename", "b", { watchedPath: "/r/b" });
  exists = true;
  assert.deepEqual(w.update({ roots: ["a", "b"], files: [] }), { added: 2, removed: 0 });
  // chokidar may still think a revived root is watched: unwatch first so add sets up new handles
  assert.deepEqual(unwatched, [["/r/a", "/r/b"]]);
  assert.deepEqual(added, [["/r/a", "/r/b"]]);
});

test("update returns how many paths it added and removed", () => {
  const fake = new EventEmitter(); fake.close = async () => {};
  fake.add = () => {}; fake.unwatch = () => {};
  const w = createWatcher({ root: "/r", roots: ["a"], files: [], watch: () => fake });
  assert.deepEqual(w.update({ roots: ["a", "b"], files: ["t.json"] }), { added: 2, removed: 0 });
  assert.deepEqual(w.update({ roots: ["b"], files: ["t.json"] }), { added: 0, removed: 1 });
  assert.deepEqual(w.update({ roots: ["b"], files: ["t.json"] }), { added: 0, removed: 0 });
});

test("widening to the workspace and narrowing back never unwatches a nested path", () => {
  const fake = new EventEmitter(); fake.close = async () => {};
  const added = [], removed = [];
  fake.add = (p) => added.push(...p); fake.unwatch = (p) => removed.push(...p);
  const w = createWatcher({ root: "/r", roots: ["a"], files: ["t.json"], watch: () => fake });
  assert.deepEqual(w.update({ roots: [""], files: [] }), { added: 1, removed: 0 });
  // chokidar still watches /r, which covers a/ and t.json: nothing to add
  assert.deepEqual(w.update({ roots: ["a", "b"], files: ["t.json"] }), { added: 0, removed: 0 });
  assert.deepEqual(added, ["/r"]);
  assert.deepEqual(removed, []);
});

const settle = (ms = 500) => new Promise((r) => setTimeout(r, ms));

test("real chokidar: a watched root deleted and recreated is watched again after update", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "watcher-"));
  try {
    await mkdir(join(tmp, "lib"));
    await writeFile(join(tmp, "lib/a.ts"), "0");
    const raw = [];
    const watch = (p, o) => { const f = chokidar.watch(p, o); f.on("all", (e, q) => raw.push(`${e} ${q}`)); return f; };
    const w = createWatcher({ root: tmp, roots: ["lib"], debounceMs: 20, watch });
    const calls = [];
    w.on("change", (p) => calls.push(p));
    await settle();
    await rm(join(tmp, "lib"), { recursive: true, force: true });
    await settle();
    await mkdir(join(tmp, "lib"));
    await writeFile(join(tmp, "lib/a.ts"), "1");
    await settle();
    raw.push(`update ${JSON.stringify(w.update({ roots: ["lib"] }))}`);
    await settle();
    calls.length = 0;
    await writeFile(join(tmp, "lib/a.ts"), "2");
    await settle(700);
    await w.close();
    assert.equal(calls.length, 1, JSON.stringify({ calls, raw }));
    assert.ok(calls[0].includes(join(tmp, "lib/a.ts")), JSON.stringify(calls));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("real chokidar: a root still delivers events after widening and narrowing back", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "watcher-"));
  try {
    for (const f of ["lib/a.ts", "other/b.ts"]) {
      await mkdir(dirname(join(tmp, f)), { recursive: true });
      await writeFile(join(tmp, f), "0");
    }
    const w = createWatcher({ root: tmp, roots: ["lib"], debounceMs: 20 });
    const calls = [];
    w.on("change", (p) => calls.push(p));
    await settle();
    w.update({ roots: [""] });
    await settle();
    await writeFile(join(tmp, "lib/a.ts"), "1");
    await writeFile(join(tmp, "lib/new.ts"), "1");
    await writeFile(join(tmp, "other/b.ts"), "1");
    await settle(700);
    assert.deepEqual(calls.flat().sort(), [join(tmp, "lib/a.ts"), join(tmp, "lib/new.ts"), join(tmp, "other/b.ts")]);
    calls.length = 0;
    w.update({ roots: ["lib"] });
    await settle();
    await writeFile(join(tmp, "lib/a.ts"), "2");
    await writeFile(join(tmp, "lib/new2.ts"), "2");
    await writeFile(join(tmp, "other/b.ts"), "2");
    await settle(700);
    await w.close();
    assert.deepEqual(calls.flat().sort(), [join(tmp, "lib/a.ts"), join(tmp, "lib/new2.ts")]);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
