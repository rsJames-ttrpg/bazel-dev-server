# Fast Refresh, CSS and Typecheck Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Editing a React component in `examples/hello` updates the page without losing state, CSS edits swap styles in place, `package_name` imports resolve identically in dev, prod and tsc, and `bazel test //examples/hello:hello.typecheck` type-checks the app.

**Architecture:** The transform worker gains a dev-only Fast Refresh wrapper around SWC's output and a CSS handler (Lightning CSS) that emits a processed `.css` plus a `.css.js` module, so every byte the browser loads is still a Bazel output. The manifest grows a `kind` per module. The web server replaces "always reload" with a decision: `update` for refresh-capable and CSS modules, `reload` otherwise, `ok` after a fixed failure; the client runs the `react-refresh` runtime (prebundled by Bazel) and re-imports changed modules with a digest query. The production bundle reads a generated esbuild config whose plugin resolves `package_name` imports and `.css` imports from the one `packages` map, and a `bundle_dir` rule replaces the genrule so `main.css` ships. A `<name>.typecheck` test runs tsc over a generated tsconfig with `paths` from the same map. This covers spec milestones 3 and 4 plus the typecheck target and the aliases deferred from the foundation plan; milestone 5 (hardening) is a third plan.

**Tech Stack:** Everything from the foundation plan, plus `react-refresh` (runtime only, dev) and `lightningcss` (native binary, like SWC). Tooling stays JavaScript ESM with `// @ts-check` and `node:test` through `js_test`.

**Spec:** `docs/superpowers/specs/2026-11-15-hermetic-dev-server-design.md`

**Foundation ledger (deferred minors this plan absorbs):** `docs/superpowers/plans/2026-11-15-foundation-ledger.md`

## Global Constraints

- Every file the browser loads is a Bazel output. The dev server reads files only from Bazel's execution root and never transforms source itself; its only string-level edit is rewriting import specifiers to URLs.
- The dev configuration is reached only through the `//bazel/js:dev` `bool_flag` set by a rule transition in `dev_config`, never through a command-line flag.
- One `bazel build` per change; the builder never runs two builds at once.
- One root `tsconfig.json` is the source of truth for `jsx`, `target`, `useDefineForClassFields` and `verbatimModuleSyntax`.
- Module URLs and manifest keys are the file's workspace-relative source path, for CSS too: `/examples/hello/src/App.module.css` serves the `.css.js` module built from that file.
- The `packages` map (`package_name` to workspace-relative root) from `JsSourceInfo` is the single input to all three resolvers: the dev rewrite, the esbuild bundle plugin and the typecheck `paths`.
- `*.module.css` class names are produced by Lightning CSS in the transform action, in both configurations; esbuild never hashes class names.
- The production bundle contains no refresh wrapper, no style injection and no `react-refresh` code.
- Warm save-to-update on `examples/hello` must still log under 600 ms; the server logs every cycle and every HMR decision.
- A failed build keeps the last good outputs served; the server process never exits on a build failure.
- Linux and macOS only.
- Commits are small and frequent; every task ends with a commit on branch `followups`.

## Deferred by this plan (recorded so the executor does not re-decide them)

- The spec's transform *toolchain* (`//bazel/js:transform_toolchain`) and the CSS preprocessor hook wait for the Svelte plan, when a second handler exists to justify the API. This plan dispatches handlers by extension inside the worker (`tools/transform/handlers.js`). Lightning CSS already provides post-processing (nesting, prefixes).
- Copying non-CSS assets (images, fonts) through the module tree is not in this plan.
- Hardening items (BUILD-file changes, watcher overflow, flag forwarding) are plan 3.

## Review Focus

- A component file that also exports a non-component value (a constant, a hook): the client must detect the export is not a refresh boundary and fall back to a full reload, never leave the page running stale code. Test in Task 4 (`validateRefreshBoundary` returns a reason for a changed non-component export).
- A build failure followed by a fix that restores the previous output: the overlay must disappear even though no module changed, without a full reload. Test in Task 4 (server emits `ok` after `failed` then an unchanged `built`).
- An edit to the entry module or to a plain `.ts` utility: full reload, because nothing can re-import them safely. Test in Task 4 (decision test: `changed` containing a `refresh: false` module yields `reload`).
- A CSS edit: the `<style>` element is replaced in place and React state survives. Test in Task 4 (update message carries `kind: "css"`) and Task 6 (browser check).
- A type error in a component: the dev server keeps serving, and `bazel test :hello.typecheck` fails naming the file and line. Test in Task 5.

---

## Interfaces this plan adds (summary)

- Manifest version 2: each `modules[key]` is `{ output, digest, refresh, imports, kind }`, `kind` is `"js"` or `"css"`.
- Transform worker flags: `--key <short_path>` (always), `--css-out <path>` (for `.css` sources).
- `transformSource` returns `{ code, meta }` as before; `meta.kind` added; a new `transformCss` returns `{ css, code, meta }`.
- WebSocket messages, server to client: `{type:"reload"}`, `{type:"error", message}`, `{type:"update", modules:[{key, digest, kind}]}`, `{type:"ok"}`.
- Client globals: `window.__devRefresh` with `register(type, id)`, `createSignatureFunctionForTransform()`, `registerModule(key, url)`.
- `react_app` gains `typecheck_deps` (list of `@types` and other npm targets tsc needs, default `[]`), and `srcs` may include `.css` files.
- New rules: `bundle_config`, `bundle_dir` (`bazel/js/bundle.bzl`), `typecheck_tsconfig` (`bazel/js/typecheck.bzl`).

