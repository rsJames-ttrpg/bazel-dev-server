# Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The dev server watches only the app's source roots and re-roots after a `BUILD` change, survives deleted and renamed files with a readable overlay instead of a blank page, reports concurrent Bazel commands and watcher trouble, forwards Bazel flags to its nested builds, resolves `package_name` imports identically in all three resolvers, and serves stylesheets from npm packages.

**Architecture:** The manifest gains a `watch` section (source roots and extra files) computed from the module sources, so the driver learns the roots from the same artifact it already reads and re-roots the watcher when a build changes them. The watcher watches those roots, surfaces errors, and the driver answers an error or an explicit request with one more full build (every build is already a full incremental build of the target, so "fall back to a full build" is the normal path). The web server validates every import of the new manifest after each build and shows unresolved ones in the overlay, replaying the current error to browsers that connect later. `main.js` accepts `--bazel-arg` and passes it to every nested Bazel command. The prebundle learns to emit a style-injecting module for `.css` specifiers. This is spec milestone 5 plus the deferred items both ledgers assigned to hardening.

**Tech Stack:** As before: Bazel 8 bzlmod, rules_js, chokidar 4, esbuild, Lightning CSS, `node:test` via `js_test`, JS ESM with `// @ts-check`.

**Spec:** `docs/superpowers/specs/2026-11-15-hermetic-dev-server-design.md` (section "2. Driver", "3. Web server", milestone 5)

**Ledgers whose deferred items this plan absorbs:** `docs/superpowers/plans/2026-11-15-foundation-ledger.md`, `docs/superpowers/plans/2026-11-16-followups-ledger.md`

## Global Constraints

- Every file the browser loads is a Bazel output. The dev server reads files only from Bazel's execution root; its only string-level edit is rewriting import specifiers to URLs.
- One `bazel build` per change; the builder never runs two builds at once. The driver never kills or restarts the Bazel server.
- A failed build keeps the last good outputs served; the server process never exits on a build failure, a watcher error or a nested Bazel error after startup.
- The `packages` map from `JsSourceInfo` is the single input to all three resolvers (dev rewrite, esbuild bundle plugin, typecheck `paths`), and all three pick the longest matching package name.
- Module URLs and manifest keys are workspace-relative source paths.
- The server logs every cycle and every HMR decision; every new condition this plan handles (re-rooting, watcher error, forced rebuild, analysis cache discarded, unresolved imports) is logged on one line.
- Warm save-to-update on `examples/hello` must still log under 600 ms.
- Keep the chokidar watcher (the spec names `@parcel/watcher`; the foundation ledger ruled chokidar).
- Linux and macOS only.
- Commits are small and frequent; every task ends with a commit on branch `hardening`.

## Deferred by this plan (recorded so the executor does not re-decide them)

- Non-CSS assets (images, fonts) through the module tree.
- The transform toolchain and CSS preprocessor hook (Svelte plan).
- Rebuilding when `MODULE.bazel`, `pnpm-lock.yaml` or the tool's own sources under `tools/` and `bazel/` change: restart the dev server after those.
- The rules_js "dependency checking of directories is unsound" warnings on `@swc/core` platform packages.

## Review Focus

- Deleting a file another module still imports: the page must not go blank; the overlay names the importer and the specifier, and fixing the importer clears it. Test in Task 4 (`findUnresolved` and the server test "unresolved imports after a build are shown and replayed").
- An edit outside the app's source roots (another app, the tool's own sources) must not trigger a build. Test in Task 2 (real-chokidar test "only the roots are watched").
- Adding a `deps` entry to the app's `BUILD` file: the next cycle must watch the new package without a restart. Test in Task 3 (driver test "re-roots the watcher when the manifest's watch section changes").
- Another Bazel command changing options (`--compilation_mode`) discards the analysis cache; the next dev build takes seconds and the user must be told why. Test in Task 3 (builder test "reports a discarded analysis cache").
- A `git checkout` touching hundreds of files, or an inotify error: exactly one more build, never a crash. Tests in Task 2 (burst is one change; error is delivered) and Task 3 (a watcher error triggers one cycle).

