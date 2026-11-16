// @ts-check
import chokidar from "chokidar";
import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";

/**
 * Convert a glob (`**`, `*`, `?`) to a regex over a root-relative, "/"-separated path.
 * @param {string} glob
 */
function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") { re += "(?:.*/)?"; i += 2; }
      else if (re.endsWith("/")) { re += ".*"; i += 1; }
      else { re += ".*"; i += 1; }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export const DEFAULT_IGNORED = [
  "bazel-*", "bazel-*/**", "**/node_modules", "**/node_modules/**", "**/.git", "**/.git/**",
];

/**
 * Watch the given workspace-relative `roots` and `files` (`""` is `root` itself) and deliver
 * every file event within one debounce window as a single `change` call carrying the distinct
 * absolute paths. Watcher errors go to `error` listeners; they are never thrown.
 * `update` re-points the watcher and re-adds any watched root that was deleted and exists again
 * (chokidar never notices a deleted watched root coming back); it returns how many paths it
 * handed to chokidar to add and to unwatch.
 * @param {{ root: string, roots?: string[], files?: string[], debounceMs?: number, ignored?: string[], watch?: Function,
 *   exists?: (path: string) => boolean }} opts
 * @returns {{
 *   on(event: "change" | "error", cb: Function): void,
 *   update(next: { roots?: string[], files?: string[] }): { added: number, removed: number },
 *   close(): Promise<void>,
 * }}
 */
export function createWatcher({
  root,
  roots = [""],
  files = [],
  debounceMs = 20,
  ignored = DEFAULT_IGNORED,
  watch = chokidar.watch,
  exists = existsSync,
}) {
  /** @type {Array<(paths: string[]) => void>} */
  const listeners = [];
  /** @type {Array<(err: Error) => void>} */
  const errorListeners = [];
  /** @type {Set<string>} */
  let pending = new Set();
  /** @type {NodeJS.Timeout | null} */
  let timer = null;

  // chokidar 4 matches string globs by equality, so apply them via a function matcher.
  const patterns = ignored.map(globToRegExp);
  /** @param {string} p */
  const isIgnored = (p) => {
    const rel = relative(root, resolve(root, p)).split("\\").join("/");
    return rel !== "" && patterns.some((re) => re.test(rel));
  };

  /** @param {string} p */
  const toAbs = (p) => (p === "" ? root : resolve(root, p));
  /** @param {string[]} rs @param {string[]} fs_ */
  const toSet = (rs, fs_) => new Set([...rs, ...fs_].map(toAbs));

  /** @param {string} abs @param {string} w */
  const within = (abs, w) => abs === w || abs.startsWith(w.endsWith("/") ? w : w + "/");
  /** The paths events are delivered for. */
  let watched = toSet(roots, files);
  // Filter here rather than trust chokidar's unwatch: it ignores only the exact
  // unwatched path, so files under a removed root directory still emit events.
  /** @param {string} abs */
  const isWatched = (abs) => [...watched].some((w) => within(abs, w));
  /** The paths handed to chokidar and not unwatched; may be wider than `watched`. */
  const physical = new Set(watched);
  /** Watched roots seen deleted; chokidar will not see them come back. */
  /** @type {Set<string>} */
  const dead = new Set();
  /**
   * Record the watched roots a deletion at `abs` took with it. chokidar reports a deleted root
   * as `unlinkDir` of the root, but under load it may report only its files (or nothing but raw
   * events), so any deletion under a root also checks that the root still exists.
   * @param {string} abs @param {boolean} rootUnlinked the event is `unlinkDir` of `abs` itself
   */
  const noteDeletion = (abs, rootUnlinked) => {
    for (const w of watched) {
      if (within(abs, w) && ((rootUnlinked && abs === w) || !exists(w))) dead.add(w);
    }
  };
  const fs = watch([...watched], { ignored: isIgnored, ignoreInitial: true, followSymlinks: false });
  fs.on("raw", (/** @type {string} */ event, /** @type {string} */ _name, /** @type {{ watchedPath?: unknown }} */ details) => {
    if (event === "rename" && typeof details?.watchedPath === "string") noteDeletion(resolve(root, details.watchedPath), false);
  });
  fs.on("all", (/** @type {string} */ event, /** @type {string} */ path) => {
    const abs = resolve(root, path);
    if (event === "unlinkDir" || event === "unlink") noteDeletion(abs, event === "unlinkDir");
    if (!isWatched(abs)) return;
    pending.add(abs);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const paths = [...pending];
      pending = new Set();
      for (const cb of listeners) cb(paths);
    }, debounceMs);
  });
  fs.on("error", (/** @type {unknown} */ err) => {
    const error = err instanceof Error ? err : new Error(String(err));
    for (const cb of errorListeners) cb(error);
  });

  return {
    on(event, cb) {
      (event === "error" ? errorListeners : listeners).push(cb);
    },
    update({ roots: nextRoots = [""], files: nextFiles = [] }) {
      const next = toSet(nextRoots, nextFiles);
      // chokidar's unwatch ignores everything below the path too, so a path nested in (or
      // containing) one still wanted is never unwatched: widening to the workspace and
      // narrowing back keep the wider chokidar watch, and `isWatched` filters its events.
      const related = (/** @type {string} */ p) => [...next].some((n) => within(n, p) || within(p, n));
      const revived = [...dead].filter((p) => next.has(p) && exists(p));
      for (const p of revived) {
        dead.delete(p);
        physical.delete(p);
      }
      const added = [...next].filter((p) => ![...physical].some((w) => within(p, w)));
      const removed = [...physical].filter((p) => !related(p));
      watched = next;
      for (const p of added) physical.add(p);
      for (const p of removed) {
        physical.delete(p);
        dead.delete(p);
      }
      // A revived root may still look watched to chokidar, with deaf handles: drop them first.
      const stale = revived.filter((p) => added.includes(p));
      if (stale.length) fs.unwatch(stale);
      if (added.length) fs.add(added);
      if (removed.length) fs.unwatch(removed);
      return { added: added.length, removed: removed.length };
    },
    async close() {
      if (timer) clearTimeout(timer);
      timer = null;
      await fs.close();
    },
  };
}
