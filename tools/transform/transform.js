// @ts-check
import { createHash } from "node:crypto";
import { transformSync } from "@swc/core";
import { initSync, parse } from "es-module-lexer";

initSync();

/**
 * @typedef {{ jsx: string, target: string, useDefineForClassFields: boolean, verbatimModuleSyntax?: boolean }} CompilerOptions
 * @typedef {{ digest: string, refresh: boolean, imports: string[] }} TransformMeta
 */

/**
 * @param {{ code: string, filename: string, dev: boolean, compilerOptions: CompilerOptions }} input
 * @returns {{ code: string, meta: TransformMeta }}
 */
export function transformSource({ code, filename, dev, compilerOptions }) {
  const isJsx = filename.endsWith(".tsx") || filename.endsWith(".jsx");
  const isTs = filename.endsWith(".ts") || filename.endsWith(".tsx");
  const parser = isTs
    ? { syntax: /** @type {const} */ ("typescript"), tsx: filename.endsWith(".tsx") }
    : { syntax: /** @type {const} */ ("ecmascript"), jsx: isJsx };
  const out = transformSync(code, {
    filename,
    isModule: true,
    sourceMaps: false,
    minify: false,
    swcrc: false,
    configFile: false,
    module: { type: "es6" },
    jsc: {
      parser,
      target: /** @type {any} */ (compilerOptions.target.toLowerCase()),
      transform: {
        useDefineForClassFields: compilerOptions.useDefineForClassFields,
        verbatimModuleSyntax: compilerOptions.verbatimModuleSyntax ?? false,
        react: { runtime: "automatic", development: dev, refresh: dev },
      },
    },
  });
  const [imports] = parse(out.code);
  const specifiers = imports.filter((i) => i.d === -1).map((i) => i.n).filter((n) => typeof n === "string");
  return {
    code: out.code,
    meta: {
      digest: createHash("sha256").update(code).digest("hex"),
      refresh: dev && isJsx && out.code.includes("$RefreshReg$"),
      imports: /** @type {string[]} */ (specifiers),
    },
  };
}
