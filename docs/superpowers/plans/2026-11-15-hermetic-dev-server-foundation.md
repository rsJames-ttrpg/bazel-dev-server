# Hermetic Dev Server Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `bazel run //examples/hello:hello.dev` serves a React TypeScript app whose every module is a Bazel output, and reloads the page within about half a second of a save.

**Architecture:** Bazel rules turn each TypeScript source into one ES module through an SWC persistent worker and write a manifest of outputs and digests. A Node dev server, itself a Bazel binary, watches the sources, runs one nested `bazel build` per change, diffs the manifest, and tells the browser over a WebSocket to reload. The production bundle is esbuild over the same module tree. This plan covers spec milestones 1 and 2 plus the npm prebundle React needs; Fast Refresh, CSS and hardening (milestones 3 to 5) are a second plan.

**Tech Stack:** Bazel 8 with bzlmod, Aspect rules_js 2.x and rules_esbuild, Node 22, pnpm lockfile, @swc/core, es-module-lexer, chokidar 4, ws 8, React 19. Tooling is written in JavaScript ESM with `// @ts-check` JSDoc types and tested with `node:test` through rules_js `js_test`, so the tools never depend on the transform they implement.

**Spec:** `docs/superpowers/specs/2026-11-15-hermetic-dev-server-design.md`

## Global Constraints

- Every file the browser loads is a Bazel output. The dev server reads files only from Bazel's execution root and never transforms source itself.
- The dev configuration is reached only through the `//bazel/js:dev` `bool_flag` set by a rule transition in `dev_config`, never through a command-line flag.
- One `bazel build` per change; the builder never runs two builds at once and coalesces requests that arrive during a build into one pending build.
- One root `tsconfig.json` is the source of truth for `jsx`, `target` and `useDefineForClassFields`; SWC options are derived from it.
- Module URLs are the file's workspace-relative path, for example `/examples/hello/src/main.tsx`. Manifest keys are the same path.
- Warm save-to-reload on `examples/hello` must log under 600 ms; the server logs timings for every cycle.
- A failed build keeps the last good manifest served and reports the error; the server process never exits on a build failure.
- Linux and macOS only. No Windows code paths.
- Commits are small and frequent; every task ends with a commit on `main`.

## Review Focus

- A source file deleted while the server runs: the next build succeeds, the module leaves the manifest, and a request for its old URL returns 404 instead of crashing. Test in Task 6 (`diffManifests` removed set) and Task 7 (404 route test).
- A module that imports an npm specifier not listed in `npm_imports`: the server serves the module with the specifier untouched and logs one clear line naming the specifier and the `react_app` target, rather than silently producing a browser error. Test in Task 7 (`rewriteImports` unresolved list).
- A burst of hundreds of file events, such as a branch checkout: one build runs, not hundreds. Test in Task 6 (watcher debounce and builder coalescing tests).
- Another terminal holding the Bazel server lock: the driver emits `waiting` after 2 s and the build still completes afterwards. Test in Task 6 (builder test with a fake spawn that delays output).
- A save that changes no output, such as a type-only edit that leaves the output unchanged: the cycle logs `0 modules changed` and the browser is not reloaded. Test in Task 6 (`diffManifests` equal digests) and Task 7 (no `reload` message when `changed` is empty).

---

## Repo layout this plan produces

```
MODULE.bazel, .bazelversion, .bazelrc, BUILD.bazel
package.json, pnpm-lock.yaml, pnpm-workspace.yaml, tsconfig.json
bazel/js/BUILD.bazel
bazel/js/providers.bzl        JsSourceInfo, ModulesInfo
bazel/js/js_library.bzl       js_library rule
bazel/js/transform.bzl        transform_modules rule (per-file worker actions)
bazel/js/manifest.bzl         app_manifest rule
bazel/js/dev.bzl              dev bool_flag, dev_config transition rule
bazel/js/npm.bzl              npm_prebundle macro (esbuild with splitting)
bazel/js/react_app.bzl        react_app macro
tools/transform/transform.js  transformSource()
tools/transform/worker.js     Bazel JSON worker protocol + one-shot CLI
tools/manifest/write_manifest.js
tools/dev/driver/{watcher,builder,manifest,driver}.js
tools/dev/web/{rewrite,html,server,main}.js, client.js
examples/hello/{BUILD.bazel,index.html,src/main.tsx,src/App.tsx}
```

---

### Task 1: Repository scaffold

**Files:**
- Create: `MODULE.bazel`, `.bazelversion`, `.bazelrc`, `BUILD.bazel`, `.gitignore`
- Create: `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `tsconfig.json`
- Create: `bazel/js/BUILD.bazel` (empty package for now)

**Interfaces:**
- Produces: `//:node_modules/<pkg>` targets for `react`, `react-dom`, `@swc/core`, `es-module-lexer`, `chokidar`, `ws`, `typescript`, `@types/react`, `@types/react-dom`, `@types/node`. Root `tsconfig.json` with `compilerOptions.jsx = "react-jsx"`, `target = "ES2022"`, `module = "ESNext"`, `moduleResolution = "bundler"`, `strict = true`, `isolatedModules = true`, `useDefineForClassFields = true`, `noEmit = true`.

- [ ] **Step 1: Write `.bazelversion` with `8.3.1` and `MODULE.bazel`**

Module name `hermetic_dev_server`. `bazel_dep` on `aspect_rules_js` 2.x, `aspect_rules_esbuild` 0.22 or newer, `aspect_bazel_lib` 2.x, `rules_nodejs` 6.x with a Node 22 toolchain. Use the `npm` extension with `npm_translate_lock(pnpm_lock = "//:pnpm-lock.yaml")` and `use_repo(npm, "npm")`. Register the esbuild toolchain at its latest 0.2x version.

- [ ] **Step 2: Write `.bazelrc`**