---

## Interfaces this plan adds (summary)

- Manifest version 3: `watch: { roots: string[], files: string[] }`, workspace-relative, sorted, roots unique; `""` is the workspace root.
- `write_manifest` flags: `--watch-root <dir>` (repeatable), `--watch-file <path>` (repeatable).
- `createWatcher({ root, roots, files, debounceMs?, ignored?, watch? })` returns `{ on(event: "change" | "error", cb), update({ roots, files }), close() }`.
- Driver: `requestBuild()` public; logs `watching <roots>` at start and after re-rooting; `watcher error: <message>; rebuilding`; `rebuild requested`.
- Builder: `onAnalysisDiscarded()` callback; error text without Bazel progress lines.
- Server: `findUnresolved(manifest)` in `rewrite.js`; an `error` message after `built` when imports are unresolved; the current error replayed to each new WebSocket connection.
- `main.js`: `--bazel-arg <flag>` (repeatable; `--bazel-arg=--config=x` form works); `r` + Enter on a TTY stdin requests a build.
- `npm_prebundle`: a `.css` specifier yields `<name>__<path>.css.js` that injects the stylesheet.
- `transform_modules` and `typecheck_tsconfig` fail at analysis time on external-repository sources and on two sources with the same output stem.

---

### Task 1: Manifest `watch` section

**Files:**
- Modify: `bazel/js/manifest.bzl`
- Modify: `tools/manifest/write_manifest.js`
- Modify: `tools/dev/driver/manifest.js` (typedef only)
- Test: `tools/manifest/write_manifest.test.js`

**Interfaces:**
- Consumes: `ModulesInfo.modules[].src` (a `File` with `.owner.package`), `ctx.file.index_html`, `ctx.file.tsconfig`.
- Produces: manifest `version: 3` with `watch: { roots: string[], files: string[] }`. Roots are the Bazel packages (workspace-relative directories) of every module source and of `index_html`, sorted and unique. Files are extra single files to watch: the root `tsconfig.json` (its `short_path`). Task 2 and Task 3 consume `manifest.watch`.

- [ ] **Step 1: Write the failing tests** in `tools/manifest/write_manifest.test.js`

```js
test("version 3 carries a sorted, unique watch section", () => {
  const m = buildManifest({ ...base, watch: { roots: ["examples/hello", "examples/shared/ui", "examples/hello"], files: ["tsconfig.json"] } });
  assert.equal(m.version, 3);
  assert.deepEqual(m.watch, { roots: ["examples/hello", "examples/shared/ui"], files: ["tsconfig.json"] });
});
test("a missing watch section becomes empty lists", () => {
  assert.deepEqual(buildManifest(base).watch, { roots: [], files: [] });
});
```

`base` is the existing fixture input the file already uses for `buildManifest`. Update the existing assertion on `version` from 2 to 3.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bazel test //tools/manifest:write_manifest_test --test_output=errors`
Expected: FAIL (version is 2; `watch` undefined)

- [ ] **Step 3: Implement** in `write_manifest.js`: `buildManifest` takes an optional `watch`, emits `version: 3` and `watch: { roots: sortedUnique, files: sortedUnique }`; `main` accepts repeatable `--watch-root` and `--watch-file` flags. In `manifest.bzl`, compute roots as `sorted({m.src.owner.package: None for m in info.modules} | {ctx.file.index_html.owner.package: None})` (Starlark: build a dict, take its keys, sort), add `tsconfig` attr (`attr.label(default = "//:tsconfig.json", allow_single_file = True)`) and pass `--watch-file <tsconfig short_path>`. Update the `Manifest` typedef in `tools/dev/driver/manifest.js` with `watch?: { roots: string[], files: string[] }`.

- [ ] **Step 4: Run the tests and the example build**

Run: `bazel test //tools/manifest:write_manifest_test && bazel build //examples/hello:hello.manifest.dev && cat $(bazel cquery --output=files //examples/hello:hello.manifest.dev 2>/dev/null) | head -20`
Expected: PASS; the manifest shows `"version": 3` and `"watch": {"roots": ["examples/hello", "examples/shared/ui"], "files": ["tsconfig.json"]}`.

