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
      else if (re.endsWith("/")) { re = re.slice(0, -1) + "(?:/.*)?"; i += 1; }
      else { re += ".*"; i += 1; }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

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

  // chokidar 4 matches string globs by equality, so apply them via a function matcher.
  const patterns = ignored.map(globToRegExp);
  /** @param {string} p */
  const isIgnored = (p) => {
    const rel = relative(root, resolve(root, p)).split("\\").join("/");
    return rel !== "" && patterns.some((re) => re.test(rel));
  };

  const fs = watch(root, { ignored: isIgnored, ignoreInitial: true, followSymlinks: false });
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