Lines: `common --enable_bzlmod`, `build --incompatible_strict_action_env`, `test --test_output=errors`, `build --worker_verbose` left off. Nothing else.

- [ ] **Step 3: Write `package.json` and `pnpm-workspace.yaml`, then generate the lockfile**

`package.json` is private, `"type": "module"`, with `dependencies`: `react` ^19, `react-dom` ^19; `devDependencies`: `@swc/core` ^1.7, `es-module-lexer` ^1.5, `chokidar` ^4, `ws` ^8, `typescript` ^5.6, `@types/react`, `@types/react-dom`, `@types/node` ^22. `pnpm-workspace.yaml` lists `packages: ["."]`.

Run: `bazel run -- @pnpm//:pnpm --dir $PWD install --lockfile-only`
Expected: `pnpm-lock.yaml` exists.

- [ ] **Step 4: Write root `BUILD.bazel` and `tsconfig.json`**

`BUILD.bazel`: `load("@npm//:defs.bzl", "npm_link_all_packages")` then `npm_link_all_packages(name = "node_modules")`. Also `exports_files(["tsconfig.json"])`. `tsconfig.json` carries the compilerOptions in the Interfaces block above and `"include": []` (apps add their own includes later).

- [ ] **Step 5: Verify the module graph resolves**

Run: `bazel build //:node_modules/react //:node_modules/@swc/core`
Expected: `INFO: Build completed successfully`.

- [ ] **Step 6: Write `.gitignore` with `bazel-*` and `node_modules/`, then commit**

```bash
git add -A
git commit -m "chore: bazel and pnpm scaffold"
```

---

### Task 2: SWC transform and Bazel worker

**Files:**
- Create: `tools/transform/transform.js`, `tools/transform/worker.js`, `tools/transform/BUILD.bazel`
- Test: `tools/transform/transform.test.js`

**Interfaces:**
- Consumes: `//:node_modules/@swc/core`, `//:node_modules/es-module-lexer`.
- Produces:
  - `transformSource({ code: string, filename: string, dev: boolean, compilerOptions: { jsx: string, target: string, useDefineForClassFields: boolean } }): { code: string, meta: { digest: string, refresh: boolean, imports: string[] } }` in `transform.js`. `digest` is lowercase hex SHA-256 of `code`. `imports` is every static import and re-export specifier in the output, in source order, from es-module-lexer. `refresh` is true when `dev` is true, `filename` ends in `.tsx` or `.jsx`, and the output contains `$RefreshReg$`.
  - `//tools/transform:worker`, a `js_binary` whose CLI takes `--src <path> --out <path> --meta <path> --dev true|false --tsconfig <path>` either directly or as one `@argsfile`, and that with `--persistent_worker` speaks Bazel's JSON worker protocol (newline-delimited `{"arguments":[...],"inputs":[...],"requestId":n}` in, `{"exitCode":0,"output":"","requestId":n}` out). It writes `code` to `--out` and `meta` as JSON to `--meta`.

- [ ] **Step 1: Write the failing tests**

```js
// tools/transform/transform.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { transformSource } from "./transform.js";
const opts = { jsx: "react-jsx", target: "ES2022", useDefineForClassFields: true };

test("strips types and keeps ESM", () => {
  const r = transformSource({ code: "import x from './a'; export const n: number = 1;", filename: "f.ts", dev: false, compilerOptions: opts });
  assert.match(r.code, /import x from ['"]\.\/a['"]/);
  assert.doesNotMatch(r.code, /number/);
  assert.deepEqual(r.meta.imports, ["./a"]);
  assert.match(r.meta.digest, /^[0-9a-f]{64}$/);
});
test("tsx uses the automatic runtime and records the jsx-runtime import", () => {
  const r = transformSource({ code: "export const A = () => <div/>;", filename: "A.tsx", dev: false, compilerOptions: opts });
  assert.ok(r.meta.imports.includes("react/jsx-runtime"));
  assert.equal(r.meta.refresh, false);
});
test("dev tsx has refresh registration", () => {
  const r = transformSource({ code: "export const A = () => <div/>;", filename: "A.tsx", dev: true, compilerOptions: opts });
  assert.match(r.code, /\$RefreshReg\$/);
  assert.equal(r.meta.refresh, true);
});
test("same input gives same digest", () => {
  const a = transformSource({ code: "export const n = 1;", filename: "f.ts", dev: false, compilerOptions: opts });
  const b = transformSource({ code: "export const n = 1;", filename: "f.ts", dev: false, compilerOptions: opts });
  assert.equal(a.meta.digest, b.meta.digest);
});
```

- [ ] **Step 2: Add the `js_test` target and run it to see it fail**

`tools/transform/BUILD.bazel`: `js_test(name = "transform_test", entry_point = "transform.test.js", data = ["transform.js", "//:node_modules/@swc/core", "//:node_modules/es-module-lexer"])`.

Run: `bazel test //tools/transform:transform_test`
Expected: FAIL, cannot find module `./transform.js`.

- [ ] **Step 3: Implement `transformSource` in `tools/transform/transform.js`**

Use `transformSync` from `@swc/core` with `jsc.parser` set from the extension (`tsx: true` for `.tsx`), `jsc.transform.react.runtime = "automatic"`, `jsc.transform.react.refresh = dev`, `jsc.transform.react.development = dev`, `jsc.target` from `compilerOptions.target` lowercased, `jsc.transform.useDefineForClassFields` from options, `module.type = "es6"`, `isModule: true`, no minify, no source maps yet. Call `es-module-lexer`'s `initSync` once and `parse` the output for `imports`.

- [ ] **Step 4: Run the test until it passes**

Run: `bazel test //tools/transform:transform_test`
Expected: PASS, 4 tests.

- [ ] **Step 5: Implement `tools/transform/worker.js`**

