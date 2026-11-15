// @ts-check
import { readFile } from "node:fs/promises";

/**
 * @typedef {{ output: string, digest: string, refresh: boolean, imports: string[] }} ManifestModule
 * @typedef {{ version: number, modules: Record<string, ManifestModule> } & Record<string, any>} Manifest
 */

/** @param {string} path @returns {Promise<Manifest>} */
export async function loadManifest(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

/**
 * Compare module digests per key. A null `prev` puts every key in `added`.
 * @param {Manifest | null} prev @param {Manifest} next
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
  return { changed, added, removed };
}
