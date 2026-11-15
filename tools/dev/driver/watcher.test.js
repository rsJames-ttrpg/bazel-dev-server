import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
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