Export nothing; it is a CLI. One-shot: parse argv (expanding one `@file` argument into lines), read `--tsconfig` JSON once per process and take `compilerOptions.jsx`, `target`, `useDefineForClassFields`, read `--src`, call `transformSource`, write `--out` and `--meta`. With `--persistent_worker`: loop over stdin lines, each a JSON request, run the same handler on `request.arguments`, write one JSON response line per request to stdout; any thrown error becomes `exitCode: 1` with the message in `output`. Never write anything else to stdout in worker mode; diagnostics go to stderr. Add `js_binary(name = "worker", entry_point = "worker.js", data = ["transform.js", "//:node_modules/@swc/core", "//:node_modules/es-module-lexer"])` to the BUILD file.

- [ ] **Step 6: Verify one-shot mode by hand**

Run: `printf 'export const n: number = 1;\n' > /tmp/claude-1000/-home-jackm-repos-hermetic-dev-server/064aa7cc-c660-4395-b9a0-71a59d5c2bec/scratchpad/t.ts && bazel run //tools/transform:worker -- --src $_ --out /tmp/claude-1000/-home-jackm-repos-hermetic-dev-server/064aa7cc-c660-4395-b9a0-71a59d5c2bec/scratchpad/t.js --meta /tmp/claude-1000/-home-jackm-repos-hermetic-dev-server/064aa7cc-c660-4395-b9a0-71a59d5c2bec/scratchpad/t.meta.json --dev false --tsconfig $PWD/tsconfig.json && cat /tmp/claude-1000/-home-jackm-repos-hermetic-dev-server/064aa7cc-c660-4395-b9a0-71a59d5c2bec/scratchpad/t.meta.json`
Expected: `t.js` contains `export const n = 1;`, meta JSON has `digest`, `refresh: false`, `imports: []`.

- [ ] **Step 7: Commit**

```bash
git add tools/transform
git commit -m "feat: swc transform and bazel json worker"
```

---

### Task 3: `js_library`, `transform_modules`, dev flag and transition

**Files:**
- Create: `bazel/js/providers.bzl`, `bazel/js/js_library.bzl`, `bazel/js/transform.bzl`, `bazel/js/dev.bzl`
- Modify: `bazel/js/BUILD.bazel`
- Create: `examples/hello/BUILD.bazel`, `examples/hello/src/main.tsx`, `examples/hello/src/App.tsx`, `examples/hello/index.html`

**Interfaces:**
- Consumes: `//tools/transform:worker` CLI from Task 2.
- Produces:
  - `JsSourceInfo(srcs: depset[File], packages: dict[str, str])` where `packages` maps a `package_name` such as `@acme/ui` to the directory of that library's `BUILD` file, workspace-relative.
  - `js_library(name, srcs, deps = [], package_name = "")` returning `JsSourceInfo` with the transitive `srcs` and merged `packages`, plus `DefaultInfo`.
  - `ModulesInfo(modules: list[struct(src: File, out: File, meta: File)], packages: dict)`.
  - `transform_modules(name, deps, tsconfig = "//:tsconfig.json")`: for each file in the transitive `srcs` of `deps` with extension `.ts` or `.tsx`, one worker action writing `<name>/<src.short_path without extension>.js` and `<same>.js.meta.json`. Returns `DefaultInfo(files = all outs and metas)` and `ModulesInfo`. Reads the dev flag from a private `_dev` attribute defaulting to `//bazel/js:dev`.
  - `//bazel/js:dev`, a `bool_flag` default `False`.
  - `dev_config(name, target)`: a rule with a self transition setting `//bazel/js:dev` to `True`. Returns `DefaultInfo(files = <target's default files>, runfiles = <target's runfiles merged with its files>)`.

- [ ] **Step 1: Write the providers and `js_library`**

`providers.bzl` defines `JsSourceInfo` and `ModulesInfo` as above. `js_library.bzl` collects `depset(ctx.files.srcs, transitive = [d[JsSourceInfo].srcs for d in ctx.attr.deps])` and merges `packages`, adding `ctx.attr.package_name: ctx.label.package` when `package_name` is set.

- [ ] **Step 2: Write `dev.bzl`**

`load("@bazel_skylib//rules:common_settings.bzl", "BuildSettingInfo")` and declare the `bool_flag` in `bazel/js/BUILD.bazel` as `dev`. The transition sets `"//bazel/js:dev": True` with `inputs = []`. If Bazel 8 rejects the rule for lacking an allowlist, add the `_allowlist_function_transition` attribute pointing at `@bazel_tools//tools/allowlists/function_transition_allowlist`. Add `bazel_skylib` to `MODULE.bazel` if it is not already a transitive dep that can be loaded.

- [ ] **Step 3: Write `transform.bzl`**

Per file: `args = ctx.actions.args()`, `args.use_param_file("@%s", use_always = True)`, `args.set_param_file_format("multiline")`, add `--src`, `--out`, `--meta`, `--dev true|false`, `--tsconfig`. `ctx.actions.run(executable = ctx.executable._worker, arguments = [args], inputs = [src, tsconfig], outputs = [out, meta], mnemonic = "JsTransform", execution_requirements = {"supports-workers": "1", "requires-worker-protocol": "json"}, progress_message = "Transforming " + src.short_path)`. `_worker` is `attr.label(default = "//tools/transform:worker", executable = True, cfg = "exec")`.

- [ ] **Step 4: Write the example app and its BUILD file**

`src/App.tsx` exports a component rendering `<h1>Hello from Bazel</h1>` and a counter button using `useState`. `src/main.tsx` does `createRoot(document.getElementById("root")!).render(<App />)`. `index.html` has `<div id="root"></div>` and `<script type="module" src="./src/main.tsx"></script>`. `BUILD.bazel` declares `js_library(name = "src", srcs = glob(["src/**/*.ts", "src/**/*.tsx"]))` and `transform_modules(name = "hello.modules", deps = [":src"])`, plus `dev_config(name = "hello.modules.dev", target = ":hello.modules")`. Loads come from `//bazel/js:js_library.bzl`, `transform.bzl`, `dev.bzl`.

