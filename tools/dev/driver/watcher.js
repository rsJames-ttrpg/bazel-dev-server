// @ts-check
import chokidar from "chokidar";
import { resolve } from "node:path";

/**
 * Watch `root` and deliver every file event within one debounce window as a single
 * `change` call carrying the distinct absolute paths.
 * @param {{ root: string, debounceMs?: number, ignored?: string[], watch?: Function }} opts
 * @returns {{ on(event: "change", cb: (paths: string[]) => void): void, close(): Promise<void> }}
 */
export function createWatcher({
  root,
  debounceMs = 20,
  ignored = ["**/bazel-*/**", "**/node_modules/**", "**/.git/**"],
  watch = chokidar.watch,
}) {
  /** @type {Array<(paths: string[]) => void>} */
  const listeners = [];
  /** @type {Set<string>} */
  let pending = new Set();
  /** @type {NodeJS.Timeout | null} */
  let timer = null;

  const fs = watch(root, { ignored, ignoreInitial: true });
  fs.on("all", (/** @type {string} */ _event, /** @type {string} */ path) => {
    pending.add(resolve(root, path));
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const paths = [...pending];
      pending = new Set();
      for (const cb of listeners) cb(paths);
    }, debounceMs);
  });

  return {
    on(_event, cb) {
      listeners.push(cb);
    },
    async close() {
      if (timer) clearTimeout(timer);
      timer = null;
      await fs.close();
    },
  };
}
