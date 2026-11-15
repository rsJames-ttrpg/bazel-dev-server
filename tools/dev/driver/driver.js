// @ts-check
import { EventEmitter } from "node:events";
import { createBuilder } from "./builder.js";
import { diffManifests, loadManifest } from "./manifest.js";
import { createWatcher } from "./watcher.js";

/** @typedef {import("./manifest.js").Manifest} Manifest */

/**
 * Watches the workspace, rebuilds the manifest target once per change burst and emits
 * `building`, `waiting`, `built` and `failed`.
 * @param {{ workspaceDir: string, target: string, manifestPath: string, log: (line: string) => void }} opts
 */
export function createDriver({ workspaceDir, target, manifestPath, log }) {
  const emitter = new EventEmitter();
  /** @type {ReturnType<typeof createWatcher> | null} */
  let watcher = null;
  const builder = createBuilder({
    workspaceDir,
    target,
    onWaiting: () => emitter.emit("waiting"),
  });

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
      const diff = diffManifests(driver.manifest, next);
      driver.manifest = next;
      const timings = {
        watchToBuild: Math.max(0, Math.round(tBuilt - t0 - result.ms)),
        bazel: result.ms,
        manifest: Math.round(tLoaded - tBuilt),
      };
      let line = `built in ${Math.round(tLoaded - t0)}ms (bazel ${result.ms}ms): ${diff.changed.length} modules changed`;
      if (diff.added.length) line += `, ${diff.added.length} added`;
      if (diff.removed.length) line += `, ${diff.removed.length} removed`;
      log(line);
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
      watcher = createWatcher({ root: workspaceDir });
      watcher.on("change", () => {
        void cycle();
      });
      return driver.manifest;
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