- [ ] **Step 5: Verify outputs and the worker**

Run: `bazel build //examples/hello:hello.modules --worker_verbose 2>&1 | tail -5 && ls bazel-bin/examples/hello/hello.modules/examples/hello/src/`
Expected: build succeeds; the directory lists `App.js`, `App.js.meta.json`, `main.js`, `main.js.meta.json`; stderr mentions `JsTransform` worker.

- [ ] **Step 6: Verify a one-file edit is one action**

Run: `echo '// edit' >> examples/hello/src/App.tsx && bazel build //examples/hello:hello.modules 2>&1 | grep -E 'processes|actions'`
Expected: a line like `INFO: 2 processes: 1 internal, 1 worker.` (one `JsTransform` only). Then revert the edit with `git checkout examples/hello/src/App.tsx`.

- [ ] **Step 7: Verify the transition yields a second configuration with refresh on**

Run: `bazel build //examples/hello:hello.modules.dev && grep -l 'RefreshReg' $(bazel cquery --output=files //examples/hello:hello.modules.dev 2>/dev/null | grep 'App.js$')`
Expected: the dev-config `App.js` path is printed, and it lives under a `bazel-out/*-ST-*/bin` directory distinct from the default one.

- [ ] **Step 8: Commit**

```bash
git add bazel examples MODULE.bazel
git commit -m "feat: js_library, transform_modules and dev transition"
```

---

### Task 4: Manifest

**Files:**
- Create: `tools/manifest/write_manifest.js`, `tools/manifest/BUILD.bazel`, `bazel/js/manifest.bzl`
- Test: `tools/manifest/write_manifest.test.js`
- Modify: `examples/hello/BUILD.bazel`

**Interfaces:**
- Consumes: `ModulesInfo` from Task 3; meta JSON from Task 2.
- Produces:
  - Manifest JSON, version 1:
    ```json
    {
      "version": 1,
      "package": "examples/hello",
      "entry": "examples/hello/src/main.tsx",
      "indexHtml": "<execroot-relative path>",
      "modules": {
        "examples/hello/src/main.tsx": { "output": "bazel-out/.../main.js", "digest": "…", "refresh": false, "imports": ["react-dom/client", "./App"] }
      },
      "npm": { "dir": "bazel-out/.../hello.npm", "entries": { "react": "react.js", "react/jsx-runtime": "react__jsx-runtime.js" } },
      "packages": {}
    }
    ```
    All paths are execroot-relative (`File.path`); keys and `entry` are workspace-relative (`File.short_path`).
  - `buildManifest({ pkg, entry, indexHtml, modules: Array<{ key, output, meta: object }>, npm: { dir, entries }, packages }): object` in `write_manifest.js`, pure, and a CLI taking `--out`, `--package`, `--entry`, `--index`, `--npm-dir`, repeated `--npm-entry <specifier>=<file>`, repeated `--module <key>=<output>=<metaPath>`, repeated `--package-root <name>=<dir>`, via one `@argsfile`.
  - `app_manifest(name, modules, entry, index_html, npm_dir, npm_entries: dict[str, str], packages)` rule in `manifest.bzl` producing `<name>.json`. `npm_dir` is a label whose default output directory is passed as a path; its `npm_entries` dict is passed through. (The npm target comes from Task 5; until then the example passes an empty dict and no dir.)

- [ ] **Step 1: Write the failing test**

```js
// tools/manifest/write_manifest.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { buildManifest } from "./write_manifest.js";

test("builds a version 1 manifest keyed by workspace path", () => {
  const m = buildManifest({
    pkg: "examples/hello", entry: "examples/hello/src/main.tsx", indexHtml: "bazel-out/x/bin/examples/hello/index.html",
    modules: [{ key: "examples/hello/src/main.tsx", output: "bazel-out/x/bin/m.js", meta: { digest: "ab", refresh: false, imports: ["./App"] } }],
    npm: { dir: "bazel-out/x/bin/examples/hello/hello.npm", entries: { react: "react.js" } }, packages: {},
  });
  assert.equal(m.version, 1);
  assert.deepEqual(Object.keys(m.modules), ["examples/hello/src/main.tsx"]);
  assert.equal(m.modules["examples/hello/src/main.tsx"].digest, "ab");
  assert.deepEqual(m.modules["examples/hello/src/main.tsx"].imports, ["./App"]);
  assert.equal(m.npm.entries.react, "react.js");
});
test("module keys are sorted so the file is stable", () => {
  const m = buildManifest({ pkg: "p", entry: "p/b.ts", indexHtml: "i", packages: {}, npm: { dir: "", entries: {} },
    modules: [{ key: "p/b.ts", output: "o", meta: { digest: "1", refresh: false, imports: [] } }, { key: "p/a.ts", output: "o", meta: { digest: "2", refresh: false, imports: [] } }] });
  assert.deepEqual(Object.keys(m.modules), ["p/a.ts", "p/b.ts"]);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `bazel test //tools/manifest:write_manifest_test` (after adding the `js_test` with `data = ["write_manifest.js"]`)
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `buildManifest` and the CLI in `write_manifest.js`, plus `js_binary(name = "write_manifest")`**

The CLI reads each meta file from disk and calls `buildManifest`, then writes JSON with two-space indentation to `--out`.

- [ ] **Step 4: Run the test**

Run: `bazel test //tools/manifest:write_manifest_test`
Expected: PASS, 2 tests.

- [ ] **Step 5: Write `manifest.bzl` and wire it into the example**

