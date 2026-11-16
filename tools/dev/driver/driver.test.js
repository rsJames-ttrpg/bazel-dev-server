import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createDriver } from "./driver.js";

const mk = (mods) => ({ version: 1, modules: Object.fromEntries(Object.entries(mods).map(([k, d]) => [k, { digest: d, output: k, refresh: false, imports: [] }])) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setup({ builds, manifests, update = () => {} }) {
  const logs = [];
  const listeners = { change: [], error: [] };
  const updates = [];
  let watcherOpts;
  let requests = 0;
  const watcher = {
    on: (e, cb) => { listeners[e].push(cb); },
    update: (next) => { updates.push(next); return update(next); },
    close: async () => {},
  };
  const builder = {
    request: async () => { const r = builds[requests++]; await sleep(r.delay ?? 0); return r.result; },
  };
  let loads = 0;
  const driver = createDriver({
    workspaceDir: "/w", target: "//a:b", manifestPath: "/m.json", log: (l) => logs.push(l),
    createWatcher: (opts) => { watcherOpts = opts; return watcher; }, createBuilder: () => builder,
    loadManifest: async () => manifests[loads++],
  });
  const events = [];
  for (const e of ["building", "built", "failed"]) driver.on(e, (x) => events.push([e, x]));
  return {
    driver, logs, events, updates,
    watcherOpts: () => watcherOpts,
    change: () => { for (const cb of listeners.change) cb(["/w/f.ts"]); },
    fireError: (err) => { for (const cb of listeners.error) cb(err); },
    builds: () => requests,
  };
}

test("one cycle per build: changes during a build trigger exactly one more", async () => {
  const s = setup({
    builds: [{ delay: 40, result: { ok: true, ms: 5 } }, { result: { ok: true, ms: 7 } }, { result: { ok: true, ms: 9 } }],
    manifests: [mk({ a: "1" }), mk({ a: "2" }), mk({ a: "2" })],
  });
  await s.driver.start();
  assert.deepEqual(s.logs.splice(0), ["watching ."]);
  s.change();
  await sleep(10); s.change(); s.change();
  await sleep(150);
  await s.driver.stop();
  assert.equal(s.builds(), 2);
  assert.equal(s.events.filter(([e]) => e === "built").length, 2);
  assert.equal(s.logs.length, 2);
  assert.match(s.logs[0], /^built in \d+ms \(bazel 5ms\): 1 modules changed$/);
  assert.match(s.logs[1], /^built in \d+ms \(bazel 7ms\): 0 modules changed$/);
  const first = s.events.find(([e]) => e === "built")[1];
  assert.deepEqual(first.changed, ["a"]);
  assert.deepEqual(Object.keys(first.timings), ["watchToBuild", "bazel", "manifest"]);
});

test("a failing build emits failed once and keeps the manifest", async () => {
  const s = setup({
    builds: [{ result: { ok: false, error: "boom", ms: 3 } }],
    manifests: [mk({ a: "1" })],
  });
  const initial = await s.driver.start();
  assert.deepEqual(s.logs.splice(0), ["watching ."]);
  s.change();
  await sleep(50);
  await s.driver.stop();
  const failed = s.events.filter(([e]) => e === "failed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0][1].error, "boom");
  assert.equal(s.logs.length, 1);
  assert.match(s.logs[0], /^build failed in \d+ms$/);
  assert.equal(s.driver.manifest, initial);
});

test("npm and index changes appear in the built event and the log", async () => {
  const m1 = { ...mk({ a: "1" }), indexDigest: "i1", npm: { dir: "d", digest: "n1", entries: {} } };
  const m2 = { ...mk({ a: "1" }), indexDigest: "i2", npm: { dir: "d", digest: "n2", entries: {} } };
  const s = setup({ builds: [{ result: { ok: true, ms: 4 } }], manifests: [m1, m2] });
  await s.driver.start();
  assert.deepEqual(s.logs.splice(0), ["watching ."]);
  s.change();
  await sleep(50);
  await s.driver.stop();
  assert.match(s.logs[0], /^built in \d+ms \(bazel 4ms\): 0 modules changed, npm changed, index changed$/);
  const built = s.events.find(([e]) => e === "built")[1];
  assert.deepEqual(built.other, ["npm", "index"]);
});

test("waiting for the Bazel lock is logged and emitted", async () => {
  const logs = [];
  let fireChange;
  const watcher = { on: (e, cb) => { if (e === "change") fireChange = cb; }, update: () => {}, close: async () => {} };
  const driver = createDriver({
    workspaceDir: "/w", target: "//a:b", manifestPath: "/m.json", log: (l) => logs.push(l),
    createWatcher: () => watcher,
    createBuilder: ({ onWaiting }) => ({ request: async () => { onWaiting(); return { ok: true, ms: 1 }; } }),
    loadManifest: async () => mk({ a: "1" }),
  });
  let waiting = 0;
  driver.on("waiting", () => { waiting++; });
  await driver.start();
  assert.deepEqual(logs.splice(0), ["watching ."]);
  fireChange(["/w/f.ts"]);
  await sleep(50);
  await driver.stop();
  assert.equal(waiting, 1);
  assert.equal(logs[0], "waiting for Bazel server (another command holds the lock)");
});

const withWatch = (roots, files = []) => ({ ...mk({ a: "1" }), watch: { roots, files } });

test("watches the manifest's roots at start and logs them", async () => {
  const s = setup({ builds: [], manifests: [withWatch(["app", "lib"], ["tsconfig.json"])] });
  await s.driver.start();
  await s.driver.stop();
  assert.equal(s.watcherOpts().root, "/w");
  assert.deepEqual(s.watcherOpts().roots, ["app", "lib"]);
  assert.deepEqual(s.watcherOpts().files, ["tsconfig.json"]);
  assert.equal(s.logs[0], "watching app, lib");
});

test("a manifest without a watch section watches the workspace root", async () => {
  const s = setup({ builds: [], manifests: [mk({ a: "1" })] });
  await s.driver.start();
  await s.driver.stop();
  assert.deepEqual(s.watcherOpts().roots, [""]);
  assert.deepEqual(s.watcherOpts().files, []);
  assert.deepEqual(s.logs, ["watching ."]);
});

test("re-roots the watcher when the manifest's watch section changes", async () => {
  const m2 = withWatch(["app", "lib"]);
  const s = setup({
    builds: [{ result: { ok: true, ms: 1 } }, { result: { ok: true, ms: 1 } }],
    manifests: [withWatch(["app"]), m2, withWatch(["app", "lib"])],
  });
  await s.driver.start();
  s.change();
  await sleep(30);
  s.change();
  await sleep(30);
  await s.driver.stop();
  assert.equal(s.builds(), 2);
  // update runs after every cycle (it also revives deleted roots); the log only on a change
  assert.deepEqual(s.updates, [m2.watch, m2.watch]);
  assert.equal(s.logs[0], "watching app");
  assert.match(s.logs[1], /^built in /);
  assert.equal(s.logs[2], "watching app, lib");
  assert.match(s.logs[3], /^built in /);
  assert.equal(s.logs.filter((l) => l === "watching app, lib").length, 1);
});

test("a watcher error logs and triggers one cycle", async () => {
  const s = setup({ builds: [{ result: { ok: true, ms: 1 } }], manifests: [mk({ a: "1" }), mk({ a: "1" })] });
  await s.driver.start();
  s.logs.splice(0);
  s.fireError(new Error("ENOSPC"));
  await sleep(50);
  await s.driver.stop();
  assert.equal(s.builds(), 1);
  assert.equal(s.logs[0], "watcher error: ENOSPC; rebuilding");
  assert.match(s.logs[1], /^built in /);
});

test("requestBuild runs a cycle and coalesces with changes", async () => {
  const s = setup({
    builds: [{ delay: 40, result: { ok: true, ms: 1 } }, { result: { ok: true, ms: 1 } }, { result: { ok: true, ms: 1 } }],
    manifests: [mk({ a: "1" }), mk({ a: "1" }), mk({ a: "1" }), mk({ a: "1" })],
  });
  await s.driver.start();
  s.driver.requestBuild();
  s.driver.requestBuild();
  await sleep(10);
  s.change();
  await sleep(150);
  await s.driver.stop();
  assert.equal(s.builds(), 2);
});

test("a discarded analysis cache is logged", async () => {
  const logs = [];
  let fireChange;
  const watcher = { on: (e, cb) => { if (e === "change") fireChange = cb; }, update: () => {}, close: async () => {} };
  const driver = createDriver({
    workspaceDir: "/w", target: "//a:b", manifestPath: "/m.json", log: (l) => logs.push(l),
    createWatcher: () => watcher,
    createBuilder: ({ onAnalysisDiscarded }) => ({ request: async () => { onAnalysisDiscarded(); return { ok: true, ms: 1 }; } }),
    loadManifest: async () => mk({ a: "1" }),
  });
  await driver.start();
  fireChange(["/w/f.ts"]);
  await sleep(50);
  await driver.stop();
  assert.equal(logs[1], "analysis cache discarded: Bazel options changed (another command?); this build is slower");
});

test("a throwing watcher.update is logged and does not fail the build", async () => {
  const m2 = mk({ a: "2" }); m2.watch = { roots: ["app", "lib"], files: [] };
  const m1 = mk({ a: "1" }); m1.watch = { roots: ["app"], files: [] };
  let fireChange;
  const watcher = {
    on: (e, cb) => { if (e === "change") fireChange = cb; },
    update: () => { throw new Error("EMFILE"); },
    close: async () => {},
  };
  const logs = [];
  const manifests = [m1, m2];
  let loads = 0;
  const driver = createDriver({
    workspaceDir: "/w", target: "//a:b", manifestPath: "/m.json", log: (l) => logs.push(l),
    createWatcher: () => watcher, createBuilder: () => ({ request: async () => ({ ok: true, ms: 1 }) }),
    loadManifest: async () => manifests[loads++],
  });
  const events = [];
  for (const e of ["built", "failed"]) driver.on(e, () => events.push(e));
  await driver.start();
  fireChange(["/w/f.ts"]);
  await sleep(30);
  await driver.stop();
  assert.deepEqual(events, ["built"]);
  assert.ok(logs.includes("watcher error: EMFILE; roots unchanged"));
  assert.ok(!logs.some((l) => l.startsWith("build failed")));
});

const WIDE = { roots: [""], files: [] };

test("a failed build widens the watch to the workspace; the next good build narrows it", async () => {
  const s = setup({
    builds: [{ result: { ok: false, error: "boom", ms: 1 } }, { result: { ok: false, error: "boom", ms: 1 } }, { result: { ok: true, ms: 1 } }],
    manifests: [withWatch(["app"]), withWatch(["app"])],
  });
  await s.driver.start();
  s.change();
  await sleep(30);
  s.change();
  await sleep(30);
  s.change();
  await sleep(30);
  await s.driver.stop();
  assert.equal(s.builds(), 3);
  assert.deepEqual(s.updates, [WIDE, WIDE, { roots: ["app"], files: [] }]);
  assert.equal(s.logs[0], "watching app");
  assert.match(s.logs[1], /^build failed in /);
  assert.equal(s.logs[2], "watching . (last build failed; widened)");
  assert.match(s.logs[3], /^build failed in /);
  assert.match(s.logs[4], /^built in /);
  assert.equal(s.logs[5], "watching app");
  assert.equal(s.logs.length, 6);
});

test("a manifest that fails to load widens the watch too", async () => {
  const s = setup({
    builds: [{ result: { ok: true, ms: 1 } }],
    manifests: [withWatch(["app"])],
  });
  await s.driver.start();
  s.change();
  await sleep(30);
  await s.driver.stop();
  assert.deepEqual(s.updates, [WIDE]);
  assert.ok(s.logs.includes("watching . (last build failed; widened)"), JSON.stringify(s.logs));
});

test("a workspace-wide watch is not widened again or re-logged", async () => {
  const s = setup({
    builds: [{ result: { ok: false, error: "boom", ms: 1 } }, { result: { ok: true, ms: 1 } }],
    manifests: [mk({ a: "1" }), mk({ a: "1" })],
  });
  await s.driver.start();
  s.change();
  await sleep(30);
  s.change();
  await sleep(30);
  await s.driver.stop();
  assert.deepEqual(s.updates, [WIDE, WIDE]);
  assert.equal(s.logs.filter((l) => l.startsWith("watching")).length, 1);
});

test("a good build whose watch adds a path runs exactly one more cycle", async () => {
  const s = setup({
    builds: [{ result: { ok: true, ms: 1 } }, { result: { ok: true, ms: 1 } }, { result: { ok: true, ms: 1 } }],
    manifests: [withWatch(["app"]), withWatch(["app", "lib"]), withWatch(["app", "lib"]), withWatch(["app", "lib"])],
    update: (() => { let cur = JSON.stringify({ roots: ["app"], files: [] }); return (next) => {
      const added = JSON.stringify(next) === cur ? 0 : 1; cur = JSON.stringify(next); return { added, removed: 0 };
    }; })(),
  });
  await s.driver.start();
  s.change();
  await sleep(80);
  await s.driver.stop();
  assert.equal(s.builds(), 2);
  assert.equal(s.logs.filter((l) => l === "watching app, lib").length, 1);
});
