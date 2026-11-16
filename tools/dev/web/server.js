// @ts-check
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { decide } from "./hmr.js";
import { renderIndex } from "./html.js";
import { findUnresolved, isBareSpecifier, rewriteImports } from "./rewrite.js";

// The tool's own browser files, served from its runfiles at /@dev/<file>.
const DEV_FILES = new Set(["client.js", "refresh.js"]);
/** @param {string} file */
const devFilePath = (file) => fileURLToPath(new URL(`./${file}`, import.meta.url));

/**
 * @typedef {import("./rewrite.js").Manifest & { indexHtml: string,
 *   modules: Record<string, { output: string, digest: string, refresh: boolean, kind: "js" | "css" }> }} Manifest
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

  /** @param {string} spec @param {Manifest} manifest */
  const hintFor = (spec, manifest) =>
    isBareSpecifier(spec, manifest) ? `; add it to npm_imports of ${appLabel}` : `; not in srcs of ${appLabel} or its deps`;

  /**
   * Log every unresolved import of the manifest and return the overlay text.
   * @param {Manifest} manifest @returns {string | null}
   */
  function checkImports(manifest) {
    const list = findUnresolved(manifest);
    for (const { key, specifier } of list) log(`cannot resolve "${specifier}" from ${key}${hintFor(specifier, manifest)}`);
    if (!list.length) return null;
    return "unresolved imports:\n" + list.map(({ key, specifier }) => `  ${key}: "${specifier}"${hintFor(specifier, manifest)}`).join("\n");
  }

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
    if (pathname.startsWith("/@dev/")) {
      const file = pathname.slice("/@dev/".length);
      if (!DEV_FILES.has(file)) return { status: 404, body: "not found" };
      return { status: 200, headers: { "content-type": contentType(file) }, body: await readFile(devFilePath(file)) };
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
      log(`cannot resolve "${spec}" from ${key}${hintFor(spec, manifest)}`);
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

  /**
   * A browser page on another site may open a WebSocket to localhost; refuse any
   * Origin other than the dev server's own. Non-browser clients send no Origin.
   * @param {string | undefined} origin
   */
  function allowedOrigin(origin) {
    if (origin === undefined) return true;
    const bound = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
    return origin === `http://localhost:${bound}` || origin === `http://127.0.0.1:${bound}`;
  }

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (new URL(req.url ?? "/", "http://localhost").pathname !== "/@dev/ws" || !allowedOrigin(req.headers.origin)) {
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

  wss.on("connection", (ws) => {
    if (lastError !== null) ws.send(JSON.stringify({ type: "error", message: lastError }));
  });

  // Events are handled in order: an update or reload goes out only once the new
  // outputs are held.
  let events = Promise.resolve();
  // The overlay text a browser should be showing (failed build or unresolved
  // imports), or null. While set, the next build sends at least "ok", which
  // clears the overlay when an edit is reverted to the last good content.
  /** @type {string | null} */
  let lastError = null;
  driver.on("built", (/** @type {import("./hmr.js").BuiltEvent} */ e) => {
    const arrived = performance.now();
    const msg = decide(e, lastError !== null);
    lastError = checkImports(e.manifest);
    if (!msg) return;
    const error = lastError;
    events = events.then(holdOutputs).then(() => {
      broadcast(msg);
      if (error !== null) broadcast({ type: "error", message: error });
      if (msg.type === "update") log(`update: ${msg.modules.length} modules`);
      else if (msg.type === "reload") log(`reload: ${msg.reason}`);
      else if (msg.type === "ok") log("ok: overlay cleared");
      const ms = performance.now() - arrived;
      if (ms > 10) log(`pushed in ${Math.round(ms)}ms`);
    });
  });
  driver.on("failed", (/** @type {{ error: string }} */ e) => {
    lastError = e.error;
    events = events.then(() => broadcast({ type: "error", message: e.error }));
  });

  return {
    /** @returns {Promise<number>} the bound port */
    async listen() {
      await holdOutputs();
      if (driver.manifest) lastError = checkImports(driver.manifest);
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
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