The rule's action passes `out.path`, `meta.path` and `src.short_path` per module from `ModulesInfo`, `ctx.file.index_html.path`, and the npm dir's path via `ctx.files.npm_dir[0].path` when `npm_dir` is set. Inputs are all metas, all module `.js` outputs, the index file and the npm dir. The `.js` outputs are declared as inputs even though the script never reads them, so that building the manifest target builds every module and npm bundle the server will serve; this is what lets the dev server's nested build target just `<name>.manifest.dev`. In `examples/hello/BUILD.bazel` add `app_manifest(name = "hello.manifest", modules = ":hello.modules", entry = "src/main.tsx", index_html = "index.html")` and change `dev_config` to `target = ":hello.manifest"`, renaming it `hello.manifest.dev`.

- [ ] **Step 6: Verify**

Run: `bazel build //examples/hello:hello.manifest.dev && python3 -I -c "import json,sys; m=json.load(open(sys.argv[1])); print(m['entry'], list(m['modules']), m['modules'][m['entry']]['output'])" $(bazel cquery --output=files //examples/hello:hello.manifest.dev 2>/dev/null)`
Expected: prints `examples/hello/src/main.tsx`, both module keys, and an output path containing `-ST-` (the dev configuration).

- [ ] **Step 7: Commit**

```bash
git add tools/manifest bazel/js/manifest.bzl examples/hello/BUILD.bazel
git commit -m "feat: app manifest rule"
```

---

### Task 5: npm prebundle, production bundle and the `react_app` macro

**Files:**
- Create: `bazel/js/npm.bzl`, `bazel/js/react_app.bzl`, `bazel/js/esbuild_prebundle.config.mjs.tpl`
- Modify: `examples/hello/BUILD.bazel`, `MODULE.bazel`, `bazel/js/BUILD.bazel`

**Interfaces:**
- Consumes: Tasks 3 and 4.
- Produces:
  - `npm_prebundle(name, npm_imports: list[str], npm_deps: list[Label], dev: bool)` macro: one `esbuild` target from rules_esbuild with `entry_points` for every specifier, `splitting = True`, `format = "esm"`, `output_dir = True`, `define = {"process.env.NODE_ENV": '"development"' or '"production"'}`, and a generated config file mapping each specifier to the output name `specifier.replace("/", "__")`. Returns the target's `npm_entries` dict for the manifest.
  - `react_app(name, srcs, deps = [], entry, index_html, npm_imports, npm_deps, port = 5173)` macro declaring: `<name>.src` (js_library), `<name>.modules`, `<name>.npm`, `<name>.manifest`, `<name>.manifest.dev` (dev_config), `<name>.bundle` (esbuild over the modules with `entry_point` the transformed entry, `splitting = False`, `deps = npm_deps`, `output_dir = True`, `define NODE_ENV production`, plus a copied `index.html` whose entry `src` is rewritten to `./main.js`), and `<name>.dev` (filled in by Task 7; for now the macro declares everything else).
  - `examples/hello` uses `react_app(name = "hello", srcs = glob([...]), entry = "src/main.tsx", index_html = "index.html", npm_imports = ["react", "react/jsx-runtime", "react-dom/client"], npm_deps = ["//:node_modules/react", "//:node_modules/react-dom"])`.

- [ ] **Step 1: Write `npm.bzl`**

Generate the esbuild config with `write_file` from a template that sets `entryPoints: [{ out: "react", in: "react" }, ...]`. The rules_esbuild `esbuild` rule takes `config = ":<name>.config.mjs"`, `deps = npm_deps`, `output_dir = True`, `splitting = True`, `format = "esm"`. `react_app` declares two prebundle targets, `<name>.npm` (production define) and `<name>.npm.dev` (development define). Add `config_setting(name = "is_dev", flag_values = {":dev": "True"})` to `bazel/js/BUILD.bazel`; the macro passes `npm_dir = select({"//bazel/js:is_dev": ":<name>.npm.dev", "//conditions:default": ":<name>.npm"})` to `app_manifest`, so the dev transition picks the development bundles without any flag on the command line.

- [ ] **Step 2: Write `react_app.bzl` and switch the example to it**

- [ ] **Step 3: Verify the production bundle works in a browser**

Run: `bazel build //examples/hello:hello.bundle && ls $(bazel cquery --output=files //examples/hello:hello.bundle 2>/dev/null | head -1 | xargs dirname)`
Expected: `index.html` and `main.js` listed. Then `python3 -m http.server --directory <that dir> 8000` and open `http://localhost:8000`: the page shows "Hello from Bazel" and the counter increments.

- [ ] **Step 4: Verify the dev prebundle has one React**

Run: `bazel build //examples/hello:hello.manifest.dev && ls $(python3 -I -c "import json,sys;print(json.load(open(sys.argv[1]))['npm']['dir'])" $(bazel cquery --output=files //examples/hello:hello.manifest.dev 2>/dev/null))`
Expected: `react.js`, `react__jsx-runtime.js`, `react-dom__client.js` and at least one `chunk-*.js`; `grep -c 'createElement' react-dom__client.js` is 0 or small, meaning React itself lives in the shared chunk.

- [ ] **Step 5: Commit**

```bash
git add bazel examples MODULE.bazel
git commit -m "feat: npm prebundle, production bundle and react_app macro"
```

---

### Task 6: Driver: watcher, builder, manifest diff

**Files:**
- Create: `tools/dev/driver/watcher.js`, `builder.js`, `manifest.js`, `driver.js`, `tools/dev/driver/BUILD.bazel`
- Test: `tools/dev/driver/watcher.test.js`, `builder.test.js`, `manifest.test.js`

