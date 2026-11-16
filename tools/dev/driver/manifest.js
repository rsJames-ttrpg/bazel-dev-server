// @ts-check
import { readFile } from "node:fs/promises";

/**
 * @typedef {{ output: string, digest: string, refresh: boolean, imports: string[] }} ManifestModule
 * @typedef {{ version: number, modules: Record<string, ManifestModule>, watch?: { roots: string[], files: string[] } } & Record<string, any>} Manifest
 */

/** @param {string} path @returns {Promise<Manifest>} */
export async function loadManifest(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

/**
 * Compare module digests per key. A null `prev` puts every key in `added`.
 * `other` lists "npm" and/or "index" when the npm directory or index.html digest changed.
 * @param {Manifest | null} prev @param {Manifest} next
 * @returns {{ changed: string[], added: string[], removed: string[], other: string[] }}
 */
export function diffManifests(prev, next) {
  const before = prev ? prev.modules : {};
  const after = next.modules;
  /** @type {string[]} */ const changed = [];
  /** @type {string[]} */ const added = [];
  for (const key of Object.keys(after)) {
    if (!(key in before)) added.push(key);
    else if (before[key].digest !== after[key].digest) changed.push(key);
  }
  const removed = Object.keys(before).filter((k) => !(k in after));
  /** @type {string[]} */ const other = [];
  if (prev) {
    if (prev.npm?.digest !== next.npm?.digest) other.push("npm");
    if (prev.indexDigest !== next.indexDigest) other.push("index");
  }
  return { changed, added, removed, other };
}
