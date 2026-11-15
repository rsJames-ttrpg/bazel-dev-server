import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "./server.js";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "devsrv-"));
  await fs.mkdir(path.join(root, "out"), { recursive: true });
  await fs.writeFile(path.join(root, "out/main.js"), `import "./App";`);
  await fs.writeFile(path.join(root, "out/index.html"), `<html><head></head><body><script type="module" src="./src/main.tsx"></script></body></html>`);
  const manifest = { version: 1, entry: "app/src/main.tsx", indexHtml: "out/index.html", packages: {}, npm: { dir: "out", entries: {} },
    modules: { "app/src/main.tsx": { output: "out/main.js", digest: "d1", refresh: false, imports: ["./App"] } } };
  const driver = new EventEmitter(); driver.manifest = manifest;
  return { root, driver };
}

test("serves index, module and 404", async () => {
  const { root, driver } = await fixture();
  const s = createServer({ driver, executionRoot: root, port: 0, log: () => {}, appLabel: "//app:app" });
  const port = await s.listen();
  const idx = await fetch(`http://localhost:${port}/`); assert.equal(idx.status, 200);
  assert.match(await idx.text(), /\/@dev\/client\.js/);
  const mod = await fetch(`http://localhost:${port}/app/src/main.tsx`);
  assert.equal(mod.headers.get("content-type").split(";")[0], "text/javascript");
  assert.equal(mod.headers.get("etag"), "d1");
  const gone = await fetch(`http://localhost:${port}/app/src/Gone.tsx`); assert.equal(gone.status, 404);
  await s.close();
});
test("reload only when something changed", async () => {
  const { root, driver } = await fixture();
  const s = createServer({ driver, executionRoot: root, port: 0, log: () => {}, appLabel: "//app:app" });
  const port = await s.listen();
  const ws = new (await import("ws")).WebSocket(`ws://localhost:${port}/@dev/ws`);
  const got = []; ws.on("message", (m) => got.push(JSON.parse(m.toString())));
  await new Promise((r) => ws.on("open", r));
  driver.emit("built", { manifest: driver.manifest, changed: [], added: [], removed: [] });
  driver.emit("built", { manifest: driver.manifest, changed: ["app/src/main.tsx"], added: [], removed: [] });
  driver.emit("failed", { error: "boom" });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(got.map((g) => g.type), ["reload", "error"]);
  ws.close(); await s.close();
});
test("keeps serving the last good output when a failed build deletes it", async (t) => {
  const { root, driver } = await fixture();
  const s = createServer({ driver, executionRoot: root, port: 0, log: () => {}, appLabel: "//app:app" });
  const port = await s.listen();
  t.after(() => s.close());
  await fs.rm(path.join(root, "out/main.js"));
  driver.emit("failed", { error: "boom" });
  const mod = await fetch(`http://localhost:${port}/app/src/main.tsx`);
  assert.equal(mod.status, 200);
  assert.match(await mod.text(), /import "\.\/App"/);
});
test("unresolved specifier is logged once across requests", async (t) => {
  const { root, driver } = await fixture();
  const lines = [];
  const s = createServer({ driver, executionRoot: root, port: 0, log: (l) => lines.push(l), appLabel: "//app:app" });
  const port = await s.listen();
  t.after(() => s.close());
  await (await fetch(`http://localhost:${port}/app/src/main.tsx`)).text();
  await (await fetch(`http://localhost:${port}/app/src/main.tsx`)).text();
  assert.deepEqual(lines, [`cannot resolve "./App" from app/src/main.tsx; add it to npm_imports of //app:app`]);
});
test("first build after a failure reloads even with no changes", async (t) => {
  const { root, driver } = await fixture();
  const s = createServer({ driver, executionRoot: root, port: 0, log: () => {}, appLabel: "//app:app" });
  const port = await s.listen();
  t.after(() => s.close());
  const ws = new (await import("ws")).WebSocket(`ws://localhost:${port}/@dev/ws`);
  const got = []; ws.on("message", (m) => got.push(JSON.parse(m.toString())));
  await new Promise((r) => ws.on("open", r));
  t.after(() => ws.close());
  driver.emit("failed", { error: "boom" });
  driver.emit("built", { manifest: driver.manifest, changed: [], added: [], removed: [] });
  driver.emit("built", { manifest: driver.manifest, changed: [], added: [], removed: [] });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(got.map((g) => g.type), ["error", "reload"]);
});
