// @ts-check
import { createHash } from "node:crypto";
import { transformSync } from "@swc/core";
import { initSync, parse } from "es-module-lexer";

initSync();

/**
 * @typedef {{ jsx: string, target: string, useDefineForClassFields: boolean, verbatimModuleSyntax?: boolean }} CompilerOptions
 * @typedef {{ digest: string, kind: "js", refresh: boolean, imports: string[] }} TransformMeta
 */

/**
 * Register this module's components with the client refresh runtime under `key`.
 * Without window.__devRefresh the registration calls are no-ops.
 * @param {string} body SWC output
 * @param {string} key
 */
function wrapForRefresh(body, key) {
  const k = JSON.stringify(key);
  const kId = JSON.stringify(key + " ");
  return [
    "const __refresh = window.__devRefresh;",
    "const __prevRefreshReg = window.$RefreshReg$, __prevRefreshSig = window.$RefreshSig$;",
    `window.$RefreshReg$ = __refresh ? (type, id) => window.__devRefresh.register(type, ${kId} + id) : () => {};`,
    "window.$RefreshSig$ = __refresh ? __refresh.createSignatureFunctionForTransform : () => (type) => type;",
    body,
    "window.$RefreshReg$ = __prevRefreshReg; window.$RefreshSig$ = __prevRefreshSig;",
    `if (__refresh) __refresh.registerModule(${k}, import.meta.url);`,
    "",
  ].join("\n");
}

/**
 * @param {{ code: string, filename: string, key?: string, dev: boolean, compilerOptions: CompilerOptions }} input
 * @returns {{ code: string, meta: TransformMeta }}
 */
export function transformSource({ code, filename, key = filename, dev, compilerOptions }) {
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
  const refresh = dev && isJsx && out.code.includes("$RefreshReg$");
  const finalCode = refresh ? wrapForRefresh(out.code, key) : out.code;
  const [imports] = parse(finalCode);
  const specifiers = imports.filter((i) => i.d === -1).map((i) => i.n).filter((n) => typeof n === "string");
  return {
    code: finalCode,
    meta: {
      digest: createHash("sha256").update(finalCode).digest("hex"),
      kind: "js",
      refresh,
      imports: /** @type {string[]} */ (specifiers),
    },
  };
}
