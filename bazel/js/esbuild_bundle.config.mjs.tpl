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
// 2. package_name imports. A js_library's package_name ("@example/ui") maps to
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
        build.onResolve({ filter: /^[^./]/ }, (args) => {
          for (const [name, dir] of Object.entries(PACKAGES)) {
            if (args.path === name || args.path.startsWith(name + "/")) {
              return build.resolve(path.resolve(process.cwd(), dir + args.path.slice(name.length)), {
                kind: args.kind,
                resolveDir: process.cwd(),
              });
            }
          }
          return undefined;
        });
      },
    },
  ],
};
