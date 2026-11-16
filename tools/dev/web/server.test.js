import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "./server.js";

/** Give the fixture's entry only resolvable imports. */
function resolvable(driver) { driver.manifest.modules["app/src/main.tsx"].imports = ["./App"]; }

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "devsrv-"));
  await fs.mkdir(path.join(root, "out"), { recursive: true });
  await fs.writeFile(path.join(root, "out/main.js"), `import "./App"; import "./Missing";`);
  await fs.writeFile(path.join(root, "out/App.js"), `export function App() {}`);
  await fs.writeFile(path.join(root, "out/s.css.js"), `export default {};`);
  await fs.writeFile(path.join(root, "out/index.html"), `<html><head></head><body><script type="module" src="./src/main.tsx"></script></body></html>`);
  const manifest = { version: 1, entry: "app/src/main.tsx", indexHtml: "out/index.html", packages: {}, npm: { dir: "out", entries: {} },
    modules: {
      "app/src/main.tsx": { output: "out/main.js", digest: "d1", refresh: false, imports: ["./App", "./Missing"], kind: "js" },
      "app/src/App.tsx": { output: "out/App.js", digest: "d2", refresh: true, imports: [], kind: "js" },
      "app/src/s.css": { output: "out/s.css.js", digest: "d3", refresh: true, imports: [], kind: "css" },
    } };
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
  const { root, driver } = await fixture(); resolvable(driver);
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
test("reload when only the npm directory or index.html changed", async (t) => {
  const { root, driver } = await fixture(); resolvable(driver);
  const s = createServer({ driver, executionRoot: root, port: 0, log: () => {}, appLabel: "//app:app" });
  const port = await s.listen();
  t.after(() => s.close());
  const ws = new (await import("ws")).WebSocket(`ws://localhost:${port}/@dev/ws`);
  const got = []; ws.on("message", (m) => got.push(JSON.parse(m.toString())));
  await new Promise((r) => ws.on("open", r));
  t.after(() => ws.close());
  driver.emit("built", { manifest: driver.manifest, changed: [], added: [], removed: [], other: [] });
  driver.emit("built", { manifest: driver.manifest, changed: [], added: [], removed: [], other: ["npm"] });
  driver.emit("built", { manifest: driver.manifest, changed: [], added: [], removed: [], other: ["index"] });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(got.map((g) => g.type), ["reload", "reload"]);
});
test("WebSocket upgrades from another origin are refused", async (t) => {
  const { root, driver } = await fixture();
  const s = createServer({ driver, executionRoot: root, port: 0, log: () => {}, appLabel: "//app:app" });
  const port = await s.listen();
  t.after(() => s.close());
  const { WebSocket } = await import("ws");
  /** @param {string} origin @returns {Promise<string>} "open" or "refused" */
  const tryOrigin = (origin) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${port}/@dev/ws`, { origin });
    ws.on("open", () => { ws.close(); resolve("open"); });
    ws.on("error", () => resolve("refused"));
  });
  assert.equal(await tryOrigin("http://evil.example"), "refused");
  assert.equal(await tryOrigin(`http://localhost:${port}`), "open");
  assert.equal(await tryOrigin(`http://127.0.0.1:${port}`), "open");
});
test("listens on the loopback interface only", async (t) => {
  const { root, driver } = await fixture();
  const s = createServer({ driver, executionRoot: root, port: 0, log: () => {}, appLabel: "//app:app" });
  const port = await s.listen();
  t.after(() => s.close());
  assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
  const other = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal);
  if (other) await assert.rejects(fetch(`http://${other.address}:${port}/`));
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
  assert.match(await mod.text(), /import "\/app\/src\/App\.tsx"/);
});
test("unresolved specifier is logged once across requests", async (t) => {
  const { root, driver } = await fixture();
  const lines = [];
  const s = createServer({ driver, executionRoot: root, port: 0, log: (l) => lines.push(l), appLabel: "//app:app" });
  const port = await s.listen();
  t.after(() => s.close());
  await (await fetch(`http://localhost:${port}/app/src/main.tsx`)).text();
  await (await fetch(`http://localhost:${port}/app/src/main.tsx`)).text();
  const line = `cannot resolve "./Missing" from app/src/main.tsx; not in srcs of //app:app or its deps`;
  // once when the server starts listening, once for the first request, not again
  assert.deepEqual(lines, [line, line]);
});
test("an unresolved bare specifier suggests npm_imports", async (t) => {
  const { root, driver } = await fixture();
  await fs.writeFile(path.join(root, "out/main.js"), `import "lodash";`);
  const lines = [];
  const s = createServer({ driver, executionRoot: root, port: 0, log: (l) => lines.push(l), appLabel: "//app:app" });
  const port = await s.listen();
  t.after(() => s.close());
  await (await fetch(`http://localhost:${port}/app/src/main.tsx`)).text();
  assert.ok(lines.includes(`cannot resolve "lodash" from app/src/main.tsx; add it to npm_imports of //app:app`), JSON.stringify(lines));
});
test("first build after a failure sends ok even with no changes", async (t) => {
  const { root, driver } = await fixture(); resolvable(driver);
  const lines = [];
  const s = createServer({ driver, executionRoot: root, port: 0, log: (l) => lines.push(l), appLabel: "//app:app" });
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
  assert.deepEqual(got.map((g) => g.type), ["error", "ok"]);
  assert.ok(lines.includes("ok: overlay cleared"), `log lines: ${JSON.stringify(lines)}`);
});
test("update for refresh modules, reload otherwise, ok after failure", async (t) => {
  const { root, driver } = await fixture(); resolvable(driver);
  const s = createServer({ driver, executionRoot: root, port: 0, log: () => {}, appLabel: "//app:app" });
  const port = await s.listen();
  t.after(() => s.close());
  const ws = new (await import("ws")).WebSocket(`ws://localhost:${port}/@dev/ws`);
  const got = []; ws.on("message", (m) => got.push(JSON.parse(m.toString())));
  await new Promise((r) => ws.on("open", r));
  t.after(() => ws.close());
  driver.emit("failed", { error: "boom" });
  driver.emit("built", { manifest: driver.manifest, changed: [], added: [], removed: [], other: [] });
  driver.emit("built", { manifest: driver.manifest, changed: ["app/src/App.tsx"], added: [], removed: [], other: [] });
  driver.emit("built", { manifest: driver.manifest, changed: ["app/src/main.tsx"], added: [], removed: [], other: [] });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(got.map((g) => g.type), ["error", "ok", "update", "reload"]);
  assert.deepEqual(got[2].modules, [{ key: "app/src/App.tsx", digest: "d2", kind: "js" }]);
});
test("module routes ignore the query string and serve refresh.js", async (t) => {
  const { root, driver } = await fixture();
  const s = createServer({ driver, executionRoot: root, port: 0, log: () => {}, appLabel: "//app:app" });
  const port = await s.listen();
  t.after(() => s.close());
  const mod = await fetch(`http://localhost:${port}/app/src/main.tsx?v=abc`); assert.equal(mod.status, 200);
  const r = await fetch(`http://localhost:${port}/@dev/refresh.js`); assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type").split(";")[0], "text/javascript");
  const no = await fetch(`http://localhost:${port}/@dev/server.js`); assert.equal(no.status, 404);
});

