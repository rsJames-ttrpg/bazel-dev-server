// @ts-check

/**
 * @typedef {{ manifest: { modules: Record<string, { digest: string, refresh: boolean, kind: "js" | "css" }> },
 *   changed: string[], added: string[], removed: string[], other?: string[] }} BuiltEvent
 * @typedef {{ type: "reload", reason: string }
 *   | { type: "update", modules: { key: string, digest: string, kind: "js" | "css" }[] }
 *   | { type: "ok" }} HmrMessage
 */

/**
 * Pure: what to push to browsers after a successful build. Added modules alone
 * need nothing: an importer that starts using them changed too.
 * @param {BuiltEvent} e
 * @param {boolean} [failed] the previous build failed (an overlay may be showing)
 * @returns {HmrMessage | null}
 */
export function decide(e, failed = false) {
  if (e.removed.length) return { type: "reload", reason: `${e.removed.length} removed` };
  const other = e.other ?? [];
  if (other.length) return { type: "reload", reason: `${other.join(", ")} changed` };
  const modules = e.manifest.modules;
  const stuck = e.changed.find((key) => !modules[key]?.refresh);
  if (stuck !== undefined) return { type: "reload", reason: `${stuck} cannot hot-update` };
  if (e.changed.length) {
    return { type: "update", modules: e.changed.map((key) => ({ key, digest: modules[key].digest, kind: modules[key].kind })) };
  }
  return failed ? { type: "ok" } : null;
}
