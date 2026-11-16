// @ts-check
import { execFileSync } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { parseArgs } from "node:util";
import { createDriver } from "../driver/driver.js";
import { createServer } from "./server.js";

const workspaceDir = process.env.BUILD_WORKSPACE_DIRECTORY;
if (!workspaceDir) {
  console.error("BUILD_WORKSPACE_DIRECTORY is not set: start the dev server with `bazel run`.");
  process.exit(1);
}

const { values } = parseArgs({
  options: {
    manifest: { type: "string" },
    target: { type: "string" },
    app: { type: "string" },
    port: { type: "string" },
    "bazel-arg": { type: "string", multiple: true },
  },
});
const { manifest, target, app, port } = values;
const bazelArgs = values["bazel-arg"] ?? [];
if (!manifest || !target || !app || !port) {
  console.error("usage: main.js --manifest <path> --target <label> --app <label> --port <n> [--bazel-arg <flag>]...");
  process.exit(1);
}

/** The env for nested bazel invocations, cleaned the same way as the driver's builder. */
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([k]) => !k.startsWith("JS_BINARY__") && !k.startsWith("RUNFILES") && k !== "BAZEL_BINDIR",
  ),
);
/** @param {string[]} args @returns {string} trimmed stdout of a nested bazel command */
const bazel = (args) =>
  execFileSync("bazel", args, { cwd: workspaceDir, env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();

/** Runs a startup bazel command; on failure prints one line (the child's stderr is already shown) and exits. */
function startupBazel(/** @type {string} */ subcommand, /** @type {string[]} */ args) {
  try {
    return bazel([subcommand, ...args]);
  } catch (err) {
    const status = /** @type {{ status?: number | null }} */ (err).status;
    console.error(`dev server: bazel ${subcommand} failed (exit ${status ?? "unknown"})`);
    process.exit(1);
  }
}

const executionRoot = startupBazel("info", [...bazelArgs, "execution_root"]);

// The nested build sees only .bazelrc, not the flags of the outer `bazel run`. If
// those flags changed the output path, the nested build would write a manifest
// this server never reads, so refuse to start.
const nestedManifest = startupBazel("cquery", [
  ...bazelArgs,
  "--output=files",
  "--noshow_progress",
  "--ui_event_filters=-info",
  target,
]);
if (nestedManifest !== manifest) {
  console.error(
    `dev server: the running binary was built with different Bazel flags than the nested build will use (${manifest} vs ${nestedManifest}); put those flags in .bazelrc and run again`,
  );
  process.exit(1);
}

const log = console.log;
const driver = createDriver({ workspaceDir, target, bazelArgs, manifestPath: path.join(executionRoot, manifest), log });
await driver.start();
// `r` + Enter on an interactive terminal forces a rebuild (e.g. after the watcher missed something).
if (process.stdin.isTTY) {
  process.stdin.resume();
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    if (line.trim() !== "r") return;
    log("rebuild requested");
    driver.requestBuild();
  });
}
const server = createServer({ driver, executionRoot, port: Number(port), log, appLabel: app });
const bound = await server.listen();
log(`dev server at http://127.0.0.1:${bound}`);