- [ ] **Step 5: Commit**

```bash
git add bazel/js/manifest.bzl tools/manifest tools/dev/driver/manifest.js
git commit -m "feat: manifest v3 carries the watch roots and files of the app"
```

---

### Task 2: Watcher over source roots, re-rootable, with error delivery

**Files:**
- Modify: `tools/dev/driver/watcher.js`
- Test: `tools/dev/driver/watcher.test.js`

**Interfaces:**
- Consumes: chokidar 4 (`watch(paths: string[], opts)`, `fs.add(paths)`, `fs.unwatch(paths)`, `fs.on("error")`).
- Produces: `createWatcher({ root, roots, files, debounceMs = 20, ignored = DEFAULT_IGNORED, watch = chokidar.watch })` returning `{ on(event, cb), update({ roots, files }), close() }`. `roots` and `files` are workspace-relative (`""` means `root` itself); absolute paths are watched. `on("change", cb)` as today; `on("error", cb)` delivers chokidar errors as `Error`. `update` adds the paths that are new and unwatches the ones that disappeared, and is a no-op for an unchanged set. `DEFAULT_IGNORED = ["bazel-*", "bazel-*/**", "**/node_modules", "**/node_modules/**", "**/.git", "**/.git/**"]`.

- [ ] **Step 1: Write the failing tests** in `watcher.test.js`

```js
test("watches only the roots and files given", () => {
  const paths = []; const fake = new EventEmitter(); fake.close = async () => {};
  createWatcher({ root: "/r", roots: ["a", ""], files: ["tsconfig.json"], watch: (p) => { paths.push(...p); return fake; } });
  assert.deepEqual(paths, ["/r/a", "/r", "/r/tsconfig.json"]);
});
test("update adds new roots and unwatches removed ones", () => {
  const fake = new EventEmitter(); fake.close = async () => {};
  const added = [], removed = [];
  fake.add = (p) => added.push(...p); fake.unwatch = (p) => removed.push(...p);
  const w = createWatcher({ root: "/r", roots: ["a"], files: [], watch: () => fake });
  w.update({ roots: ["a", "b"], files: ["t.json"] });
  w.update({ roots: ["b"], files: ["t.json"] });
  w.update({ roots: ["b"], files: ["t.json"] });
  assert.deepEqual(added, ["/r/b", "/r/t.json"]);
  assert.deepEqual(removed, ["/r/a"]);
});
test("delivers watcher errors", async () => {
  const fake = new EventEmitter(); fake.close = async () => {};
  const w = createWatcher({ root: "/r", roots: [""], files: [], watch: () => fake });
  const errors = []; w.on("error", (e) => errors.push(e.message));
  fake.emit("error", new Error("ENOSPC"));
  assert.deepEqual(errors, ["ENOSPC"]);
});
test("a plain file named bazel-* is not ignored; bazel-out and node_modules are", async () => {
  // real chokidar, temp dir: files src/bazel-utils.ts, bazel-out/x.js, node_modules/y.js, other/z.ts
  // roots: ["src"]; after writing all four, exactly one change containing only src/bazel-utils.ts
});
test("only the roots are watched", async () => {
  // real chokidar: roots ["app"]; writes to app/a.ts and other/b.ts yield one change == [app/a.ts]
});
```

Flesh out the two real-chokidar tests in the style of the existing "real chokidar ignores" test (temp dir, 500 ms ready sleep, 700 ms settle, `rm` in `finally`). Update that existing test to pass `roots: [""]`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bazel test //tools/dev/driver:watcher_test --test_output=errors`
Expected: FAIL (`roots` ignored, `update` undefined, `src/bazel-utils.ts` ignored)

- [ ] **Step 3: Implement** in `watcher.js`. `globToRegExp`: a trailing `/**` requires the slash (`(?:/.*)?` becomes `/.*`). Keep the ignore matcher relative to `root`. `toAbs = (p) => p === "" ? root : resolve(root, p)`; the watched set is a `Set<string>` of absolute paths; `update` diffs against it. Forward chokidar `error` events to `on("error")` listeners.

