// @ts-check
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Pure: point the entry script of index.html at main.js and, when the bundle
 * has CSS, link main.css.
 * @param {string} html
 * @param {string} entry package-relative entry source, e.g. "src/main.tsx"
 * @param {boolean} hasCss
 */
export function renderBundleIndex(html, entry, hasCss) {
  const escaped = entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const script = new RegExp(`(<script\\s+type="module"\\s+src=)"\\./${escaped}"`);
  if (!script.test(html)) throw new Error(`entry script ./${entry} not found in index.html`);
  let out = html.replace(script, '$1"./main.js"');
  if (hasCss) out = out.replace("</head>", '<link rel="stylesheet" href="./main.css">\n</head>');
  return out;
}

/** @param {string[]} argv */
function expandArgs(argv) {
  if (argv.length === 1 && argv[0].startsWith("@")) {
    return readFileSync(argv[0].slice(1), "utf8").split("\n").filter((l) => l !== "");
  }
  return argv;
}

/** @param {string[]} rawArgs */
function main(rawArgs) {
  const args = expandArgs(rawArgs);
  /** @type {Record<string, string>} */
  const flags = {};
  for (let i = 0; i < args.length; i += 2) flags[args[i]] = args[i + 1];
  for (const k of ["--esbuild-dir", "--index", "--entry", "--out"]) {
    if (flags[k] === undefined) throw new Error(`missing ${k}`);
  }
  const esbuildDir = flags["--esbuild-dir"];
  const out = flags["--out"];
  mkdirSync(out, { recursive: true });
  // Copy file by file: Bazel's inputs may be symlinks, and cpSync would copy those as links.
  for (const e of readdirSync(esbuildDir, { recursive: true, withFileTypes: true })) {
    const src = path.join(e.parentPath, e.name);
    const dest = path.join(out, path.relative(esbuildDir, src));
    if (statSync(src).isDirectory()) mkdirSync(dest, { recursive: true });
    else copyFileSync(src, dest);
  }
  const hasCss = existsSync(path.join(esbuildDir, "main.css"));
  const html = readFileSync(flags["--index"], "utf8");
  writeFileSync(path.join(out, "index.html"), renderBundleIndex(html, flags["--entry"], hasCss));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
