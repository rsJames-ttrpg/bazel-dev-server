// @ts-check
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { transform } from "lightningcss";
import { initSync, parse } from "es-module-lexer";

initSync();

/**
 * @typedef {{ digest: string, kind: "css", refresh: boolean, imports: string[], exports: Record<string, string> }} CssMeta
 */

/**
 * Process one stylesheet with Lightning CSS and wrap it as an ES module.
 * `*.module.css` class names are hashed here, in both configurations.
 * @param {{ code: string, filename: string, key?: string, dev: boolean }} input
 * @returns {{ css: string, code: string, meta: CssMeta }}
 */
export function transformCss({ code, filename, key = filename, dev }) {
  let result;
  try {
    result = transform({
      filename,
      code: Buffer.from(code),
      minify: false,
      cssModules: filename.endsWith(".module.css"),
    });
  } catch (e) {
    const err = /** @type {any} */ (e);
    if (err && err.loc) throw new Error(`${err.fileName ?? filename}:${err.loc.line}:${err.loc.column}: ${err.message}`);
    throw e;
  }
  const css = result.code.toString();
  /** @type {Record<string, string>} */
  const exports = {};
  for (const [name, entry] of Object.entries(result.exports ?? {})) exports[name] = entry.name;
  const map = JSON.stringify(exports);

  const moduleCode = dev
    ? [
        `const css = ${JSON.stringify(css)};`,
        `const id = ${JSON.stringify(key)};`,
        'let el = document.head.querySelector(`style[data-dev-css="${id}"]`);',
        'if (!el) { el = document.createElement("style"); el.setAttribute("data-dev-css", id); document.head.appendChild(el); }',
        "el.textContent = css;",
        `export default ${map};`,
        "",
      ].join("\n")
    : `import ${JSON.stringify("./" + basename(filename))};\nexport default ${map};\n`;

  const [imports] = parse(moduleCode);
  const specifiers = imports.filter((i) => i.d === -1).map((i) => i.n).filter((n) => typeof n === "string");
  return {
    css,
    code: moduleCode,
    meta: {
      digest: createHash("sha256").update(moduleCode).digest("hex"),
      kind: "css",
      refresh: true,
      imports: /** @type {string[]} */ (specifiers),
      exports,
    },
  };
}