- [ ] **Step 4: Run the tests**

Run: `bazel test //tools/dev/driver:watcher_test --test_output=errors`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tools/dev/driver/watcher.js tools/dev/driver/watcher.test.js
git commit -m "feat: watcher watches the app's source roots, re-roots on update and reports errors"
```

---

### Task 3: Driver re-roots, rebuilds on request or watcher error; builder reports lock waits and discarded analysis cleanly

**Files:**
- Modify: `tools/dev/driver/driver.js`
- Modify: `tools/dev/driver/builder.js`
- Modify: `tools/dev/web/main.js`
- Test: `tools/dev/driver/driver.test.js`, `tools/dev/driver/builder.test.js`

**Interfaces:**
- Consumes: Task 1 `manifest.watch`; Task 2 `createWatcher({ root, roots, files })`, `update`, `on("error")`.
- Produces: `driver.requestBuild()` (coalesces like a change); log lines `watching <roots joined by ", ">` (`""` printed as `.`), `watcher error: <message>; rebuilding`, `rebuild requested`, `analysis cache discarded: Bazel options changed (another command?); this build is slower`. Builder option `onAnalysisDiscarded?: () => void`; `BuildResult.error` contains no Bazel progress lines.

- [ ] **Step 1: Write the failing driver tests** (extend `setup` so the fake watcher records `update` calls and exposes `fireError`)

```js
test("watches the manifest's roots at start and logs them", async () => {
  // manifest with watch { roots: ["app", "lib"], files: ["tsconfig.json"] }
  // createWatcher spy records its opts; assert opts.roots deepEqual ["app","lib"], opts.files ["tsconfig.json"]
  // assert logs[0] === "watching app, lib"
});
test("re-roots the watcher when the manifest's watch section changes", async () => {
  // manifests: m1 watch roots ["app"], m2 watch roots ["app","lib"], m3 same as m2
  // after two changes: watcher.update called once with m2.watch; logs include "watching app, lib" once after the built line
});
test("a watcher error logs and triggers one cycle", async () => {
  // fireError(new Error("ENOSPC")); after settle: builds() === 1; logs[0] === "watcher error: ENOSPC; rebuilding"
});
test("requestBuild runs a cycle and coalesces with changes", async () => {
  // first build delayed 40ms; driver.requestBuild(); driver.requestBuild(); await sleep(10); change(); settle → assert.equal(s.builds(), 2)
});
```

- [ ] **Step 2: Write the failing builder tests**

```js
test("reports a discarded analysis cache", async () => {
  let discarded = 0;
  const { spawn } = fakeSpawn((c) => { c.stderr.emit("data", Buffer.from("WARNING: Build option --compilation_mode has changed, discarding analysis cache.\n")); c.emit("exit", 0); });
  await createBuilder({ workspaceDir: "/w", target: "//a:b", spawn, onAnalysisDiscarded: () => { discarded++; } }).request();
  assert.equal(discarded, 1);
});
test("error text omits Bazel progress lines but keeps action output", async () => {
  const text = "Loading: \nAnalyzing: target //a:b (1 packages loaded)\n[3 / 5] Transforming a.ts\nINFO: Analyzed target //a:b (0 packages loaded).\nINFO: From Transforming examples/hello/src/App.tsx:\nerror: Expected ';'\nERROR: /w/BUILD:1:1: JsTransform failed\n";
  const { spawn } = fakeSpawn((c) => { c.stderr.emit("data", Buffer.from(text)); c.emit("exit", 1); });
  const r = await createBuilder({ workspaceDir: "/w", target: "//a:b", spawn }).request();
  assert.deepEqual(r.error.split("\n"), ["INFO: From Transforming examples/hello/src/App.tsx:", "error: Expected ';'", "ERROR: /w/BUILD:1:1: JsTransform failed"]);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bazel test //tools/dev/driver:driver_test //tools/dev/driver:builder_test --test_output=errors`
Expected: FAIL

- [ ] **Step 4: Implement.** `driver.js`: `start()` creates the watcher from `manifest.watch ?? { roots: [""], files: [] }`, subscribes to `change` and `error`, logs `watching …`; `cycle()` after a good build compares `JSON.stringify(prev.watch)` with `next.watch` and calls `watcher.update(next.watch)` plus the log line when different; `requestBuild()` calls the same `onChange()` path; the builder gets `onAnalysisDiscarded` which logs the line above. `builder.js`: `onAnalysisDiscarded` fires once per build when a stderr line contains `discarding analysis cache`; `finish()` filters `lines` through `isProgressLine` (`/^(Loading:|Analyzing:|\[\d+ \/ \d+\]|INFO: (?!From ))/` or empty). `main.js`: after `driver.start()`, if `process.stdin.isTTY`, read lines and on `r` log `rebuild requested` and call `driver.requestBuild()`; keep stdin from holding the event loop open beyond `server.close` (`stdin.unref()` is not needed because the server runs until killed, but call `process.stdin.resume()` only when TTY).

- [ ] **Step 5: Run the tests**

Run: `bazel test //tools/dev/driver/... --test_output=errors`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add tools/dev/driver tools/dev/web/main.js
git commit -m "feat: driver re-roots the watcher, rebuilds on request or watcher error; builder reports discarded analysis and trims progress lines"
```

---

### Task 4: Unresolved imports in the overlay; error replay on connect

**Files:**
- Modify: `tools/dev/web/rewrite.js`
- Modify: `tools/dev/web/server.js`
- Test: `tools/dev/web/rewrite.test.js`, `tools/dev/web/server.test.js`

**Interfaces:**
- Consumes: manifest `modules[key].imports` (specifiers recorded by the transform), `resolve` in `rewrite.js`, `decide(e, failed)`.
- Produces: `findUnresolved(manifest): { key: string, specifier: string }[]` (sorted by key then specifier; relative, package and bare specifiers alike). Server state `lastError: string | null`; after `built`, `lastError` is the formatted unresolved list or `null`; `decide` receives `lastError !== null` as `failed`; the `error` message is broadcast after the HMR message; a new WebSocket connection receives `{ type: "error", message: lastError }` immediately when it is non-null. Log line per unresolved import at build time: `cannot resolve "<spec>" from <key><hint>`, hint `; add it to npm_imports of <app>` for bare specifiers, `; not in srcs of <app> or its deps` otherwise.

- [ ] **Step 1: Write the failing tests**

`rewrite.test.js`:
```js
test("findUnresolved lists every import no resolver can serve", () => {
  const manifest = { entry: "a/main.tsx", packages: { "@x/ui": "ui" }, npm: { dir: "n", entries: { react: "react.js" } },
    modules: { "a/main.tsx": { imports: ["react", "./App", "./Missing", "@x/ui", "@x/ui/Gone", "lodash"] }, "a/App.tsx": { imports: [] }, "ui/index.ts": { imports: [] } } };
  assert.deepEqual(findUnresolved(manifest), [
    { key: "a/main.tsx", specifier: "./Missing" }, { key: "a/main.tsx", specifier: "@x/ui/Gone" }, { key: "a/main.tsx", specifier: "lodash" },
  ]);
});
```

`server.test.js` (the fixture's `main.tsx` already imports `./Missing`):
```js
test("unresolved imports after a build are shown and replayed to new connections", async (t) => {
  // listen; connect ws1; emit built with changed ["app/src/App.tsx"] → ws1 gets ["update", "error"]; error.message matches /app\/src\/main\.tsx: "\.\/Missing"/
  // connect ws2 after → first message is the same error
  // emit built where manifest.modules["app/src/main.tsx"].imports = ["./App"] and changed [] → both get ["ok"]
  // log lines include 'cannot resolve "./Missing" from app/src/main.tsx; not in srcs of //app:app or its deps'
});
test("a connection during a failed build gets the overlay", async (t) => {
  // emit failed { error: "boom" } before connecting; connect; first message is { type: "error", message: "boom" }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bazel test //tools/dev/web:rewrite_test //tools/dev/web:server_test --test_output=errors`
Expected: FAIL

- [ ] **Step 3: Implement.** `rewrite.js`: export `findUnresolved` built on the existing `resolve`. `server.js`: replace the `failed` boolean with `lastError`; a `formatUnresolved(list)` helper producing `unresolved imports:\n  <key>: "<spec>"<hint>` lines; compute at `listen()` (log only, set `lastError`) and on every `built`; `wss.on("connection")` sends `lastError` when set. Keep the per-request `reported` logging as is.

- [ ] **Step 4: Run the tests**

Run: `bazel test //tools/dev/web/... --test_output=errors`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tools/dev/web
git commit -m "feat: unresolved imports show in the overlay after each build; the current error is replayed to new connections"
```

---

### Task 5: Bazel flag forwarding and cleaner startup

**Files:**
- Modify: `tools/dev/web/main.js`
- Modify: `tools/dev/driver/builder.js`, `tools/dev/driver/driver.js` (pass-through of `bazelArgs`)
- Test: `tools/dev/driver/builder.test.js`

**Interfaces:**
- Consumes: `parseArgs` with `{ "bazel-arg": { type: "string", multiple: true } }`.
- Produces: `createBuilder({ ..., bazelArgs?: string[] })` spawns `bazel build ...bazelArgs target`; `createDriver({ ..., bazelArgs? })` forwards; `main.js` passes `bazelArgs` to the startup `cquery` too, so the existing mismatch check validates the forwarded flags. Startup failures of `bazel info`/`cquery` print `dev server: bazel <subcommand> failed (exit <code>)` and exit 1 with no stack trace. The ready line reads `dev server at http://127.0.0.1:<port>`.

- [ ] **Step 1: Write the failing builder test**

```js
test("forwards bazel args before the target", async () => {
  const { spawn, spawned } = fakeSpawn((c) => c.emit("exit", 0));
  await createBuilder({ workspaceDir: "/w", target: "//a:b", spawn, bazelArgs: ["--config=x", "--define=a=b"] }).request();
  assert.deepEqual(spawned[0].args, ["build", "--config=x", "--define=a=b", "//a:b"]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bazel test //tools/dev/driver:builder_test --test_output=errors`
Expected: FAIL

- [ ] **Step 3: Implement** the three files. In `main.js` wrap each startup `bazel(...)` call in a try/catch that prints the message above (the child's stderr is already inherited) and exits. Document the flag in the usage line.

- [ ] **Step 4: Verify by hand**

Run: `bazel run //examples/hello:hello.dev -- --bazel-arg=--nobuild_runfile_links` in the background for ten seconds, confirm the ready line, then stop it. Run: `bazel run --compilation_mode=opt //examples/hello:hello.dev` and confirm the mismatch message appears without a stack trace (the manifest path differs under `opt`). Record both outputs in the report.

- [ ] **Step 5: Run the tests and commit**

```bash
bazel test //tools/dev/... --test_output=errors
git add tools/dev
git commit -m "feat: --bazel-arg forwards Bazel flags to nested builds; startup errors print one line"
```

---

### Task 6: Resolver parity and clear analysis-time failures

**Files:**
- Modify: `tools/dev/web/rewrite.js`
- Modify: `bazel/js/esbuild_bundle.config.mjs.tpl`
- Modify: `bazel/js/transform.bzl`, `bazel/js/typecheck.bzl`
- Test: `tools/dev/web/rewrite.test.js`, `bazel/js/config.test.js`

**Interfaces:**
- Consumes: `manifest.packages`, `PACKAGES` in the bundle template.
- Produces: both JS resolvers match the longest package name (`@x/ui/icons` wins over `@x/ui` for `@x/ui/icons/Arrow`), the same way TypeScript's `paths` does. `transform_modules` fails with `sources from external repositories are not supported: <short_path>` and `two sources share the output stem <stem>: <a>, <b>`; `typecheck_tsconfig` fails with the external-repository message.

- [ ] **Step 1: Write the failing tests**

`rewrite.test.js`:
```js
test("the longest package name wins", () => {
  const manifest = { entry: "a/main.tsx", packages: { "@x/ui": "ui", "@x/ui/icons": "icons" }, npm: { dir: "n", entries: {} },
    modules: { "a/main.tsx": { imports: [] }, "ui/index.ts": { imports: [] }, "ui/icons/Arrow.tsx": { imports: [] }, "icons/Arrow.tsx": { imports: [] } } };
  const { code } = rewriteImports(`import "@x/ui/icons/Arrow"; import "@x/ui";`, "a/main.tsx", manifest);
  assert.equal(code, `import "/icons/Arrow.tsx"; import "/ui/index.ts";`);
});
```

`config.test.js`: add a case rendering the template with `PACKAGES = {"@x/ui": "ui", "@x/ui/icons": "icons"}`, run the plugin's `onResolve` for `@x/ui/icons/Arrow` through a stub `build` (capture the callback registered for the bare filter, call it with `{ path: "@x/ui/icons/Arrow", kind: "import-statement" }`, stub `build.resolve` to return its first argument) and assert the resolved path ends with `icons/Arrow`.

- [ ] **Step 2: Run them to verify they fail**

Run: `bazel test //tools/dev/web:rewrite_test //bazel/js:config_test --test_output=errors`
Expected: FAIL

- [ ] **Step 3: Implement.** Sort package names by length descending once (`rewrite.js`: in `resolve` and `isBareSpecifier`; template: in `packagePath`). In `transform.bzl`, before declaring outputs: `if src.short_path.startswith("../"): fail(...)`; track declared `out` paths in a dict and `fail` on a duplicate naming both sources. In `typecheck.bzl`, the same external-repository check over `srcs`.

- [ ] **Step 4: Verify the Starlark failures by hand**

Create a temporary `examples/hello/src/App.ts` next to `App.tsx`, run `bazel build //examples/hello:hello.modules`, confirm the stem-collision message, delete the file. Record the message in the report.

- [ ] **Step 5: Run the tests and commit**

```bash
bazel test //... --test_output=errors
git add tools/dev/web bazel/js
git commit -m "fix: longest package name wins in every resolver; clear failures for external sources and stem collisions"
```

---

### Task 7: Stylesheets from npm packages

**Files:**
- Modify: `bazel/js/npm.bzl` (remove the `.css` `fail`)
- Modify: `bazel/js/esbuild_prebundle.config.mjs.tpl`
- Modify: `package.json`, `pnpm-lock.yaml` (add `normalize.css@8.0.1`)
- Modify: `examples/hello/BUILD.bazel`, `examples/hello/src/main.tsx`
- Modify: `docs/using-the-dev-server.md` ("Current limits": drop the npm stylesheet line; "CSS": one paragraph on npm stylesheets)

**Interfaces:**
- Consumes: `npm_entry_name`, the prebundle plugin's virtual entries, `rewrite.js` npm entry lookup (unchanged: `entries["normalize.css"]` → `/npm/normalize.css.js`).
- Produces: for a specifier ending in `.css`, the prebundle entry source is
  ```js
  import css from "<spec>";
  const el = document.createElement("style");
  el.dataset.devCss = "<spec>";
  el.textContent = css;
  document.head.append(el);
  export default css;
  ```
  with `build.initialOptions.loader[".css"] = "text"` set in the plugin; the output file is `<npm_entry_name(spec)>.js`. In production the bundle plugin leaves bare `.css` specifiers to esbuild, which collects them into `main.css` (already the case).

- [ ] **Step 1: Add the dependency and the example import**

Run: `pnpm add normalize.css@8.0.1` is not hermetic; instead add `"normalize.css": "8.0.1"` to `package.json` dependencies and run `bazel run -- @pnpm//:pnpm install --lockfile-only --dir $PWD`. In `examples/hello/BUILD.bazel` add `"normalize.css"` to `npm_imports` and `"//:node_modules/normalize.css"` to `npm_deps`. In `src/main.tsx` add `import "normalize.css";` as the first import.

- [ ] **Step 2: Build to see it fail**

Run: `bazel build //examples/hello:hello.manifest.dev`
Expected: FAIL with the `stylesheets from npm packages are not supported yet` message.

- [ ] **Step 3: Implement** the template and remove the `fail` in `npm.bzl`.

- [ ] **Step 4: Verify dev and prod**

Run: `bazel build //examples/hello:hello.manifest.dev //examples/hello:hello.bundle`, then confirm `normalize.css.js` exists in the dev npm directory and contains `data-dev-css` injection (grep `devCss`), and that `hello.bundle/main.css` contains `html{line-height:1.15` (normalize's first rule). Then `bazel run //examples/hello:hello.dev` in the background, fetch `http://127.0.0.1:5173/examples/hello/src/main.tsx` and confirm the first import is rewritten to `/npm/normalize.css.js`; stop the server.

- [ ] **Step 5: Run all tests, update the docs, commit**

```bash
bazel test //... --test_output=errors
git add package.json pnpm-lock.yaml bazel/js examples/hello docs/using-the-dev-server.md
git commit -m "feat: stylesheets from npm packages are served in dev and bundled in prod"
```

---

### Task 8: pnpm pin, docs, acceptance and ledger

**Files:**
- Modify: `MODULE.bazel`, `package.json` (`packageManager`)
- Modify: `docs/using-the-dev-server.md`, `README.md`
- Create: `docs/superpowers/plans/2026-11-16-hardening-ledger.md` (the executor's ledger, committed at the end)

- [ ] **Step 1: Pin pnpm.** Run `bazel run -- @pnpm//:pnpm --version` and pin exactly that version: `pnpm.pnpm(name = "pnpm", pnpm_version = "<v>")` before `use_repo(pnpm, "pnpm")` in `MODULE.bazel`, and `"packageManager": "pnpm@<v>"` in `package.json`. Run `bazel build //examples/hello:hello.manifest.dev` to confirm the lockfile still resolves.

- [ ] **Step 2: Docs.** In `docs/using-the-dev-server.md`: "Running it" gains the `--bazel-arg` form and the `r` + Enter rebuild; "What the terminal prints" lists the new lines (`watching …`, `watcher error: …; rebuilding`, `rebuild requested`, `analysis cache discarded …`, `waiting for Bazel server …`, `cannot resolve … from …`); a new section "When things go wrong" covers a deleted or renamed file (overlay lists the importer; fix the import or restore the file), a `BUILD` change (the next build re-roots the watcher; a new dep's files are watched from then on), another Bazel command (the build waits; changed options cost one slow build), and when to restart (changes to `MODULE.bazel`, `pnpm-lock.yaml`, `tools/`, `bazel/`); "Current limits" drops the hardening line. `README.md`: one line on hardening done.

- [ ] **Step 3: Acceptance run** (headless Chromium via the Playwright MCP tools or `chromium --headless`, as the earlier plans did). With `bazel run //examples/hello:hello.dev` running:
  1. Delete `examples/shared/ui/Button.tsx`: the page shows the overlay naming `examples/shared/ui/index.ts: "./Button"`; `git checkout` the file: the overlay clears (`ok` or `update` logged).
  2. Rename `App.module.css` to `App2.module.css` and fix the import in `App.tsx`: the page updates; rename back.
  3. Append a comment to `tools/dev/web/server.js`: no build is logged within two seconds.
  4. Remove `//examples/shared/ui` from the app's `deps` and its import from `App.tsx`: the next build logs `watching examples/hello`; restore both: `watching examples/hello, examples/shared/ui`.
  5. Press `r` + Enter in the server's terminal (or skip and note it if the server runs without a TTY): `rebuild requested` and a `built in` line.
  6. Ten component edits: median `built in` still under 600 ms.
  Record every log line observed in the report.

- [ ] **Step 4: Commit**

```bash
bazel test //... --nocache_test_results --test_output=errors
git add MODULE.bazel package.json docs README.md
git commit -m "docs: hardening guide, pnpm pin"
```
