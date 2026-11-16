// @ts-check
import { EventEmitter } from "node:events";
import { createBuilder as realCreateBuilder } from "./builder.js";
import { diffManifests, loadManifest as realLoadManifest } from "./manifest.js";
import { createWatcher as realCreateWatcher } from "./watcher.js";

/** @typedef {import("./manifest.js").Manifest} Manifest */
/** @typedef {{ roots: string[], files: string[] }} WatchSet */

/** @param {Manifest} manifest @returns {WatchSet} what to watch; older manifests watch the workspace */
const watchSetOf = (manifest) => manifest.watch ?? { roots: [""], files: [] };

/** @param {WatchSet} w */
const watchingLine = (w) => `watching ${w.roots.map((r) => (r === "" ? "." : r)).join(", ")}`;

/**
 * Watches the app's source roots (from the manifest), rebuilds the manifest target once per change burst and emits
 * `building`, `waiting`, `built` and `failed`.
 * At most one build cycle (build plus manifest load) is in flight; changes during a cycle
 * trigger exactly one more cycle afterwards. A watcher error, or `requestBuild()`, counts
 * as a change. After a good build the watcher is re-rooted if the manifest's watch set changed.
 * @param {{ workspaceDir: string, target: string, manifestPath: string, log: (line: string) => void,
 *   createWatcher?: typeof realCreateWatcher, createBuilder?: typeof realCreateBuilder,
 *   loadManifest?: typeof realLoadManifest }} opts
 */
export function createDriver({
  workspaceDir,
  target,
  manifestPath,
  log,
  createWatcher = realCreateWatcher,
  createBuilder = realCreateBuilder,
  loadManifest = realLoadManifest,
}) {
  const emitter = new EventEmitter();
  /** @type {ReturnType<typeof createWatcher> | null} */
  let watcher = null;
  const builder = createBuilder({
    workspaceDir,
    target,
    onWaiting: () => {
      log("waiting for Bazel server (another command holds the lock)");
      emitter.emit("waiting");
    },
    onAnalysisDiscarded: () => {
      log("analysis cache discarded: Bazel options changed (another command?); this build is slower");
    },
  });

  let inFlight = false;
  let dirty = false;

  /** Serialise cycles: a change during a cycle sets `dirty`, which runs one more afterwards. */
  async function onChange() {
    if (inFlight) {
      dirty = true;
      return;
    }
    inFlight = true;
    try {
      do {
        dirty = false;
        await cycle();
      } while (dirty);
    } finally {
      inFlight = false;
    }
  }

  /** Run one build cycle, triggered by a change. */
  async function cycle() {
    const t0 = performance.now();
    emitter.emit("building");
    const result = await builder.request();
    const tBuilt = performance.now();
    if (!result.ok) {
      const ms = Math.round(tBuilt - t0);
      log(`build failed in ${ms}ms`);
      emitter.emit("failed", { error: result.error });
      return;
    }
    try {
      const next = await loadManifest(manifestPath);
      const tLoaded = performance.now();
      const prev = driver.manifest;
      const diff = diffManifests(prev, next);
      driver.manifest = next;
      const timings = {
        watchToBuild: Math.max(0, Math.round(tBuilt - t0 - result.ms)),
        bazel: result.ms,
        manifest: Math.round(tLoaded - tBuilt),
      };
      let line = `built in ${Math.round(tLoaded - t0)}ms (bazel ${result.ms}ms): ${diff.changed.length} modules changed`;
      if (diff.added.length) line += `, ${diff.added.length} added`;
      if (diff.removed.length) line += `, ${diff.removed.length} removed`;
      for (const what of diff.other) line += `, ${what} changed`;
      log(line);
      const nextWatch = watchSetOf(next);
      if (watcher && JSON.stringify(prev && watchSetOf(prev)) !== JSON.stringify(nextWatch)) {
        watcher.update(nextWatch);
        log(watchingLine(nextWatch));
      }
      emitter.emit("built", { manifest: next, ...diff, timings });
    } catch (err) {
      const ms = Math.round(performance.now() - t0);
      log(`build failed in ${ms}ms`);
      emitter.emit("failed", { error: `could not load manifest: ${err instanceof Error ? err.message : err}` });
    }
  }

  const driver = {
    /** @type {Manifest | null} */
    manifest: null,
    /** @returns {Promise<Manifest>} */
    async start() {
      driver.manifest = await loadManifest(manifestPath);
      const watch = watchSetOf(driver.manifest);
      watcher = createWatcher({ root: workspaceDir, roots: watch.roots, files: watch.files });
      watcher.on("change", () => {
        void onChange();
      });
      watcher.on("error", (/** @type {Error} */ err) => {
        log(`watcher error: ${err.message}; rebuilding`);
        void onChange();
      });
      log(watchingLine(watch));
      return driver.manifest;
    },
    /** Run a build cycle as if a file had changed (coalesces like a change). */
    requestBuild() {
      void onChange();
    },
    async stop() {
      const w = watcher;
      watcher = null;
      if (w) await w.close();
    },
    /** @param {string} event @param {(...args: any[]) => void} cb */
    on(event, cb) {
      emitter.on(event, cb);
      return driver;
    },
  };
  return driver;
}
