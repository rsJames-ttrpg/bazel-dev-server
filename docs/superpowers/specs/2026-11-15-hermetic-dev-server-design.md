# Hermetic dev server for Bazel: design

Date: 2026-11-15
Status: approved pending final read; builder check done

## Intent

A development server for TypeScript React front ends in a Bazel repository,
where everything the browser loads is an output of `bazel build`. Save a file,
and the page updates within about half a second through React Fast Refresh,
without a full reload where possible. The same targets and toolchains produce
the production bundle, so what works in dev works in CI and nothing can drift
between the two.

The repository starts empty, so this project also chooses the repo layout and
the Bazel rules that make this natural.

Inspiration: cormacrelf's `buck2 dev` branch
(https://github.com/cormacrelf/buck2/tree/buck2-dev). It patches Buck2's
daemon so a long-running process can ask for build outputs one at a time and
hear when they go stale. Bazel offers no equivalent hook, so this design keeps
its ideas (build only what the running app needs, track staleness per output,
restart the app only when its own inputs change) but implements them outside
the build tool.

## Goals

- **Hermetic.** Every module, stylesheet and asset served in dev is produced by
  a Bazel action, using the same rules, toolchains and `node_modules` as the
  production build. The dev server never transpiles anything itself.
- **Fast feedback.** Warm save-to-paint of about 300 to 600 ms for a typical
  edit, measured and logged by the server. Cold start is secondary.
- **Near-zero configuration.** An app is declared with one macro in its
  `BUILD` file and run with one `bazel run` command. No separate config file
  for the dev server in the common case.
- **React Fast Refresh** for component edits. Full reload as the fallback
  when a change cannot be applied in place.
- **Pluggable transforms**, so Svelte and CSS pre- or post-processing can be
  added later behind the same interface without touching the server core.

## Non-goals (for the first version)

- Per-module on-demand building as the browser discovers imports. See
  "Why one build per change" below.
- Tailwind or any whole-program CSS tooling.
- Svelte support. The transform interface must leave room for it; nothing
  more.
- The Rust and C++ egui desktop app. It is a later milestone that reuses the
  watcher and build driver; see "Later milestones".
- Type checking on the hot path. `tsc` runs as its own Bazel test or action,
  not between save and paint.
- Windows. Linux and macOS only.
- Server-side rendering, proxies to backend APIs, HTTPS. The server exposes a
  hook for middleware; these are not built.

## Anti-goals

What would make this a failure even if it technically works:

- The dev build and the production build disagree about anything observable:
  module resolution, JSX transform, TypeScript semantics, generated code.
- Save-to-paint that regularly exceeds a second on a warm server for a
  one-file edit.
- A setup that needs a per-app config file, a hand-maintained module list, or
  a second copy of dependency metadata next to `package.json`.
- The server falling over when another terminal runs `bazel build`, or when a
  build fails. A failed build keeps the last good page up and shows the error.

## Constraints

- Bazel with bzlmod. Node via rules_js from Aspect, which gives a hermetic
  Node toolchain and a `node_modules` tree built from a pnpm lockfile.
- TypeScript sources, React, plain CSS to start.
- The repo is empty, so layout, rule choice and conventions are all decided
  here.
- Each `bazel` invocation costs roughly 100 to 300 ms of client and server
  overhead before any action runs. This is the central constraint on the
  design.

## Scale and conventions

- Expected size: a few thousand TypeScript source files per repo, a handful
  of apps with shared packages between them. To be confirmed; if it turns out
  to be tens of thousands, revisit per-file actions (see "Left to the
  builder").
- `BUILD` files are written by hand. `srcs` use `glob`; `deps` between
  shared packages are listed explicitly. No Gazelle or generated `BUILD`
  files in scope.

## Why one build per change

Buck2's approach, one build request per module as the browser asks for it,
costs about 5 ms per warm request inside its daemon. In Bazel each request is
a separate `bazel build` with its fixed overhead, so a page of forty modules
would take seconds to load and every save would feel slow.

Instead the app's whole module set is one Bazel target. Each source file maps
to one output file through a per-file transform action that runs in a
persistent worker, so the action cache makes a one-file edit cost one small
action. On save, the server runs one incremental `bazel build` of that target,
reads a manifest the build writes, and diffs output digests against the last
manifest to learn which modules changed. One Bazel round trip per save.

The on-demand idea survives in a narrower form: the server builds only the
app target it serves, not the whole repo, and only after a change the watcher
reports under that target's source roots.

## Architecture

Three layers, each a separate package in the repo.

### 1. Rules: `//bazel/js`

A macro `react_app(name, srcs, deps, entry, index_html, npm_deps)` that
expands to:

- `<name>.modules`: a rule that runs the per-file transform over `srcs` and
  the transitive `srcs` of `deps`. Output is a tree that mirrors the source
  layout under `bazel-bin`, one `.js` per `.ts`/`.tsx`, and for each `.css`
  both a processed `.css` file and a small `.css.js` module that imports it,
  injects it in dev and supports HMR. The production bundle lets esbuild
  collect the `.css` files into a static stylesheet, so prod gets a
  `<link>`-ed file and dev gets injection, from one processed source.
  `*.module.css` scoping, when wanted, happens in the transform action
  (Lightning CSS) in both configurations, never in esbuild alone. Other
  assets are copied. (Builder-check call.) The transform is SWC through a persistent worker, with
  `jsc.transform.react.refresh` on in the dev configuration and off in prod.
  The same action, two configurations. The dev variant is reached through a
  rule transition on a `bool_flag` (`//bazel/js:dev`) applied by the
  `<name>.dev` target's dependency on `<name>.modules`, not through a
  command-line flag. A top-level flag would flip the analysis cache against
  a plain `bazel build` in another terminal and re-analyse the app on every
  cycle. With a transition both configurations live in one analysis cache.
  (Builder-check call.)
- `<name>.manifest`: a JSON file listing every output with its source path,
  output path and content digest, plus the npm dependency bundles it needs.
  The dev server reads only this file after each build; it never walks
  `bazel-bin`.
- `<name>.npm`: one pre-bundled ESM file per third-party package the app
  imports, built by an esbuild action from the rules_js `node_modules` tree.
  Equivalent to Vite's dependency optimiser, but as Bazel actions keyed on the
  lockfile, so they rebuild only when a dependency changes.
- `<name>.bundle`: the production bundle, built with esbuild from the same
  `<name>.modules` outputs and the same `<name>.npm` prebundle actions, run
  with production conditions. Serving the modules in dev and bundling them in
  prod from one tree is what makes the two agree. The one accepted, documented
  difference: dev uses React's development build and
  `NODE_ENV=development`, which Fast Refresh requires. (Builder-check call.)
- `<name>.dev`: a `js_binary` that runs the dev server with this app's labels
  baked in. `bazel run //app:app.dev` is the whole user-facing command.
- `<name>.typecheck`: a `tsc --noEmit` test target, off the hot path.

A `js_library` rule for shared packages carries `srcs`, `deps` and an
optional `package_name` (such as `@acme/ui`) with a provider that gives the
transform rule the transitive source list and each file's import root, so a
module's URL in dev matches its path in the repo. Apps import shared packages
either by relative path or by `package_name`; the provider carries the
name-to-root mapping, and the web server's rewrite, esbuild's aliases and the
typecheck target's `paths` are all generated from it so no two resolvers can
disagree. There is one root `tsconfig.json`; the macro derives the SWC
settings that affect semantics (JSX runtime, target, `useDefineForClassFields`,
`isolatedModules`) from it, so tsc and SWC see the same options.
(Builder-check call.)

Transforms are a Bazel toolchain, `//bazel/js:transform_toolchain`, holding
the worker binary and per-extension handlers. Adding Svelte means registering
a handler for `.svelte`; adding a CSS preprocessor means replacing the `.css`
handler. The server core knows nothing about extensions.

### 2. Driver: `//tools/dev/driver`

A Node library that owns the loop every dev target shares:

- **Watcher.** `@parcel/watcher` over the app's source roots and `BUILD`
  files, debounced at about 20 ms. Changes under `bazel-out` and
  `node_modules` are ignored.
- **Builder.** Runs `bazel build <target> --build_event_json_file=<tmp>` as a
  child process, one at a time, and queues at most one pending build while
  one runs; a change during a build marks the queued build dirty rather than
  starting another. Reads the manifest on success. On failure, parses the
  build event stream for the failed action's stderr and reports it with the
  file and line if SWC or tsc provided them.
- **Manifest diff.** Compares digests to the previous manifest and emits a
  `changed` set of modules, plus `added` and `removed`.
- **Status.** Logs each cycle's timings: watcher to build start, Bazel wall
  time, manifest read, push to client. These numbers are the goal's
  acceptance test.

The driver exposes an in-process API: `start()`, `onBuilt(cb)`, `onFailed(cb)`,
`requestBuild()`, `stop()`. There is no cross-process protocol in this
version. cormacrelf's JSON-lines protocol is noted for the egui milestone,
where the app is not a Node process.

Another `bazel` command in a different terminal blocks the build on the
server lock. The driver reports "waiting for Bazel server" after 2 s and
carries on; it never kills or restarts the Bazel server.

### 3. Web server: `//tools/dev/web`

An HTTP server on `localhost` with a WebSocket for HMR.

- Serves `index.html` with a script tag for the entry module and the HMR
  client.
- Serves modules from the paths in the manifest. Before sending a module it
  rewrites bare import specifiers (`react`) to `/npm/react.js` and relative
  imports to their manifest URLs, using `es-module-lexer`. This rewrite is
  string-level and leaves the Bazel output untouched; the production bundle
  resolves the same specifiers through esbuild, so behaviour matches.
- Serves npm bundles and assets from the manifest with long cache headers
  keyed on digest.
- On `changed` from the driver: for each changed module whose transform
  marked it Fast Refresh-capable, sends an HMR update; the client re-imports
  the module and calls the refresh runtime. For anything else (entry module,
  a CSS module not covered by injection, a module without refresh
  boundaries), sends a full reload.
- On `failed`: shows an error overlay in the page with the action's stderr.
  The last good modules stay served.
- A middleware hook, so an app can register proxies or extra routes from a
  small script named in the macro. Not used by the first version's example.

Target: the whole path from a changed module arriving in `changed` to the
WebSocket message leaving is under 10 ms, so Bazel's time is the only
significant term.

## Repo layout

```
MODULE.bazel
pnpm-lock.yaml, package.json          # root workspace for npm deps
bazel/js/                             # rules, macros, transform toolchain
tools/dev/driver/                     # watcher + builder + manifest diff
tools/dev/web/                        # HTTP, HMR, overlay, client runtime
tools/transform/                      # SWC persistent worker
examples/hello/                       # React app that exercises the loop
docs/                                 # this spec, user guide
```

## Milestones

1. **Transform and manifest.** Rules, SWC worker, `react_app` macro,
   manifest output, production bundle. Acceptance: `bazel build
   //examples/hello:hello.bundle` produces a working page; editing one file
   and rebuilding `hello.modules` re-runs one action.
2. **Serve with full reload.** Driver and web server; `bazel run
   //examples/hello:hello.dev` opens a page; any save rebuilds and reloads.
   Acceptance: logged warm save-to-reload under 600 ms on the example.
3. **Fast Refresh.** Refresh runtime in the client, per-module HMR, error
   overlay. Acceptance: editing a component keeps its state.
4. **npm prebundle and CSS modules.** Dependency bundles as Bazel actions;
   CSS injected as modules with HMR; the transform toolchain hook for a CSS
   preprocessor, with a no-op default.
5. **Hardening.** Concurrent `bazel` commands, `BUILD` file changes
   (re-query the target's source roots), deleted files, renames, watcher
   overflow (fall back to a full build).

## Later milestones, not designed here

- **Svelte.** A `.svelte` handler in the transform toolchain and a Svelte
  HMR client plugin.
- **egui app in Rust and C++.** A `<name>.dev` for a `rust_binary` that uses
  the same driver, restarts the process on a changed binary digest, and
  speaks a JSON-lines protocol over a Unix socket so the app can ask for
  outputs and acknowledge them, following cormacrelf's `DevInfo` protocol
  version 2 as a reference. Hot patching of Rust code is out of scope until
  the restart loop works.

## Left to the builder

- Exact rules_js, rules_ts, SWC and esbuild versions; whether rules_ts's
  `ts_project` is reused for the typecheck target or `tsc` is run directly.
- Whether the per-file transform is one action per file or one action per
  package with a worker that reports per-file digests. Either is fine if a
  one-file edit stays near one action's cost.
- The manifest's schema, the HMR message format and the client runtime's
  implementation, as long as the behaviours above hold.
- Debounce timing, overlay styling, port selection and the exact log format.
- How `BUILD` file changes are detected and how the watcher roots are
  refreshed after one.