async function connect(port, t) {
  const ws = new (await import("ws")).WebSocket(`ws://localhost:${port}/@dev/ws`);
  const got = []; ws.on("message", (m) => got.push(JSON.parse(m.toString())));
  await new Promise((r) => ws.on("open", r));
  t.after(() => ws.close());
  return got;
}
const settle = () => new Promise((r) => setTimeout(r, 50));
test("unresolved imports after a build are shown and replayed to new connections", async (t) => {
  const { root, driver } = await fixture();
  const lines = [];
  const s = createServer({ driver, executionRoot: root, port: 0, log: (l) => lines.push(l), appLabel: "//app:app" });
  const port = await s.listen();
  t.after(() => s.close());
  const got1 = await connect(port, t);
  const ev = (changed) => ({ manifest: driver.manifest, changed, added: [], removed: [] });
  driver.emit("built", ev(["app/src/App.tsx"]));
  await settle();
  // the first "error" is the replay on connect of the startup check
  assert.deepEqual(got1.map((g) => g.type), ["error", "update", "error"]);
  assert.match(got1[2].message, /app\/src\/main\.tsx: "\.\/Missing"/);
  const got2 = await connect(port, t);
  await settle();
  assert.deepEqual(got2, [got1[2]]);
  resolvable(driver);
  driver.emit("built", ev([]));
  await settle();
  assert.deepEqual(got1.map((g) => g.type), ["error", "update", "error", "ok"]);
  assert.deepEqual(got2.map((g) => g.type), ["error", "ok"]);
  assert.ok(lines.includes(`cannot resolve "./Missing" from app/src/main.tsx; not in srcs of //app:app or its deps`));
  const got3 = await connect(port, t);
  await settle();
  assert.deepEqual(got3, []);
});
test("a connection during a failed build gets the overlay", async (t) => {
  const { root, driver } = await fixture();
  resolvable(driver);
  const s = createServer({ driver, executionRoot: root, port: 0, log: () => {}, appLabel: "//app:app" });
  const port = await s.listen();
  t.after(() => s.close());
  driver.emit("failed", { error: "boom" });
  const got = await connect(port, t);
  await settle();
  assert.deepEqual(got[0], { type: "error", message: "boom" });
});