**Interfaces:**
- Consumes: manifest JSON schema from Task 4.
- Produces:
  - `createWatcher({ root: string, debounceMs = 20, ignored = ["**/bazel-*/**", "**/node_modules/**", "**/.git/**"], watch = chokidar.watch }): { on(event: "change", cb: (paths: string[]) => void): void, close(): Promise<void> }`. Every file event within one debounce window is delivered as one `change` call.
  - `createBuilder({ workspaceDir, target, bazel = "bazel", spawn = child_process.spawn, waitingAfterMs = 2000, onWaiting = () => {} }): { request(): Promise<BuildResult> }` where `BuildResult = { ok: true, ms: number } | { ok: false, error: string, ms: number }`. `request()` while idle starts `bazel build <target>` with `cwd: workspaceDir` and an env that drops every variable starting with `JS_BINARY__`, `RUNFILES`, or equal to `BAZEL_BINDIR`. `request()` while a build runs returns a promise for one pending build that starts when the current one ends; further requests during the run share that promise. `error` is the last 60 lines of bazel's stderr. `onWaiting` fires once if the build has produced no stderr line containing `Analyzing` or `Loading` within `waitingAfterMs` and stderr contains `Another command`.
  - `loadManifest(path: string): Promise<Manifest>` and `diffManifests(prev: Manifest | null, next: Manifest): { changed: string[], added: string[], removed: string[] }` in `manifest.js`, comparing `digest` per key; `prev === null` puts every key in `added`.
  - `createDriver({ workspaceDir, target, manifestPath, log }): { manifest: Manifest | null, start(): Promise<Manifest>, stop(): Promise<void>, on(event, cb) }`, an `EventEmitter`; `manifest` is the last successfully loaded manifest and is replaced only on success with events `building`, `waiting`, `built: { manifest, changed, added, removed, timings: { watchToBuild, bazel, manifest } }`, `failed: { error }`. `start()` loads the manifest, starts the watcher over `workspaceDir`, and on each `change` calls `builder.request()` then `loadManifest`, emits accordingly, and logs one line per cycle: `built in <total>ms (bazel <n>ms): <k> modules changed[, <k> added][, <k> removed]` or `build failed in <n>ms`. The manifest in memory is replaced only on success.

- [ ] **Step 1: Write the failing watcher test**

```js
// tools/dev/driver/watcher.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createWatcher } from "./watcher.js";

test("coalesces a burst of events into one change", async () => {
  const fake = new EventEmitter(); fake.close = async () => {};
  const w = createWatcher({ root: "/r", debounceMs: 10, watch: () => fake });
  const calls = [];
  w.on("change", (p) => calls.push(p));
  for (let i = 0; i < 300; i++) fake.emit("all", "change", `/r/f${i}.ts`);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 300);
});
```

- [ ] **Step 2: Run it to see it fail, implement `watcher.js`, run it to see it pass**

Run: `bazel test //tools/dev/driver:watcher_test` with a `js_test` whose `data` includes `watcher.js` and `//:node_modules/chokidar`.
Expected: FAIL then PASS.

- [ ] **Step 3: Write the failing builder tests**

```js
// tools/dev/driver/builder.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createBuilder } from "./builder.js";

function fakeSpawn(script) { // script: (child) => void, drives stderr/exit
  const spawned = [];
  const spawn = (cmd, args, opts) => {
    const child = new EventEmitter(); child.stderr = new EventEmitter(); child.stdout = new EventEmitter();
    child.args = args; child.opts = opts; spawned.push(child); setTimeout(() => script(child), 0); return child;
  };
  return { spawn, spawned };
}

test("coalesces requests during a build into one pending build", async () => {
  const { spawn, spawned } = fakeSpawn((c) => setTimeout(() => c.emit("exit", 0), 20));
  const b = createBuilder({ workspaceDir: "/w", target: "//a:b", spawn });
  const first = b.request();
  const p2 = b.request(); const p3 = b.request();
  assert.equal(p2, p3);
  await first; await p2;
  assert.equal(spawned.length, 2);
});
test("reports the stderr tail on failure", async () => {
  const { spawn } = fakeSpawn((c) => { c.stderr.emit("data", Buffer.from("ERROR: boom\n")); c.emit("exit", 1); });
  const b = createBuilder({ workspaceDir: "/w", target: "//a:b", spawn });
  const r = await b.request();
  assert.equal(r.ok, false); assert.match(r.error, /boom/);
});
test("strips the nested-run environment and runs in the workspace", async () => {
  const { spawn, spawned } = fakeSpawn((c) => c.emit("exit", 0));
  process.env.JS_BINARY__X = "1"; process.env.BAZEL_BINDIR = "x";
  await createBuilder({ workspaceDir: "/w", target: "//a:b", spawn }).request();
  assert.equal(spawned[0].opts.cwd, "/w");
  assert.equal(spawned[0].opts.env.JS_BINARY__X, undefined);
  assert.equal(spawned[0].opts.env.BAZEL_BINDIR, undefined);
});
test("calls onWaiting when another command holds the lock", async () => {
  let waited = false;
  const { spawn } = fakeSpawn((c) => { c.stderr.emit("data", Buffer.from("Another command (pid=1) is running. Waiting...\n")); setTimeout(() => c.emit("exit", 0), 40); });
  await createBuilder({ workspaceDir: "/w", target: "//a:b", spawn, waitingAfterMs: 10, onWaiting: () => { waited = true; } }).request();
  assert.equal(waited, true);
});
```

- [ ] **Step 4: Run to see them fail, implement `builder.js`, run to see them pass**

Run: `bazel test //tools/dev/driver:builder_test`
Expected: PASS, 4 tests.

- [ ] **Step 5: Write the failing manifest tests**

```js
// tools/dev/driver/manifest.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { diffManifests } from "./manifest.js";
const mk = (mods) => ({ version: 1, modules: Object.fromEntries(Object.entries(mods).map(([k, d]) => [k, { digest: d, output: k, refresh: false, imports: [] }])) });

test("changed, added, removed by digest", () => {
  const d = diffManifests(mk({ a: "1", b: "1", c: "1" }), mk({ a: "2", b: "1", d: "1" }));
  assert.deepEqual(d, { changed: ["a"], added: ["d"], removed: ["c"] });
});
test("equal digests change nothing", () => {
  assert.deepEqual(diffManifests(mk({ a: "1" }), mk({ a: "1" })), { changed: [], added: [], removed: [] });
});
test("null previous means everything is added", () => {
  assert.deepEqual(diffManifests(null, mk({ a: "1" })).added, ["a"]);
});
```

