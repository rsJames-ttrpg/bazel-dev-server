import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createBuilder } from "./builder.js";

function fakeSpawn(script) { // script: (child) => void, drives stderr/exit
  const spawned = [];
  const spawn = (cmd, args, opts) => {
    const child = new EventEmitter(); child.stderr = new EventEmitter(); child.stdout = new EventEmitter();
    child.args = args; child.opts = opts; spawned.push(child); setTimeout(() => script(child), 0); return child;
  };
  return { spawn, spawned };
}

test("coalesces requests during a build into one pending build", async () => {
  const { spawn, spawned } = fakeSpawn((c) => setTimeout(() => c.emit("exit", 0), 20));
  const b = createBuilder({ workspaceDir: "/w", target: "//a:b", spawn });
  const first = b.request();
  const p2 = b.request(); const p3 = b.request();
  assert.equal(p2, p3);
  await first; await p2;
  assert.equal(spawned.length, 2);
});
test("reports the stderr tail on failure", async () => {
  const { spawn } = fakeSpawn((c) => { c.stderr.emit("data", Buffer.from("ERROR: boom\n")); c.emit("exit", 1); });
  const b = createBuilder({ workspaceDir: "/w", target: "//a:b", spawn });
  const r = await b.request();
  assert.equal(r.ok, false); assert.match(r.error, /boom/);
});
test("strips the nested-run environment and runs in the workspace", async () => {
  const { spawn, spawned } = fakeSpawn((c) => c.emit("exit", 0));
  process.env.JS_BINARY__X = "1"; process.env.BAZEL_BINDIR = "x";
  await createBuilder({ workspaceDir: "/w", target: "//a:b", spawn }).request();
  assert.equal(spawned[0].opts.cwd, "/w");
  assert.equal(spawned[0].opts.env.JS_BINARY__X, undefined);
  assert.equal(spawned[0].opts.env.BAZEL_BINDIR, undefined);
});
test("calls onWaiting when another command holds the lock", async () => {
  let waited = false;
  const { spawn } = fakeSpawn((c) => { c.stderr.emit("data", Buffer.from("Another command (pid=1) is running. Waiting...\n")); setTimeout(() => c.emit("exit", 0), 40); });
  await createBuilder({ workspaceDir: "/w", target: "//a:b", spawn, waitingAfterMs: 10, onWaiting: () => { waited = true; } }).request();
  assert.equal(waited, true);
});
