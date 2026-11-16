// @ts-check
// Pure Fast Refresh boundary helpers, run in the browser by client.js and under
// node:test. The runtime is passed in so this file has no imports. Adapted from
// Vite's @vitejs/plugin-react refresh utils (MIT, Copyright (c) 2019-present
// Yuxi (Evan) You and Vite contributors).

/** @typedef {{ register(type: unknown, id: string): void, isLikelyComponentType(value: unknown): boolean }} RefreshRuntime */

/**
 * Register each component export of a module so a later version of it is
 * matched to the same family.
 * @param {RefreshRuntime} runtime @param {string} key @param {Record<string, unknown>} exports
 */
export function registerExportsForReactRefresh(runtime, key, exports) {
  for (const name of Object.keys(exports)) {
    const value = exports[name];
    if (runtime.isLikelyComponentType(value)) runtime.register(value, key + " export " + name);
  }
}

/**
 * Whether a module's new exports can replace its old ones in place.
 * @param {RefreshRuntime} runtime
 * @param {Record<string, unknown>} prev @param {Record<string, unknown>} next
 * @returns {string | null} the reason it cannot, or null when the update is safe
 */
export function validateRefreshBoundary(runtime, prev, next) {
  for (const k of Object.keys(prev)) if (!(k in next)) return `export ${k} removed`;
  for (const k of Object.keys(next)) if (!(k in prev)) return `export ${k} added`;
  const names = Object.keys(next);
  for (const k of names) {
    if (!runtime.isLikelyComponentType(next[k]) && prev[k] !== next[k]) return `export ${k} is not a component and changed`;
  }
  return names.length ? null : "no exports";
}
