// @ts-check

/**
 * Which transform handles a source file.
 * @param {string} filename
 * @returns {{ kind: "js" | "css" }}
 */
export function handlerFor(filename) {
  if (/\.(ts|tsx|js|jsx)$/.test(filename)) return { kind: "js" };
  if (filename.endsWith(".css")) return { kind: "css" };
  throw new Error(`no transform handler for ${filename}`);
}