---

### Task 1: Production bundle from a generated esbuild config; `package_name` aliases; `bundle_dir`

**Files:**
- Create: `bazel/js/esbuild_bundle.config.mjs.tpl`
- Create: `bazel/js/bundle.bzl` (`bundle_config`, `bundle_dir` rules)
- Create: `tools/bundle/write_bundle.js`, `tools/bundle/write_bundle.test.js`, `tools/bundle/BUILD.bazel`
- Modify: `bazel/js/react_app.bzl` (replace `output_files` + genrule section)
- Modify: `bazel/js/BUILD.bazel` (`exports_files` the new template)
- Create: `examples/shared/ui/BUILD.bazel`, `examples/shared/ui/index.ts`, `examples/shared/ui/Button.tsx`
- Modify: `examples/hello/BUILD.bazel`, `examples/hello/src/App.tsx`

**Interfaces:**
- Consumes: `ModulesInfo(modules=[struct(src, out, meta)], packages)` from `bazel/js/providers.bzl`; `JsSourceInfo.packages` keyed by `package_name` with workspace-relative root.
- Produces: `bundle_config(name, modules, entry, out)` writes an esbuild config whose plugin sets the entry point and resolves `package_name` imports. `bundle_dir(name, esbuild, index_html, entry)` produces a tree artifact `<name>/` with `index.html`, `main.js`, `main.js.map` and `main.css` when esbuild emitted one. Task 3 extends the template's plugin with `.css` resolution; keep the plugin's `onResolve` in one place.

- [ ] **Step 1: Write the failing test for the index writer**

`tools/bundle/write_bundle.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { renderBundleIndex } from "./write_bundle.js";
const html = `<html><head></head><body><script type="module" src="./src/main.tsx"></script></body></html>`;

test("points the entry script at main.js", () => {
  const out = renderBundleIndex(html, "src/main.tsx", false);
  assert.match(out, /src="\.\/main\.js"/);
  assert.doesNotMatch(out, /main\.css/);
});
test("links main.css when the bundle has one", () => {
  const out = renderBundleIndex(html, "src/main.tsx", true);
  assert.match(out, /<link rel="stylesheet" href="\.\/main\.css">\s*<\/head>/);
});
test("throws when the entry script is missing", () => {
  assert.throws(() => renderBundleIndex("<html></html>", "src/main.tsx", false), /entry script/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bazel test //tools/bundle:write_bundle_test --test_output=errors`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `tools/bundle/write_bundle.js`**

Exports `renderBundleIndex(html: string, entry: string, hasCss: boolean): string`: replaces the `<script type="module" src="./<entry>">` source with `./main.js` (throw `entry script ./<entry> not found in index.html` if absent) and, when `hasCss`, inserts `<link rel="stylesheet" href="./main.css">` before `</head>`.

CLI (`process.argv[1] === fileURLToPath(import.meta.url)` guard, `@argsfile` expansion like `write_manifest.js`): `--esbuild-dir <dir> --index <file> --entry <pkg-relative entry> --out <dir>`. Copies every file in `esbuild-dir` (recursively) into `out`, then writes `out/index.html` from `renderBundleIndex` with `hasCss = existsSync(join(esbuildDir, "main.css"))`.

`tools/bundle/BUILD.bazel`: `js_test` `write_bundle_test` and public `js_binary` `write_bundle`, mirroring `tools/manifest/BUILD.bazel`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bazel test //tools/bundle:write_bundle_test`
Expected: PASS.

- [ ] **Step 5: Write the esbuild bundle config template**

`bazel/js/esbuild_bundle.config.mjs.tpl`, substitutions `%ENTRY%` (bin-relative path of the entry's transformed `.js`) and `%PACKAGES%` (JSON object: `package_name` to bin-relative directory of that package's transformed outputs, e.g. `"@example/ui": "examples/hello/hello.modules/examples/shared/ui"`). The plugin, in `setup(build)`:
- `build.initialOptions.entryPoints = [{ in: path.resolve(process.cwd(), ENTRY), out: "main" }]` (same trick as the npm prebundle template; requires `output_dir = True`).
- `build.onResolve({ filter: /^[^./]/ }, ...)`: for a specifier equal to a package name or starting with `name + "/"`, return `build.resolve(path.resolve(process.cwd(), dir + spec.slice(name.length)), { kind: args.kind, resolveDir: process.cwd() })`. Any other bare specifier returns `undefined` so esbuild resolves npm normally.

Add a comment at the top explaining that `process.cwd()` is Bazel's bin directory because the rules_esbuild launcher changes into it. Verify this in Step 7 before relying on it; if it is not, resolve against `process.env.BAZEL_BINDIR` instead and say so in the comment.

- [ ] **Step 6: Implement `bazel/js/bundle.bzl`**

`bundle_config` rule, attrs `modules` (label, providers `[ModulesInfo]`), `entry` (string, package-relative source path), `out` (output): finds the module whose `src.short_path == ctx.label.package + "/" + entry` (fail with a clear message if none) and uses `m.out.short_path` as `%ENTRY%`; `%PACKAGES%` maps each `info.packages[name]` root to `modules.label.package + "/" + modules.label.name + "/" + root`. Uses `ctx.actions.expand_template`.

