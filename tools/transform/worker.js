// @ts-check
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { transformCss } from "./css.js";
import { handlerFor } from "./handlers.js";
import { transformSource } from "./transform.js";

/** @param {string[]} argv */
function expandArgs(argv) {
  if (argv.length === 1 && argv[0].startsWith("@")) {
    return readFileSync(argv[0].slice(1), "utf8").split("\n").filter((l) => l !== "");
  }
  return argv;
}

/** @param {string} path */
function loadCompilerOptions(path) {
  const { compilerOptions } = JSON.parse(readFileSync(path, "utf8"));
  return {
    jsx: compilerOptions.jsx,
    target: compilerOptions.target,
    useDefineForClassFields: compilerOptions.useDefineForClassFields,
    verbatimModuleSyntax: compilerOptions.verbatimModuleSyntax ?? false,
  };
}

/** @param {string[]} rawArgs */
function handle(rawArgs) {
  /** @type {Record<string, string>} */
  const flags = {};
  const args = expandArgs(rawArgs);
  for (let i = 0; i < args.length; i += 2) flags[args[i].replace(/^--/, "")] = args[i + 1];
  for (const k of ["src", "out", "key", "meta", "dev", "tsconfig"]) {
    if (flags[k] === undefined) throw new Error(`missing --${k}`);
  }
  const src = readFileSync(flags.src, "utf8");
  const dev = flags.dev === "true";
  if (handlerFor(flags.src).kind === "css") {
    // Lightning CSS hashes module class names from the filename, so pass the
    // configuration-independent key: an exec path of a generated source holds
    // bazel-out/<config>/bin and would give dev and production different names.
    if (flags["css-out"] === undefined) throw new Error("missing --css-out");
    const { css, code, meta } = transformCss({ code: src, filename: flags.key, key: flags.key, dev });
    writeFileSync(flags["css-out"], css);
    writeFileSync(flags.out, code);
    writeFileSync(flags.meta, JSON.stringify(meta));
    return;
  }
  const { code, meta } = transformSource({
    code: src,
    filename: flags.src,
    key: flags.key,
    dev,
    compilerOptions: loadCompilerOptions(flags.tsconfig),
  });
  writeFileSync(flags.out, code);
  writeFileSync(flags.meta, JSON.stringify(meta));
}

const argv = process.argv.slice(2);
if (argv.includes("--persistent_worker")) {
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (line.trim() === "") return;
    let requestId = 0;
    try {
      const request = JSON.parse(line);
      requestId = request.requestId ?? 0;
      handle(request.arguments);
      process.stdout.write(JSON.stringify({ exitCode: 0, output: "", requestId }) + "\n");
    } catch (e) {
      const output = e instanceof Error ? e.message : String(e);
      process.stdout.write(JSON.stringify({ exitCode: 1, output, requestId }) + "\n");
    }
  });
} else {
  try {
    handle(argv);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
