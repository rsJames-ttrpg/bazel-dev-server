// @ts-check
import path from "node:path";
import { init, parse } from "es-module-lexer";

await init;

/**
 * @typedef {{ entry: string, modules: Record<string, unknown>,
 *   npm: { dir: string, entries: Record<string, string> }, packages: Record<string, string> }} Manifest
 */

const SUFFIXES = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];

/** @param {string} p workspace-relative path without extension @param {Manifest} manifest */
function findKey(p, manifest) {
  if (p.startsWith("../") || p === "..") return null;
  for (const suffix of SUFFIXES) {
    if (Object.hasOwn(manifest.modules, p + suffix)) return p + suffix;
  }
  return null;
}

/** @param {string} spec @param {string} key @param {Manifest} manifest @returns {string | null} */
function resolve(spec, key, manifest) {
  const file = manifest.npm.entries[spec];
  if (file !== undefined) return `/npm/${file}`;
  for (const [name, root] of Object.entries(manifest.packages)) {
    if (spec === name || spec.startsWith(name + "/")) {
      const found = findKey(path.posix.normalize(root + spec.slice(name.length)), manifest);
      return found && `/${found}`;
    }
  }
  if (spec.startsWith("./") || spec.startsWith("../")) {
    const found = findKey(path.posix.join(path.posix.dirname(key), spec), manifest);
    return found && `/${found}`;
  }
  return null;
}

/**
 * Pure: rewrite the import specifiers of one transformed module to server URLs.
 * @param {string} code @param {string} key the module's manifest key @param {Manifest} manifest
 * @returns {{ code: string, unresolved: string[] }}
 */
export function rewriteImports(code, key, manifest) {
  const [imports] = parse(code);
  /** @type {Set<string>} */
  const unresolved = new Set();
  let out = code;
  // From the end, so earlier offsets stay valid as the string changes length.
  for (const imp of [...imports].reverse()) {
    if (imp.n === undefined || imp.d === -2) continue;
    const target = resolve(imp.n, key, manifest);
    if (target === null) {
      unresolved.add(imp.n);
      continue;
    }
    // Static imports span the bare specifier; dynamic ones span the quoted literal.
    const replacement = imp.d === -1 ? target : JSON.stringify(target);
    out = out.slice(0, imp.s) + replacement + out.slice(imp.e);
  }
  return { code: out, unresolved: [...unresolved].reverse() };
}