`bundle_dir` rule, attrs `esbuild` (label, the esbuild output directory), `index_html` (single file), `entry` (string), `_writer` (`//tools/bundle:write_bundle`, exec cfg): declares `ctx.actions.declare_directory(ctx.label.name)` and runs the writer with the same param-file and env (`BAZEL_BINDIR`, `JS_BINARY__NO_CD_BINDIR`) conventions as `manifest.bzl`.

- [ ] **Step 7: Rewire `react_app.bzl`**

Replace the `output_files`, `esbuild` and `genrule` block with:

```python
bundle_config(name = name + ".bundle.config", modules = ":" + name + ".modules", entry = entry, out = name + ".bundle.config.mjs")
esbuild(
    name = name + ".bundle.esbuild",
    entry_points = [":" + name + ".bundle.config"],
    config = ":" + name + ".bundle.config",
    srcs = [":" + name + ".modules"],
    deps = npm_deps,
    output_dir = True,
    splitting = False,
    format = "esm",
    define = {"process.env.NODE_ENV": '"production"'},
)
bundle_dir(name = name + ".bundle", esbuild = ":" + name + ".bundle.esbuild", index_html = index_html, entry = entry)
```

Remove the `output_files` load and the `entry_stem` computation. Run `bazel build //examples/hello:hello.bundle` and check `bazel-bin/examples/hello/hello.bundle/` holds `index.html`, `main.js`, `main.js.map`. If the build cannot find the entry, print `process.cwd()` from the config once to settle the Step 5 question, then remove the print.

- [ ] **Step 8: Add the shared example library and use it**

`examples/shared/ui/BUILD.bazel`:

```python
load("//bazel/js:js_library.bzl", "js_library")

js_library(
    name = "ui",
    srcs = ["index.ts", "Button.tsx"],
    package_name = "@example/ui",
    visibility = ["//examples:__subpackages__"],
)
```

`Button.tsx` exports `Button({ onClick, children }: { onClick: () => void; children: React.ReactNode })` rendering a `<button>`; `index.ts` is `export { Button } from "./Button";`. (`import type { ReactNode } from "react"` because of `verbatimModuleSyntax`.)

`examples/hello/BUILD.bazel`: add `deps = ["//examples/shared/ui"]`. `App.tsx`: `import { Button } from "@example/ui";` and render the counter with it.

- [ ] **Step 9: Verify dev and prod agree**

Run: `bazel build //examples/hello:hello.bundle && grep -c "Hello from Bazel" bazel-bin/examples/hello/hello.bundle/main.js`
Expected: `1`, and `main.js` contains the Button's `<button` markup (grep `createElement\|jsx` is not reliable; grep for the button's class or text).

Run: `bazel run //examples/hello:hello.dev` in the background, then `curl -s localhost:5173/examples/hello/src/App.tsx | grep '@example'`
Expected: the import is rewritten to `/examples/shared/ui/index.ts`. Stop the server.

- [ ] **Step 10: Commit**

```bash
git add bazel/js tools/bundle examples
git commit -m "feat: generated esbuild bundle config with package_name aliases; bundle_dir replaces genrule"
```

---

### Task 2: Fast Refresh wrapper in the dev transform; manifest `kind`

**Files:**
- Modify: `tools/transform/transform.js`, `tools/transform/transform.test.js`
- Modify: `tools/transform/worker.js`, `tools/transform/worker.test.js`
- Modify: `bazel/js/transform.bzl` (pass `--key`)
- Modify: `tools/manifest/write_manifest.js`, `tools/manifest/write_manifest.test.js` (version 2, `kind`)

**Interfaces:**
- Consumes: `transformSource({ code, filename, dev, compilerOptions })` from the foundation.
- Produces: `transformSource({ code, filename, key, dev, compilerOptions })` where `key` is the workspace-relative source path; `meta` gains `kind: "js"`. In dev, when SWC emitted refresh registrations, the output is wrapped as specified in Step 3. The wrapper relies on `window.__devRefresh` (Task 4) and falls back to no-ops without it. Manifest `version` becomes `2` and each module carries `kind`.

- [ ] **Step 1: Write the failing tests**

Append to `tools/transform/transform.test.js`:

```js
test("dev component module is wrapped for refresh with its key", () => {
  const r = transformSource({ code: "export const A = () => <div/>;", filename: "A.tsx", key: "app/src/A.tsx", dev: true, compilerOptions: opts });
  assert.equal(r.meta.kind, "js");
  assert.equal(r.meta.refresh, true);
  assert.match(r.code, /window\.__devRefresh\.register\(type, "app\/src\/A\.tsx " \+ id\)/);
  assert.match(r.code, /registerModule\("app\/src\/A\.tsx", import\.meta\.url\)/);
  assert.ok(r.code.indexOf("__prevRefreshReg") < r.code.indexOf("$RefreshReg$(_c"), "wrapper head precedes SWC body");
  assert.ok(r.code.lastIndexOf("window.$RefreshReg$ = __prevRefreshReg") > r.code.indexOf("$RefreshReg$(_c"), "wrapper tail follows SWC body");
});
test("dev module without components is not wrapped", () => {
  const r = transformSource({ code: "export const n = 1;", filename: "n.ts", key: "app/n.ts", dev: true, compilerOptions: opts });
  assert.equal(r.meta.refresh, false);
  assert.doesNotMatch(r.code, /__devRefresh/);
});
test("prod component module is never wrapped", () => {
  const r = transformSource({ code: "export const A = () => <div/>;", filename: "A.tsx", key: "app/src/A.tsx", dev: false, compilerOptions: opts });
  assert.doesNotMatch(r.code, /RefreshReg/);
});
```

