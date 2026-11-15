// @ts-check
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { renderIndex } from "./html.js";
import { rewriteImports } from "./rewrite.js";

const CLIENT_PATH = fileURLToPath(new URL("./client.js", import.meta.url));

/**
 * @typedef {import("./rewrite.js").Manifest & { indexHtml: string,
 *   modules: Record<string, { output: string, digest: string }> }} Manifest
 * @typedef {{ manifest: Manifest | null, on(event: string, cb: (...args: any[]) => void): unknown }} Driver
 */

/** @param {string} file */
function contentType(file) {
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".map")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

/**
 * Serves the app from the driver's current manifest and pushes reload and error
 * messages to browsers over a WebSocket at /@dev/ws.
 * @param {{ driver: Driver, executionRoot: string, port: number, log: (line: string) => void,
 *   appLabel: string }} opts
 */
export function createServer({ driver, executionRoot, port, log, appLabel }) {
  /** @type {Set<string>} */
  const reported = new Set();

  /** @param {string} rel execroot-relative path */
  const fromRoot = (rel) => readFile(path.join(executionRoot, rel));

  // Last good output per module key. A failed build deletes the outputs of the
  // failing actions, so the previous version must be held here to stay served.
  /** @type {Map<string, { digest: string, code: string }>} */
  const outputs = new Map();

  /** @param {string} key @param {{ output: string, digest: string }} mod */
  async function output(key, mod) {
    const held = outputs.get(key);
    if (held && held.digest === mod.digest) return held.code;
    const code = (await fromRoot(mod.output)).toString("utf8");
    outputs.set(key, { digest: mod.digest, code });
    return code;
  }

  /** Read every module of the current manifest whose output is not held yet. */
  async function holdOutputs() {
    const manifest = driver.manifest;
    if (!manifest) return;
    for (const key of outputs.keys()) if (!Object.hasOwn(manifest.modules, key)) outputs.delete(key);
    await Promise.all(
      Object.entries(manifest.modules).map(([key, mod]) =>
        output(key, mod).catch((err) => log(`cannot read output of ${key}: ${err instanceof Error ? err.message : err}`)),
      ),
    );
  }

  /**
   * @param {string} pathname
   * @returns {Promise<{ status: number, headers?: Record<string, string>, body: string | Buffer }>}
   */
  async function route(pathname) {
    const manifest = driver.manifest;
    if (!manifest) return { status: 503, body: "manifest not loaded yet" };
    if (pathname === "/" || pathname === "/index.html") {
      const html = renderIndex((await fromRoot(manifest.indexHtml)).toString("utf8"), manifest);
      return { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: html };
    }
    if (pathname === "/@dev/client.js") {
      return { status: 200, headers: { "content-type": contentType(CLIENT_PATH) }, body: await readFile(CLIENT_PATH) };
    }
    if (pathname.startsWith("/npm/")) {
      const file = pathname.slice("/npm/".length);
      if (file === "" || file.includes("/") || file.startsWith(".")) return { status: 404, body: "not found" };
      try {
        return { status: 200, headers: { "content-type": contentType(file) }, body: await fromRoot(path.join(manifest.npm.dir, file)) };
      } catch (err) {
        if (/** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") return { status: 404, body: "not found" };
        throw err;
      }
    }
    const key = pathname.slice(1);
    const mod = Object.hasOwn(manifest.modules, key) ? manifest.modules[key] : undefined;
    if (!mod) return { status: 404, body: "not found" };
    const { code, unresolved } = rewriteImports(await output(key, mod), key, manifest);
    for (const spec of unresolved) {
      if (reported.has(spec)) continue;
      reported.add(spec);
      log(`cannot resolve "${spec}" from ${key}; add it to npm_imports of ${appLabel}`);
    }
    return {
      status: 200,
      headers: { "content-type": "text/javascript; charset=utf-8", etag: mod.digest, "cache-control": "no-cache" },
      body: code,
    };
  }

  const server = http.createServer(async (req, res) => {
    let result;
    try {
      const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
      result = req.method === "GET" || req.method === "HEAD" ? await route(pathname) : { status: 404, body: "not found" };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`error serving ${req.url}: ${message}`);
      result = { status: 500, body: message };
    }
    res.writeHead(result.status, result.headers ?? { "content-type": "text/plain; charset=utf-8" });
    res.end(req.method === "HEAD" ? undefined : result.body);
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (new URL(req.url ?? "/", "http://localhost").pathname !== "/@dev/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  /** @param {object} message */
  function broadcast(message) {
    const data = JSON.stringify(message);
    for (const client of wss.clients) client.send(data);
  }

  // Events are handled in order: a reload goes out only once the new outputs are held.
  let events = Promise.resolve();
  // After a failure the next good build reloads even with no changes, which clears
  // the overlay when an edit is reverted to the last good content.
  let failed = false;
  driver.on("built", (/** @type {{ changed: string[], added: string[], removed: string[] }} */ e) => {
    if (!(e.changed.length || e.added.length || e.removed.length || failed)) return;
    failed = false;
    events = events.then(holdOutputs).then(() => broadcast({ type: "reload" }));
  });
  driver.on("failed", (/** @type {{ error: string }} */ e) => {
    failed = true;
    events = events.then(() => broadcast({ type: "error", message: e.error }));
  });

  return {
    /** @returns {Promise<number>} the bound port */
    async listen() {
      await holdOutputs();
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, () => {
          server.off("error", reject);
          resolve(/** @type {import("node:net").AddressInfo} */ (server.address()).port);
        });
      });
    },
    /** @returns {Promise<void>} */
    close() {
      for (const client of wss.clients) client.terminate();
      wss.close();
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}
