// esbuild config for npm_prebundle, generated from
// //bazel/js:esbuild_prebundle.config.mjs.tpl.
//
// Two jobs, both done by one plugin:
//
// 1. Entry points. rules_esbuild only accepts entry points as file labels and
//    ignores an `entryPoints` key in a config file, so setup() replaces the
//    rule's placeholder entry with one entry per bare specifier, named
//    { in, out } so "react-dom/client" becomes react-dom__client.js. esbuild
//    reads initialOptions after plugin setup, so the replacement takes effect.
//
// 2. Named exports. Bundling a CommonJS package (React) as an ESM entry point
//    yields only `export default module.exports`, so the browser's
//    `import { useState } from "react"` would fail. Each entry is therefore a
//    small virtual module that re-exports the package's export names, which
//    are read here by requiring the package under the same NODE_ENV the
//    bundle defines.
//
// 3. Stylesheets. A specifier ending in .css is loaded as text (the "text"
//    loader applies only here, and the prebundle never sees workspace CSS) and
//    its entry puts that text in a <style data-dev-css="<spec>"> element in
//    <head>, the way a workspace .css.js module does in dev.
import { createRequire } from "node:module";
import { join } from "node:path";

const entries = %ENTRY_POINTS%;
const nodeEnv = %NODE_ENV%;
const NAMESPACE = "npm-prebundle-entry";
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

function entrySource(specifier) {
  const spec = JSON.stringify(specifier);
  if (specifier.endsWith(".css")) {
    return [
      `import css from ${spec};`,
      `const el = document.createElement("style");`,
      `el.dataset.devCss = ${spec};`,
      `el.textContent = css;`,
      `document.head.append(el);`,
      `export default css;`,
    ].join("\n");
  }
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = nodeEnv;
  let mod;
  try {
    mod = createRequire(join(process.cwd(), "noop.js"))(specifier);
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
  if (mod && mod[Symbol.toStringTag] === "Module") {
    // An ES module package: esbuild keeps its exports as they are.
    const lines = [`export * from ${spec};`];
    if ("default" in mod) lines.push(`export { default } from ${spec};`);
    return lines.join("\n");
  }
  const names = Object.keys(Object(mod)).filter(
    (n) => n !== "default" && n !== "__esModule" && IDENTIFIER.test(n),
  );
  return [
    `import mod from ${spec};`,
    `export default mod;`,
    names.length ? `export const { ${names.join(", ")} } = mod;` : "",
  ].join("\n");
}

export default {
  plugins: [
    {
      name: "npm-prebundle-entries",
      setup(build) {
        build.initialOptions.loader = {
          ...build.initialOptions.loader,
          ".css": "text",
        };
        build.initialOptions.entryPoints = entries.map(({ in: spec, out }) => ({
          in: `${NAMESPACE}:${spec}`,
          out,
        }));
        build.onResolve({ filter: new RegExp(`^${NAMESPACE}:`) }, (args) => ({
          path: args.path.slice(NAMESPACE.length + 1),
          namespace: NAMESPACE,
        }));
        build.onLoad({ filter: /.*/, namespace: NAMESPACE }, (args) => ({
          contents: entrySource(args.path),
          loader: "js",
          resolveDir: process.cwd(),
        }));
      },
    },
  ],
};