In `worker.test.js`, add `--key` to the existing invocations and assert the meta file has `kind: "js"`. In `write_manifest.test.js`, assert `version === 2` and that a module's `kind` is copied from its meta.

- [ ] **Step 2: Run them to verify they fail**

Run: `bazel test //tools/transform/... //tools/manifest/... --test_output=errors`
Expected: the new tests FAIL (no `kind`, no wrapper).

- [ ] **Step 3: Implement the wrapper in `transform.js`**

`key` defaults to `filename` when omitted (keeps older tests valid). When `dev && refresh`, `code` becomes:

```js
const __refresh = window.__devRefresh;
const __prevRefreshReg = window.$RefreshReg$, __prevRefreshSig = window.$RefreshSig$;
window.$RefreshReg$ = (type, id) => window.__devRefresh.register(type, "<KEY> " + id);
window.$RefreshSig$ = __refresh ? __refresh.createSignatureFunctionForTransform : () => (type) => type;
<SWC output>
window.$RefreshReg$ = __prevRefreshReg; window.$RefreshSig$ = __prevRefreshSig;
if (__refresh) __refresh.registerModule("<KEY>", import.meta.url);
```

with `<KEY>` JSON-escaped. When `__devRefresh` is absent, `$RefreshReg$` must still be a function: write the line as `window.$RefreshReg$ = __refresh ? (type, id) => window.__devRefresh.register(type, "<KEY> " + id) : () => {};`. The digest hashes the wrapped code. `meta.kind = "js"`. The `imports` list is parsed from the wrapped code (unchanged: the wrapper adds no imports).

- [ ] **Step 4: Thread `--key` through the worker and the rule**

`worker.js`: `--key` becomes required alongside `--src`, `--out`, `--meta`, `--dev`, `--tsconfig`. `transform.bzl`: `args.add("--key", src.short_path)`. `write_manifest.js`: `buildManifest` copies `meta.kind` (default `"js"` when absent) and sets `version: 2`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bazel test //tools/transform/... //tools/manifest/... //examples/...`
Expected: PASS; `bazel build //examples/hello:hello.manifest.dev` succeeds and the manifest JSON shows `"version": 2` and `"kind": "js"` on `examples/hello/src/App.tsx`.

- [ ] **Step 6: Commit**

```bash
git add tools/transform tools/manifest bazel/js/transform.bzl
git commit -m "feat: dev refresh wrapper around SWC output; manifest v2 with module kind"
```

---

### Task 3: CSS through the transform: Lightning CSS, `.css.js` modules, prod resolution

**Files:**
- Modify: `package.json`, `pnpm-lock.yaml` (add `lightningcss`; run `bazel run -- @pnpm//:pnpm install --lockfile-only` as the foundation did)
- Create: `tools/transform/css.js`, `tools/transform/css.test.js`
- Create: `tools/transform/handlers.js` (extension to handler map used by `worker.js`)
- Modify: `tools/transform/worker.js`, `tools/transform/worker.test.js`, `tools/transform/BUILD.bazel`
- Modify: `bazel/js/transform.bzl`, `bazel/js/providers.bzl`, `bazel/js/manifest.bzl`
- Modify: `bazel/js/esbuild_bundle.config.mjs.tpl` (resolve `.css` imports to `.css.js`)
- Modify: `tools/dev/web/rewrite.js` only if `findKey` needs it (it should not: the key `x.css` is tried first)

**Interfaces:**
- Consumes: `ModulesInfo.modules` struct from Task 2's `transform.bzl`.
- Produces: `transformCss({ code, filename, key, dev }) → { css: string, code: string, meta: { digest, refresh: true, imports, kind: "css", exports: Record<string,string> } }`. For a `.css` source the rule declares three outputs: `<stem>.css` (processed), `<stem>.css.js` (the module, `out`), `<stem>.css.js.meta.json`. `ModulesInfo.modules` structs gain `extra: list[File]` (the processed css) which `app_manifest` adds to its inputs. Worker flag `--css-out`.

- [ ] **Step 1: Write the failing tests**

`tools/transform/css.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { transformCss } from "./css.js";

test("plain css: dev module injects a style element and exports an empty map", () => {
  const r = transformCss({ code: ".a { color: red }", filename: "a.css", key: "app/a.css", dev: true });
  assert.match(r.css, /\.a\s*{\s*color:\s*red/);
  assert.match(r.code, /data-dev-css="app\/a\.css"/);
  assert.match(r.code, /export default {}/);
  assert.equal(r.meta.kind, "css");
  assert.equal(r.meta.refresh, true);
  assert.deepEqual(r.meta.imports, []);
});
test("plain css: prod module imports the css file and exports the map", () => {
  const r = transformCss({ code: ".a { color: red }", filename: "a.css", key: "app/a.css", dev: false });
  assert.match(r.code, /^import "\.\/a\.css";/);
  assert.doesNotMatch(r.code, /document/);
  assert.deepEqual(r.meta.imports, ["./a.css"]);
});
test("module css: class names are hashed identically in dev and prod", () => {
  const dev = transformCss({ code: ".button { color: red }", filename: "x.module.css", key: "app/x.module.css", dev: true });
  const prod = transformCss({ code: ".button { color: red }", filename: "x.module.css", key: "app/x.module.css", dev: false });
  assert.match(dev.meta.exports.button, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(dev.meta.exports.button, "button");
  assert.equal(dev.meta.exports.button, prod.meta.exports.button);
  assert.ok(dev.css.includes(dev.meta.exports.button));
  assert.match(dev.code, new RegExp(`export default {"button":"${dev.meta.exports.button}"}`));
});
test("a css syntax error throws with file and line", () => {
  assert.throws(() => transformCss({ code: ".a { color: ", filename: "a.css", key: "app/a.css", dev: true }), /a\.css:1/);
});
```