- [ ] **Step 6: Run to see them fail, implement `manifest.js`, run to see them pass**

Run: `bazel test //tools/dev/driver:manifest_test`
Expected: PASS, 3 tests.

- [ ] **Step 7: Implement `driver.js` and a `js_library`-style `BUILD` target `//tools/dev/driver` exporting the four files**

Use rules_js `js_library(name = "driver", srcs = glob(["*.js"], exclude = ["*.test.js"]), deps = ["//:node_modules/chokidar"])`. Timings use `performance.now()` at the `change` event, before and after `bazel`, and after `loadManifest`.

- [ ] **Step 8: Commit**

```bash
git add tools/dev/driver
git commit -m "feat: dev driver with watcher, coalescing builder and manifest diff"
```

---

### Task 7: Web server, client and the `.dev` target

**Files:**
- Create: `tools/dev/web/rewrite.js`, `html.js`, `server.js`, `main.js`, `client.js`, `tools/dev/web/BUILD.bazel`
- Test: `tools/dev/web/rewrite.test.js`, `html.test.js`, `server.test.js`
- Modify: `bazel/js/react_app.bzl`

**Interfaces:**
- Consumes: `createDriver` from Task 6; manifest schema from Task 4.
- Produces:
  - `rewriteImports(code: string, key: string, manifest: Manifest): { code: string, unresolved: string[] }` in `rewrite.js`. Rules, in order: a specifier in `manifest.npm.entries` becomes `/npm/<file>`; a specifier starting with a key of `manifest.packages` becomes the package root plus the rest, then resolved like a relative import; a relative specifier is resolved against `dirname(key)` trying `<p>`, `<p>.ts`, `<p>.tsx`, `<p>/index.ts`, `<p>/index.tsx` as manifest keys and becomes `/<key>`; anything else is left as is and listed in `unresolved`.
  - `renderIndex(html: string, manifest: Manifest): string` in `html.js`: rewrites the entry `<script type="module" src="./src/main.tsx">` to `src="/<manifest.entry>"` and inserts `<script type="module" src="/@dev/client.js"></script>` before `</head>` (or at the top of the document if there is no head).
  - `createServer({ driver, executionRoot, port, log, appLabel }): { listen(): Promise<number>, close(): Promise<void> }` in `server.js`. Routes: `GET /` and `/index.html` serve `renderIndex` of the manifest's `indexHtml` file; `GET /@dev/client.js` serves `client.js`; `GET /npm/<file>` serves `<executionRoot>/<npm.dir>/<file>`; `GET /<key>` for a manifest key serves the rewritten output as `text/javascript` with `ETag` set to the digest and `Cache-Control: no-cache`; anything else is 404. Unresolved specifiers log `cannot resolve "<spec>" from <key>; add it to npm_imports of <appLabel>` once per specifier. A WebSocket at `/@dev/ws` (package `ws`) receives `{"type":"reload"}` on every `built` with non-empty `changed`, `added` or `removed`, and `{"type":"error","message"}` on `failed`; nothing on a cycle with no changes.
  - `client.js`: connects to `ws://<location.host>/@dev/ws`, reloads on `reload`, shows a fixed-position overlay with the message as preformatted text on `error`, removes it on `reload`, and reconnects every second if the socket closes.
  - `main.js`: parses `--manifest <execroot-relative path> --target <label> --app <label> --port <n>`, computes `workspaceDir` from `BUILD_WORKSPACE_DIRECTORY`, obtains `executionRoot` by running `bazel info execution_root` once in `workspaceDir` with the same env cleanup as the builder, creates the driver and server, and prints `dev server at http://localhost:<port>` once listening. Exits non-zero with a message if `BUILD_WORKSPACE_DIRECTORY` is unset (the binary was not started with `bazel run`).
  - `react_app` gains `<name>.dev`: `js_binary(entry_point = "//tools/dev/web:main.js", data = [":<name>.manifest.dev", "//tools/dev/web", "//tools/dev/driver"], args = ["--manifest", "$(execpath :<name>.manifest.dev)", "--target", "//<pkg>:<name>.manifest.dev", "--app", "//<pkg>:<name>", "--port", str(port)])`, with `dev_config`'s `DefaultInfo.files` holding only the manifest so `$(execpath)` is a single file, and the modules and npm outputs carried in its runfiles.

- [ ] **Step 1: Write the failing rewrite and html tests**

```js
// tools/dev/web/rewrite.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { rewriteImports } from "./rewrite.js";
const manifest = {
  version: 1, entry: "app/src/main.tsx", packages: { "@acme/ui": "libs/ui" },
  npm: { dir: "d", entries: { react: "react.js", "react/jsx-runtime": "react__jsx-runtime.js" } },
  modules: { "app/src/main.tsx": {}, "app/src/App.tsx": {}, "app/src/util/index.ts": {}, "libs/ui/button.tsx": {} },
};
test("npm, relative, index and package imports", () => {
  const r = rewriteImports(
    `import React from "react";\nimport { A } from "./App";\nimport u from "./util";\nimport { B } from "@acme/ui/button";\nimport { jsx } from "react/jsx-runtime";`,
    "app/src/main.tsx", manifest);
  assert.match(r.code, /from "\/npm\/react\.js"/);
  assert.match(r.code, /from "\/app\/src\/App\.tsx"/);
  assert.match(r.code, /from "\/app\/src\/util\/index\.ts"/);
  assert.match(r.code, /from "\/libs\/ui\/button\.tsx"/);
  assert.match(r.code, /from "\/npm\/react__jsx-runtime\.js"/);
  assert.deepEqual(r.unresolved, []);
});
test("unknown bare specifier is left alone and reported", () => {
  const r = rewriteImports(`import x from "lodash";`, "app/src/main.tsx", manifest);
  assert.match(r.code, /from "lodash"/);
  assert.deepEqual(r.unresolved, ["lodash"]);
});
```

