// @ts-check
import { spawn as nodeSpawn } from "node:child_process";

/** @typedef {{ ok: true, ms: number } | { ok: false, error: string, ms: number }} BuildResult */

const TAIL_LINES = 60;

/** @param {NodeJS.ProcessEnv} env */
function nestedEnv(env) {
  /** @type {NodeJS.ProcessEnv} */
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith("JS_BINARY__") || k.startsWith("RUNFILES") || k === "BAZEL_BINDIR") continue;
    out[k] = v;
  }
  return out;
}

/**
 * Runs `bazel build <target>`, one at a time. Requests made during a build share a
 * single pending build that starts when the current one ends.
 * @param {{ workspaceDir: string, target: string, bazel?: string, spawn?: Function,
 *   waitingAfterMs?: number, onWaiting?: () => void }} opts
 * @returns {{ request(): Promise<BuildResult> }}
 */
export function createBuilder({
  workspaceDir,
  target,
  bazel = "bazel",
  spawn = nodeSpawn,
  waitingAfterMs = 2000,
  onWaiting = () => {},
}) {
  /** @type {Promise<BuildResult> | null} */
  let running = null;
  /** @type {Promise<BuildResult> | null} */
  let pending = null;

  /** @returns {Promise<BuildResult>} */
  function run() {
    const started = performance.now();
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(bazel, ["build", target], {
          cwd: workspaceDir,
          env: nestedEnv(process.env),
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err) {
        resolve({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          ms: Math.round(performance.now() - started),
        });
        return;
      }
      /** @type {string[]} */
      let lines = [];
      let partial = "";
      let allText = "";
      let progressed = false;

      const timer = setTimeout(() => {
        if (!progressed && allText.includes("Another command")) onWaiting();
      }, waitingAfterMs);

      /** @param {string} line */
      const pushLine = (line) => {
        lines.push(line);
        if (lines.length > TAIL_LINES) lines = lines.slice(-TAIL_LINES);
        if (line.includes("Analyzing") || line.includes("Loading")) progressed = true;
      };

      child.stderr.on("data", (/** @type {Buffer | string} */ chunk) => {
        const text = String(chunk);
        allText += text;
        const parts = (partial + text).split("\n");
        partial = /** @type {string} */ (parts.pop());
        for (const l of parts) pushLine(l);
      });

      child.on("exit", (/** @type {number | null} */ code) => {
        clearTimeout(timer);
        if (partial) pushLine(partial);
        const ms = Math.round(performance.now() - started);
        resolve(code === 0 ? { ok: true, ms } : { ok: false, error: lines.join("\n"), ms });
      });
      child.on("error", (/** @type {Error} */ err) => {
        clearTimeout(timer);
        resolve({ ok: false, error: err.message, ms: Math.round(performance.now() - started) });
      });
    });
  }

  /** @returns {Promise<BuildResult>} */
  function start() {
    const p = run();
    running = p;
    p.then(() => {
      if (running === p) running = null;
    });
    return p;
  }

  return {
    request() {
      if (pending) return pending;
      if (!running) return start();
      pending = running.then(() => {
        pending = null;
        return start();
      });
      return pending;
    },
  };
}