`worker.test.js`: a case running the worker one-shot on a `.css` file with `--css-out`, asserting the three outputs exist and the meta has `kind: "css"`.

- [ ] **Step 2: Run them to verify they fail**

Run: `bazel test //tools/transform:css_test //tools/transform:worker_test --test_output=errors`
Expected: FAIL (no `css.js`).

- [ ] **Step 3: Implement `tools/transform/css.js`**

Use `lightningcss`'s `transform({ filename, code: Buffer.from(code), minify: false, cssModules: filename.endsWith(".module.css") })`. Map `result.exports` to `{ [name]: exports[name].name }` (ignore `composes`). Wrap Lightning's error so the message is `<filename>:<line>:<column>: <message>`. Dev module text:

```js
const css = <JSON of processed css>;
const id = <JSON key>;
let el = document.head.querySelector(`style[data-dev-css="${id}"]`);
if (!el) { el = document.createElement("style"); el.setAttribute("data-dev-css", id); document.head.appendChild(el); }
el.textContent = css;
export default <JSON of map>;
```

Prod module text: `import "./<basename of filename>";\nexport default <JSON of map>;`. `meta.imports` comes from `es-module-lexer` over `code` (so `[]` in dev, `["./a.css"]` in prod); `meta.digest` hashes `code`; `meta.refresh` is `true`.

- [ ] **Step 4: Dispatch by extension in the worker**

`handlers.js` exports `handlerFor(filename)` returning `{ kind: "js" }` for `.ts/.tsx/.js/.jsx` and `{ kind: "css" }` for `.css`, else throws `no transform handler for <filename>`. `worker.js` calls `transformCss` for css (requires `--css-out`; writes `css`, `code`, `meta`) and `transformSource` otherwise. Add `//:node_modules/lightningcss` to the worker and tests' data in `tools/transform/BUILD.bazel`.

- [ ] **Step 5: Declare CSS outputs in `transform.bzl`**

For `src.extension == "css"`: `out = <name>/<short_path>.js`, `meta = <name>/<short_path>.js.meta.json`, `css = <name>/<short_path>`; add `--css-out css` to args and `css` to outputs; `modules.append(struct(src, out, meta, extra = [css]))`. For ts/tsx keep `extra = []`. Skip `.d.ts` sources entirely (they are typecheck inputs only). Update the `ModulesInfo` doc string in `providers.bzl`. `manifest.bzl`: `inputs.extend(m.extra)`.

- [ ] **Step 6: Resolve `.css` imports to `.css.js` in the prod bundle**

In `esbuild_bundle.config.mjs.tpl` add `build.onResolve({ filter: /\.css$/ }, ...)`: if `args.importer.endsWith(".css.js")` return `undefined` (that is the `.css.js` module importing its own stylesheet; esbuild bundles it into `main.css`). Otherwise resolve the specifier relative to `args.resolveDir` (or through the package map for a `package_name` specifier; share the package-prefix lookup from Task 1) and return `{ path: resolved + ".js" }`.

- [ ] **Step 7: Run the tests and a build**

Run: `bazel test //tools/transform/... //tools/manifest/...` → PASS.
Run: write a temporary `examples/hello/src/tmp.css` with `h1 { color: rebeccapurple }`, add `"src/**/*.css"` to the example's glob, `import "./tmp.css";` in `App.tsx`, then `bazel build //examples/hello:hello.bundle` and check `bazel-bin/examples/hello/hello.bundle/main.css` contains `rebeccapurple` and `index.html` links it. Then `bazel build //examples/hello:hello.manifest.dev` and confirm the manifest has key `examples/hello/src/tmp.css` with `kind: "css"`. Revert the temporary file and import (Task 6 adds the real CSS); keep the glob change.

- [ ] **Step 8: Commit**

```bash
git add package.json pnpm-lock.yaml tools/transform bazel/js examples/hello/BUILD.bazel
git commit -m "feat: CSS through Lightning CSS: processed .css plus .css.js module; prod resolves css imports to the module"
```

---

### Task 4: HMR: server decision, update protocol, refresh client

**Files:**
- Modify: `tools/dev/web/server.js`, `tools/dev/web/server.test.js`
- Create: `tools/dev/web/hmr.js` (pure decision), `tools/dev/web/hmr.test.js`
- Create: `tools/dev/web/refresh.js` (pure boundary helpers), `tools/dev/web/refresh.test.js`
- Modify: `tools/dev/web/client.js`, `tools/dev/web/BUILD.bazel`
- Modify: `bazel/js/react_app.bzl` (dev prebundle gets `react-refresh/runtime`), `bazel/js/npm.bzl` doc only if needed
- Modify: `package.json`, `pnpm-lock.yaml` (add `react-refresh`)

