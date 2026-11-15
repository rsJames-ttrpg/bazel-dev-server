import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createDriver } from "./driver.js";

const mk = (mods) => ({ version: 1, modules: Object.fromEntries(Object.entries(mods).map(([k, d]) => [k, { digest: d, output: k, refresh: false, imports: [] }])) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setup({ builds, manifests }) {
  const logs = [];
  let fireChange;
  let requests = 0;
  const watcher = { on: (_e, cb) => { fireChange = cb; }, close: async () => {} };
  const builder = {
    request: async () => { const r = builds[requests++]; await sleep(r.delay ?? 0); return r.result; },
  };
  let loads = 0;
  const driver = createDriver({
    workspaceDir: "/w", target: "//a:b", manifestPath: "/m.json", log: (l) => logs.push(l),
    createWatcher: () => watcher, createBuilder: () => builder,
    loadManifest: async () => manifests[loads++],
  });
  const events = [];
  for (const e of ["building", "built", "failed"]) driver.on(e, (x) => events.push([e, x]));
  return { driver, logs, events, change: () => fireChange(["/w/f.ts"]), builds: () => requests };
}

test("one cycle per build: changes during a build trigger exactly one more", async () => {
  const s = setup({
    builds: [{ delay: 40, result: { ok: true, ms: 5 } }, { result: { ok: true, ms: 7 } }, { result: { ok: true, ms: 9 } }],
    manifests: [mk({ a: "1" }), mk({ a: "2" }), mk({ a: "2" })],
  });
  await s.driver.start();
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
  const watcher = { on: (_e, cb) => { fireChange = cb; }, close: async () => {} };
  const driver = createDriver({
    workspaceDir: "/w", target: "//a:b", manifestPath: "/m.json", log: (l) => logs.push(l),
    createWatcher: () => watcher,
    createBuilder: ({ onWaiting }) => ({ request: async () => { onWaiting(); return { ok: true, ms: 1 }; } }),
    loadManifest: async () => mk({ a: "1" }),
  });
  let waiting = 0;
  driver.on("waiting", () => { waiting++; });
  await driver.start();
  fireChange(["/w/f.ts"]);
  await sleep(50);
  await driver.stop();
  assert.equal(waiting, 1);
  assert.equal(logs[0], "waiting for Bazel server (another command holds the lock)");
});
