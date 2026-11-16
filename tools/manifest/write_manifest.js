// @ts-check
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * @typedef {{ digest: string, kind?: string, refresh: boolean, imports: string[] }} ModuleMeta
 * @typedef {{ key: string, output: string, meta: ModuleMeta }} ModuleInput
 */

/** @param {Record<string, string>} o @returns {Record<string, string>} */
function sortedRecord(o) {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * Pure: assemble the version 2 manifest. Keys are sorted so output is stable.
 * @param {{ pkg: string, entry: string, indexHtml: string, indexDigest: string, modules: ModuleInput[],
 *   npm: { dir: string, digest: string, entries: Record<string, string> }, packages: Record<string, string> }} input
 */
export function buildManifest({ pkg, entry, indexHtml, indexDigest, modules, npm, packages }) {
  const sorted = [...modules].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  /** @type {Record<string, { output: string, digest: string, kind: string, refresh: boolean, imports: string[] }>} */
  const out = {};
  for (const { key, output, meta } of sorted) {
    out[key] = { output, digest: meta.digest, kind: meta.kind ?? "js", refresh: meta.refresh, imports: meta.imports };
  }
  return {
    version: 2,
    package: pkg,
    entry,
    indexHtml,
    indexDigest,
    modules: out,
    npm: { dir: npm.dir, digest: npm.digest, entries: sortedRecord(npm.entries) },
    packages: sortedRecord(packages),
  };
}

/** @param {string | Buffer} data */
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/** @param {string} file */
export function fileDigest(file) {
  return sha256(readFileSync(file));
}

/**
 * SHA-256 over the sorted relative file names of `dir`, each followed by that file's
 * SHA-256. An empty `dir` (no npm directory) digests to the hash of nothing.
 * @param {string} dir
 */
export function dirDigest(dir) {
  const hash = createHash("sha256");
  if (dir === "") return hash.digest("hex");
  const files = /** @type {string[]} */ (readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join("/")))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const name of files) hash.update(`${name}\0${fileDigest(path.join(dir, name))}\n`);
  return hash.digest("hex");
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
  const npmDir = single["--npm-dir"] ?? "";
  const manifest = buildManifest({
    pkg: single["--package"],
    entry: single["--entry"],
    indexHtml: single["--index"],
    indexDigest: fileDigest(single["--index"]),
    modules,
    npm: { dir: npmDir, digest: dirDigest(npmDir), entries },
    packages,
  });
  writeFileSync(single["--out"], JSON.stringify(manifest, null, 2) + "\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