**Interfaces:**
- Consumes: driver `built` events `{ manifest, changed, added, removed, other, timings }`; manifest v2 `kind`; Task 2's wrapper calling `window.__devRefresh.register/createSignatureFunctionForTransform/registerModule`.
- Produces: `decide(e: BuiltEvent, failed?: boolean) → { type: "reload", reason: string } | { type: "update", modules: [{key, digest, kind}] } | { type: "ok" } | null` in `hmr.js`. `refresh.js` exports `registerExportsForReactRefresh(runtime, key, exports)` and `validateRefreshBoundary(runtime, prevExports, nextExports) → string | null` (null means the update is safe). Server routes ignore the query string and serve `/@dev/client.js` and `/@dev/refresh.js`. The client imports the runtime from `/npm/react-refresh__runtime.js` (the `npm_entry_name` of `react-refresh/runtime`).

- [ ] **Step 1: Write the failing decision tests**

`tools/dev/web/hmr.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { decide } from "./hmr.js";
const m = (mods) => ({ modules: mods });
const ev = (manifest, o) => ({ manifest, changed: [], added: [], removed: [], other: [], ...o });
const A = { "a.tsx": { digest: "2", refresh: true, kind: "js" }, "s.css": { digest: "2", refresh: true, kind: "css" }, "u.ts": { digest: "2", refresh: false, kind: "js" } };

test("nothing changed and not failed: null", () => assert.equal(decide(ev(m(A))), null));
test("nothing changed after a failure: ok", () => assert.deepEqual(decide(ev(m(A)), true), { type: "ok" }));
test("refresh-capable and css changes: update with digests and kinds", () => {
  assert.deepEqual(decide(ev(m(A), { changed: ["a.tsx", "s.css"] })), { type: "update", modules: [
    { key: "a.tsx", digest: "2", kind: "js" }, { key: "s.css", digest: "2", kind: "css" }] });
});
test("a non-refresh module changed: reload naming it", () => {
  assert.deepEqual(decide(ev(m(A), { changed: ["a.tsx", "u.ts"] })), { type: "reload", reason: "u.ts cannot hot-update" });
});
test("removed modules or npm/index changes: reload", () => {
  assert.equal(decide(ev(m(A), { removed: ["x.ts"] })).type, "reload");
  assert.equal(decide(ev(m(A), { other: ["npm"] })).type, "reload");
});
test("only added modules: null (importers that changed carry them)", () => assert.equal(decide(ev(m(A), { added: ["n.tsx"] })), null));
```

`tools/dev/web/refresh.test.js` with a fake runtime `{ register: (t, id) => calls.push(id), isLikelyComponentType: (v) => typeof v === "function" && /^[A-Z]/.test(v.name) }`:

```js
test("registers component exports under key and export name", ...)  // ids: ["app/A.tsx export A"]
test("all exports components: boundary valid (null)", ...)
test("a changed non-component export invalidates", ...)   // prev { A, n: 1 }, next { A, n: 2 } → /n/ reason
test("an unchanged non-component export is fine", ...)   // same n object → null
test("added or removed export invalidates", ...)
test("no exports at all invalidates", ...)
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bazel test //tools/dev/web:hmr_test //tools/dev/web:refresh_test --test_output=errors`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement `hmr.js` and `refresh.js`**

`decide(e, failed = false)`: `reload` if `removed.length || other.length` (reason `"<n> removed"` / `"<what> changed"`) or any changed key whose `manifest.modules[key].refresh` is false (reason `"<key> cannot hot-update"`, first such key); else `update` listing changed keys in `changed` order with `digest` and `kind`; else `ok` when `failed`; else `null`.

`refresh.js`: `registerExportsForReactRefresh(runtime, key, exports)` registers each export that `runtime.isLikelyComponentType` accepts as `key + " export " + name`. `validateRefreshBoundary(runtime, prev, next)`: every key of `prev` must be in `next` (`"export <k> removed"`), every key of `next` in `prev` (`"export <k> added"`), every `next` export must be a component or `prev[k] === next[k]` (`"export <k> is not a component and changed"`), and there must be at least one export (`"no exports"`). Returns the first reason or `null`. Adapted from Vite's `@vitejs/plugin-react` refresh utils (MIT); say so in a comment.

- [ ] **Step 4: Write the failing server tests**

Extend the `server.test.js` fixture: give every module `kind`, set `app/src/main.tsx` to `refresh: false`, and add `app/src/App.tsx` (`output: "out/App.js"`, `digest: "d2"`, `refresh: true`, `kind: "js"`) and `app/src/s.css` (`kind: "css"`, `refresh: true`) with matching files under `out/`. Add:

