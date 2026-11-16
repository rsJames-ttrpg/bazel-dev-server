// @ts-check
import chokidar from "chokidar";
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
 * @param {{ root: string, roots?: string[], files?: string[], debounceMs?: number, ignored?: string[], watch?: Function }} opts
 * @returns {{
 *   on(event: "change" | "error", cb: Function): void,
 *   update(next: { roots?: string[], files?: string[] }): void,
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

  let watched = toSet(roots, files);
  // Filter here rather than trust chokidar's unwatch: it ignores only the exact
  // unwatched path, so files under a removed root directory still emit events.
  /** @param {string} abs */
  const isWatched = (abs) => [...watched].some((w) => abs === w || abs.startsWith(w.endsWith("/") ? w : w + "/"));
  const fs = watch([...watched], { ignored: isIgnored, ignoreInitial: true, followSymlinks: false });
  fs.on("all", (/** @type {string} */ _event, /** @type {string} */ path) => {
    const abs = resolve(root, path);
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
      const added = [...next].filter((p) => !watched.has(p));
      const removed = [...watched].filter((p) => !next.has(p));
      watched = next;
      if (added.length) fs.add(added);
      if (removed.length) fs.unwatch(removed);
    },
    async close() {
      if (timer) clearTimeout(timer);
      timer = null;
      await fs.close();
    },
  };
}
