// @ts-check
import { execFileSync } from "node:child_process";
import path from "node:path";
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
  },
});
const { manifest, target, app, port } = values;
if (!manifest || !target || !app || !port) {
  console.error("usage: main.js --manifest <path> --target <label> --app <label> --port <n>");
  process.exit(1);
}

/** The env for nested bazel invocations, cleaned the same way as the driver's builder. */
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([k]) => !k.startsWith("JS_BINARY__") && !k.startsWith("RUNFILES") && k !== "BAZEL_BINDIR",
  ),
);
const executionRoot = execFileSync("bazel", ["info", "execution_root"], {
  cwd: workspaceDir,
  env,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
}).trim();

const log = console.log;
const driver = createDriver({ workspaceDir, target, manifestPath: path.join(executionRoot, manifest), log });
await driver.start();
const server = createServer({ driver, executionRoot, port: Number(port), log, appLabel: app });
const bound = await server.listen();
log(`dev server at http://localhost:${bound}`);