```js
test("update for refresh modules, reload otherwise, ok after failure", async (t) => {
  // connect ws as in the existing tests
  driver.emit("failed", { error: "boom" });
  driver.emit("built", { manifest: driver.manifest, changed: [], added: [], removed: [], other: [] });
  driver.emit("built", { manifest: driver.manifest, changed: ["app/src/App.tsx"], added: [], removed: [], other: [] });
  driver.emit("built", { manifest: driver.manifest, changed: ["app/src/main.tsx"], added: [], removed: [], other: [] });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(got.map((g) => g.type), ["error", "ok", "update", "reload"]);
  assert.deepEqual(got[2].modules, [{ key: "app/src/App.tsx", digest: "d2", kind: "js" }]);
});
test("module routes ignore the query string and serve refresh.js", async () => {
  const mod = await fetch(`http://localhost:${port}/app/src/main.tsx?v=abc`); assert.equal(mod.status, 200);
  const r = await fetch(`http://localhost:${port}/@dev/refresh.js`); assert.equal(r.status, 200);
  const no = await fetch(`http://localhost:${port}/@dev/server.js`); assert.equal(no.status, 404);
});
```

Keep the existing "reload only when something changed" test valid: its `App.tsx`-free fixture has `refresh: false` on `main.tsx`, so a change there is still `reload`.

- [ ] **Step 5: Implement the server changes**

`server.js`: route `/@dev/<file>` for `file` in `{client.js, refresh.js}` only. `route()` already receives `pathname` without the query; confirm and add the test. Replace the `built` handler with `decide(e, failed)`: `null` → nothing; otherwise `events.then(holdOutputs).then(() => broadcast(msg))`, log `update: <k> modules` or `reload: <reason>`, set `failed = false`. Log the time from `built` arrival to broadcast as `pushed in <n>ms` only when it exceeds 10 ms (the spec's budget), so the hot path stays quiet.

- [ ] **Step 6: Implement the client**

`client.js` (served as `/@dev/client.js`, so its imports are URLs):

```js
import * as RefreshRuntime from "/npm/react-refresh__runtime.js";
import { registerExportsForReactRefresh, validateRefreshBoundary } from "./refresh.js";
```

- `RefreshRuntime.injectIntoGlobalHook(window)`; `window.$RefreshReg$ = () => {}`; `window.$RefreshSig$ = () => (type) => type`.
- `const modules = new Map()` key → `{ url, exports }`. `window.__devRefresh = { register: RefreshRuntime.register, createSignatureFunctionForTransform: RefreshRuntime.createSignatureFunctionForTransform, registerModule(key, url) { import(url).then((exports) => { registerExportsForReactRefresh(RefreshRuntime, key, exports); modules.set(key, { url, exports }); }); } }`.
- `enqueueRefresh()`: debounce 16 ms then `RefreshRuntime.performReactRefresh()`.
- On `update`: `hideError()`; for each module in order: `kind === "css"` → `await import(`/${key}?v=${digest}`)`; `kind === "js"` and `modules.has(key)` → `next = await import(`/${key}?v=${digest}`)`, `reason = validateRefreshBoundary(RefreshRuntime, modules.get(key).exports, next)`; if `reason` → `console.warn(`[dev] reload: ${key}: ${reason}`)` and `location.reload()`; else `modules.set(key, { url, exports: next })` and `enqueueRefresh()`; a `js` module not in `modules` is skipped (never loaded by this page). Any import error → `location.reload()`.
- On `reload`: `location.reload()`. On `ok`: `hideError()`. On `error`: `showError(message)`.

Note the `import("/key?v=digest")` of a wrapped module calls `registerModule` again with the new URL, which re-registers its exports; `modules.set` in the update handler must therefore not race it: read `prevExports` *before* the import.

- [ ] **Step 7: Prebundle the refresh runtime**

`package.json`: add `react-refresh` to `devDependencies`; refresh the lockfile. `react_app.bzl`: `npm_prebundle(name + ".npm.dev", npm_imports + ["react-refresh/runtime"], npm_deps + [Label("//:node_modules/react-refresh")], dev = True)` and use *its* returned dict as `npm_entries` (a superset of the prod dict). The prod prebundle must not include `react-refresh/runtime`: its CommonJS entry throws under `NODE_ENV=production`, which the prebundle config's build-time `require` would hit.

- [ ] **Step 8: Run tests and a manual check**

Run: `bazel test //tools/dev/... --nocache_test_results` → PASS.
Run: `bazel run //examples/hello:hello.dev`, open the page with headless chromium (see the foundation's scratchpad scripts; `/usr/bin/chromium --headless --dump-dom`), confirm the console shows no `__devRefresh` errors and `/npm/react-refresh__runtime.js` returns 200. Stop the server.

- [ ] **Step 9: Commit**

```bash
git add tools/dev/web bazel/js/react_app.bzl package.json pnpm-lock.yaml
git commit -m "feat: HMR: update/reload/ok decision, react-refresh client, css hot swap"
```

---

### Task 5: `<name>.typecheck`

**Files:**
- Create: `bazel/js/typecheck.bzl` (`typecheck_tsconfig` rule), `bazel/js/css.d.ts`, modify `bazel/js/BUILD.bazel` (a `js_library` `css_types` exporting `css.d.ts`)
- Modify: `bazel/js/react_app.bzl` (new `typecheck_deps` attribute, `<name>.typecheck` target)
- Modify: `examples/hello/BUILD.bazel`, `docs/using-the-dev-server.md` (attribute table row only; Task 6 does the rest)

**Interfaces:**
- Consumes: `JsSourceInfo(srcs, packages)` from `js_library`; `//:tsconfig_json`; rules_js `bin.tsc_test` from `load("@npm//:typescript/package_json.bzl", "bin")`.
- Produces: `typecheck_tsconfig(name, deps, out)` writes a tsconfig that `extends` the root one, lists every transitive source and `bazel/js/css.d.ts` in `files`, and sets `compilerOptions.paths` from `packages`: `"<name>": ["<rel>/<root>"]` and `"<name>/*": ["<rel>/<root>/*"]`, every path relative to the generated file's directory. `react_app(..., typecheck_deps = [])` declares `bin.tsc_test(name = name + ".typecheck", ...)`.

- [ ] **Step 1: Write the failing check**

Add to `examples/hello/BUILD.bazel`: `typecheck_deps = ["//:node_modules/@types/react", "//:node_modules/@types/react-dom"]`. Run `bazel test //examples/hello:hello.typecheck`.
Expected: FAIL, no such target.

- [ ] **Step 2: Implement `typecheck_tsconfig`**

Rule attrs: `deps` (labels with `JsSourceInfo`), `extra_files` (labels, allow files; default `["//bazel/js:css.d.ts"]`), `out`. Write with `ctx.actions.write(out, json.encode_indent({...}))`. Relative paths: from `ctx.label.package` up to the workspace root (`"../" * depth`) then down to the file's `short_path`; `extends` is that prefix plus `tsconfig.json`. Put `"noEmit": true` in `compilerOptions`.

`css.d.ts`:

```ts
declare module "*.module.css" { const classes: { readonly [name: string]: string }; export default classes; }
declare module "*.css" { const classes: { readonly [name: string]: string }; export default classes; }
```

- [ ] **Step 3: Declare the test in `react_app.bzl`**

```python
typecheck_tsconfig(name = name + ".typecheck.tsconfig", deps = [":" + name + ".src"], out = name + ".typecheck.tsconfig.json")
tsc.tsc_test(
    name = name + ".typecheck",
    args = ["-p", "$(rootpath :%s.typecheck.tsconfig)" % name],
    data = [":" + name + ".typecheck.tsconfig", ":" + name + ".src", Label("//:tsconfig_json"), Label("//bazel/js:css_types")] + typecheck_deps,
)
```

with `load("@npm//:typescript/package_json.bzl", tsc = "bin")`. Add `typescript` to `package.json` if it is not installed through the lockfile already (it is listed; confirm `//:node_modules/typescript` exists). If `$(rootpath)` resolves against the wrong directory at test time, pass `chdir = native.package_name()` and make the paths package-relative; record which in a comment.

- [ ] **Step 4: Verify pass and fail**

Run: `bazel test //examples/hello:hello.typecheck` → PASS.
Introduce `const x: number = "s";` in `App.tsx`; run again → FAIL and the log names `examples/hello/src/App.tsx` with a line number. Revert. With the dev server running during the broken state, confirm it still serves (SWC strips types). Also confirm `@example/ui` resolves: temporarily import a non-existent name from it → tsc error, revert.

- [ ] **Step 5: Commit**

```bash
git add bazel/js examples/hello/BUILD.bazel docs/using-the-dev-server.md
git commit -m "feat: <name>.typecheck runs tsc over a generated tsconfig with paths from package_name"
```

---

### Task 6: Example CSS, browser acceptance, docs

**Files:**
- Create: `examples/hello/src/App.module.css`, `examples/shared/ui/button.css`
- Modify: `examples/hello/src/App.tsx`, `examples/shared/ui/Button.tsx`, `examples/shared/ui/BUILD.bazel`
- Modify: `docs/using-the-dev-server.md`, `README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: the acceptance evidence for spec milestones 3 and 4 in the docs.

- [ ] **Step 1: Add CSS to the example**

`App.module.css`: `.title { color: rebeccapurple }`; `App.tsx`: `import styles from "./App.module.css"; <h1 className={styles.title}>`. `button.css`: `.ui-button { padding: 4px 12px }`; `Button.tsx`: `import "./button.css";` and `className="ui-button"`; add `button.css` to the library's `srcs`.

Run: `bazel test //examples/hello:hello.typecheck && bazel build //examples/hello:hello.bundle` → PASS; `main.css` holds both rules with the hashed `.title` name; `grep -o 'className:"[^"]*"' main.js` is not meaningful after bundling, so instead check `grep -c "$(grep -o '\.[A-Za-z0-9_-]*title[A-Za-z0-9_-]*' bazel-bin/examples/hello/hello.bundle/main.css | head -1 | tr -d .)" bazel-bin/examples/hello/hello.bundle/main.js` is at least 1 (the same hashed name appears in JS and CSS).

- [ ] **Step 2: Browser acceptance (state survives)**

Write a scratchpad script driving headless chromium through its DevTools protocol, or Playwright if available, against `bazel run //examples/hello:hello.dev`:
1. Load the page, click the button three times, read the button text (`count is 3`).
2. Change the `<h1>` text in `App.tsx`; wait for the `update:` log line; read the `<h1>` and the button: new text, still `count is 3`, and `performance.getEntriesByType("navigation").length === 1` (no reload).
3. Change `.title` color in `App.module.css`; wait; `getComputedStyle(h1).color` reflects it; button still `count is 3`.
4. Change `main.tsx` (add a comment then a real statement, e.g. `console.log("x")`); wait; a full reload occurred (navigation entries or a marker on `window` gone).
5. Break `App.tsx` syntax; overlay present. Fix it; overlay gone without reload.
Record the `built in`/`update:` lines for ten component edits and compute the median.

- [ ] **Step 3: Update the docs**

`docs/using-the-dev-server.md`: `srcs` may include `.css`; `typecheck_deps`; `deps` with `package_name`; the `update:` / `reload: <reason>` / `pushed in` log lines; the four WebSocket messages; what hot-updates and what reloads (components yes, CSS yes, entry and plain modules no, non-component exports no); the `.module.css` contract (Lightning CSS hashes, same in dev and prod); the `main.css` link in the prod bundle; `bazel test :<name>.typecheck`; the median from Step 2 under "Warm save-to-update time"; remove the "Current limits" lines this plan resolved and keep Svelte, assets and hardening. `README.md`: one line each for refresh, CSS and typecheck.

- [ ] **Step 4: Full suite and commit**

Run: `bazel test //... --nocache_test_results` → all PASS.

```bash
git add examples docs README.md
git commit -m "docs: Fast Refresh, CSS modules and typecheck in the example and guide"
```
