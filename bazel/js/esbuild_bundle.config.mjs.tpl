// esbuild config for the production bundle, generated from
// //bazel/js:esbuild_bundle.config.mjs.tpl.
//
// process.cwd() is Bazel's bin directory: the rules_esbuild launcher changes
// into it, and every path below is relative to it.
//
// One plugin does both jobs:
//
// 1. Entry point. rules_esbuild only accepts entry points as file labels and
//    ignores an `entryPoints` key in a config file, so setup() replaces the
//    rule's placeholder entry with the app's transformed entry module, named
//    main. This requires output_dir = True.
//
// 2. package_name imports and stylesheets. A js_library's package_name ("@example/ui") maps to
//    the directory of its transformed outputs; imports of it, or of a subpath,
//    resolve there, the way the dev server resolves them from the manifest.
//    Every other bare specifier is left to esbuild's npm resolution.
import path from "node:path";

const ENTRY = %ENTRY%;
const PACKAGES = %PACKAGES%;

export default {
  plugins: [
    {
      name: "bundle-entry-and-packages",
      setup(build) {
        build.initialOptions.entryPoints = [{ in: path.resolve(process.cwd(), ENTRY), out: "main" }];
        // Lightning CSS already hashed *.module.css class names in the transform;
        // esbuild must not scope them again (its default loader for these is local-css).
        build.initialOptions.loader = { ...(build.initialOptions.loader ?? {}), ".module.css": "css" };
        /** @param {string} specifier @returns {string | undefined} */
        const packagePath = (specifier) => {
          for (const [name, dir] of Object.entries(PACKAGES)) {
            if (specifier === name || specifier.startsWith(name + "/")) {
              return path.resolve(process.cwd(), dir + specifier.slice(name.length));
            }
          }
          return undefined;
        };
        // Imports of a stylesheet resolve to its .css.js module; the module's own
        // import of the .css is left to esbuild, which collects it into main.css.
        build.onResolve({ filter: /\.css$/ }, (args) => {
          if (args.kind !== "import-statement" && args.kind !== "dynamic-import") return undefined;
          if (args.importer.endsWith(".css.js")) return undefined;
          const target = packagePath(args.path);
          if (target !== undefined) return { path: target + ".js" };
          if (args.path.startsWith(".") || path.isAbsolute(args.path)) {
            return { path: path.resolve(args.resolveDir, args.path) + ".js" };
          }
          return undefined; // another bare specifier: esbuild's npm resolution
        });
        build.onResolve({ filter: /^[^./]/ }, (args) => {
          const target = packagePath(args.path);
          if (target === undefined) return undefined;
          return build.resolve(target, { kind: args.kind, resolveDir: process.cwd() });
        });
      },
    },
  ],
};
