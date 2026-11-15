// @ts-check
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * @typedef {{ digest: string, refresh: boolean, imports: string[] }} ModuleMeta
 * @typedef {{ key: string, output: string, meta: ModuleMeta }} ModuleInput
 */

/** @param {Record<string, string>} o @returns {Record<string, string>} */
function sortedRecord(o) {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * Pure: assemble the version 1 manifest. Keys are sorted so output is stable.
 * @param {{ pkg: string, entry: string, indexHtml: string, modules: ModuleInput[],
 *   npm: { dir: string, entries: Record<string, string> }, packages: Record<string, string> }} input
 */
export function buildManifest({ pkg, entry, indexHtml, modules, npm, packages }) {
  const sorted = [...modules].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  /** @type {Record<string, { output: string, digest: string, refresh: boolean, imports: string[] }>} */
  const out = {};
  for (const { key, output, meta } of sorted) {
    out[key] = { output, digest: meta.digest, refresh: meta.refresh, imports: meta.imports };
  }
  return {
    version: 1,
    package: pkg,
    entry,
    indexHtml,
    modules: out,
    npm: { dir: npm.dir, entries: sortedRecord(npm.entries) },
    packages: sortedRecord(packages),
  };
}

/** @param {string[]} argv */
function expandArgs(argv) {
  if (argv.length === 1 && argv[0].startsWith("@")) {
    return readFileSync(argv[0].slice(1), "utf8").split("\n").filter((l) => l !== "");
  }
  return argv;
}

/** @param {string} s @param {number} parts split on the first `parts - 1` "=" */
function splitEq(s, parts) {
  const out = [];
  let rest = s;
  for (let i = 0; i < parts - 1; i++) {
    const at = rest.indexOf("=");
    if (at < 0) throw new Error(`expected ${parts} "="-separated parts in: ${s}`);
    out.push(rest.slice(0, at));
    rest = rest.slice(at + 1);
  }
  out.push(rest);
  return out;
}

/** @param {string[]} rawArgs */
function main(rawArgs) {
  const args = expandArgs(rawArgs);
  /** @type {Record<string, string>} */
  const single = {};
  /** @type {ModuleInput[]} */
  const modules = [];
  /** @type {Record<string, string>} */
  const entries = {};
  /** @type {Record<string, string>} */
  const packages = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (value === undefined) throw new Error(`missing value for ${flag}`);
    if (flag === "--module") {
      const [key, output, metaPath] = splitEq(value, 3);
      modules.push({ key, output, meta: JSON.parse(readFileSync(metaPath, "utf8")) });
    } else if (flag === "--npm-entry") {
      const [spec, file] = splitEq(value, 2);
      entries[spec] = file;
    } else if (flag === "--package-root") {
      const [name, dir] = splitEq(value, 2);
      packages[name] = dir;
    } else if (["--out", "--package", "--entry", "--index", "--npm-dir"].includes(flag)) {
      single[flag] = value;
    } else {
      throw new Error(`unknown flag ${flag}`);
    }
  }
  const manifest = buildManifest({
    pkg: single["--package"],
    entry: single["--entry"],
    indexHtml: single["--index"],
    modules,
    npm: { dir: single["--npm-dir"] ?? "", entries },
    packages,
  });
  writeFileSync(single["--out"], JSON.stringify(manifest, null, 2) + "\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