```js
// tools/dev/web/html.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { renderIndex } from "./html.js";
test("entry script and client injected", () => {
  const out = renderIndex(`<html><head></head><body><div id="root"></div><script type="module" src="./src/main.tsx"></script></body></html>`, { entry: "app/src/main.tsx" });
  assert.match(out, /src="\/app\/src\/main\.tsx"/);
  assert.match(out, /<script type="module" src="\/@dev\/client\.js"><\/script><\/head>/);
});
```

- [ ] **Step 2: Run both to see them fail, implement `rewrite.js` (es-module-lexer, rebuild the string from the end so offsets stay valid) and `html.js`, run both to see them pass**

Run: `bazel test //tools/dev/web:rewrite_test //tools/dev/web:html_test`
Expected: PASS, 3 tests.

- [ ] **Step 3: Write the failing server test**

```js
// tools/dev/web/server.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "./server.js";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "devsrv-"));
  await fs.mkdir(path.join(root, "out"), { recursive: true });
  await fs.writeFile(path.join(root, "out/main.js"), `import "./App";`);
  await fs.writeFile(path.join(root, "out/index.html"), `<html><head></head><body><script type="module" src="./src/main.tsx"></script></body></html>`);
  const manifest = { version: 1, entry: "app/src/main.tsx", indexHtml: "out/index.html", packages: {}, npm: { dir: "out", entries: {} },
    modules: { "app/src/main.tsx": { output: "out/main.js", digest: "d1", refresh: false, imports: ["./App"] } } };
  const driver = new EventEmitter(); driver.manifest = manifest;
  return { root, driver };
}

test("serves index, module and 404", async () => {
  const { root, driver } = await fixture();
  const s = createServer({ driver, executionRoot: root, port: 0, log: () => {}, appLabel: "//app:app" });
  const port = await s.listen();
  const idx = await fetch(`http://localhost:${port}/`); assert.equal(idx.status, 200);
  assert.match(await idx.text(), /\/@dev\/client\.js/);
  const mod = await fetch(`http://localhost:${port}/app/src/main.tsx`);
  assert.equal(mod.headers.get("content-type").split(";")[0], "text/javascript");
  assert.equal(mod.headers.get("etag"), "d1");
  const gone = await fetch(`http://localhost:${port}/app/src/Gone.tsx`); assert.equal(gone.status, 404);
  await s.close();
});
test("reload only when something changed", async () => {
  const { root, driver } = await fixture();
  const s = createServer({ driver, executionRoot: root, port: 0, log: () => {}, appLabel: "//app:app" });
  const port = await s.listen();
  const ws = new (await import("ws")).WebSocket(`ws://localhost:${port}/@dev/ws`);
  const got = []; ws.on("message", (m) => got.push(JSON.parse(m.toString())));
  await new Promise((r) => ws.on("open", r));
  driver.emit("built", { manifest: driver.manifest, changed: [], added: [], removed: [] });
  driver.emit("built", { manifest: driver.manifest, changed: ["app/src/main.tsx"], added: [], removed: [] });
  driver.emit("failed", { error: "boom" });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(got.map((g) => g.type), ["reload", "error"]);
  ws.close(); await s.close();
});
```

The server reads the current manifest from `driver.manifest` (Task 6's interface).

- [ ] **Step 4: Run it to see it fail, implement `server.js`, run it to see it pass**

Run: `bazel test //tools/dev/web:server_test`
Expected: PASS, 2 tests.

- [ ] **Step 5: Write `client.js`, `main.js`, the `BUILD` file, and add `<name>.dev` to `react_app`**

- [ ] **Step 6: Verify end to end**

Run: `bazel run //examples/hello:hello.dev`
Expected: prints `dev server at http://localhost:5173`; the page shows "Hello from Bazel" and the counter works; the browser console shows no errors. Then edit the heading text in `examples/hello/src/App.tsx` and save: the terminal logs `built in <n>ms (bazel <m>ms): 1 modules changed` and the page reloads with the new text. Then introduce a type error such as `const x: number = "s";` and save: the page shows an overlay with the SWC error and the old page stays served; fix it and the overlay goes away. Revert the example afterwards.

- [ ] **Step 7: Commit**

```bash
git add tools/dev/web bazel/js/react_app.bzl examples
git commit -m "feat: dev server with full reload and error overlay"
```

---

### Task 8: Latency acceptance and user guide

**Files:**
- Create: `docs/using-the-dev-server.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: the running system from Task 7.

- [ ] **Step 1: Measure warm save-to-reload ten times**

With `bazel run //examples/hello:hello.dev` running and the page open, alternate the heading text between two values ten times, waiting for each reload. Collect the ten `built in <n>ms` lines.

Expected: median under 600 ms. If it is not, the first suspects are `bazel` client startup (check `bazel info` latency alone), the worker not being reused (run with `--worker_verbose` and confirm one `JsTransform` worker stays alive), and runfiles tree rebuilding for `.dev` (confirm the nested build targets `<name>.manifest.dev`, not `<name>.dev`).

- [ ] **Step 2: Write `docs/using-the-dev-server.md`**

Sections: declaring an app with `react_app` (every attribute, one line each), running it, what the terminal lines mean, the one documented dev-versus-prod difference (React development build), and the current limits (no CSS, no Fast Refresh yet, no typecheck target yet; those are the next plan).

- [ ] **Step 3: Write `README.md`**

Three paragraphs: what this is, the one command to try it, and a link to the spec and the guide.

- [ ] **Step 4: Commit**

```bash
git add docs README.md
git commit -m "docs: dev server guide and latency results"
```
