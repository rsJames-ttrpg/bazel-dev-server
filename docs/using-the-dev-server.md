# Using the dev server

## Declaring an app

Load `react_app` from `//bazel/js:react_app.bzl` in your package's `BUILD.bazel`. See `examples/hello/BUILD.bazel` for a complete example.

| Attribute | Meaning |
| --- | --- |
| `name` | Application name, the prefix of every target. |
| `srcs` | The app's `.ts`, `.tsx` and `.css` sources. |
| `entry` | Package-relative path of the entry source, for example `src/main.tsx`. |
| `index_html` | The app's `index.html`. |
| `npm_imports` | Bare specifiers the app imports from npm, for example `react` and `react-dom/client`. |
| `npm_deps` | Linked npm package targets that provide `npm_imports`, for example `//:node_modules/react`. |
| `deps` | `js_library` targets the app depends on. A library with `package_name`, for example `@example/ui`, is imported by that name in dev, in the bundle and in `<name>.typecheck`; its `srcs` may include `.css` too. Default is none. |
| `port` | Dev server port of `<name>.dev`. Default is 5173. |
| `typecheck_deps` | Linked npm targets `<name>.typecheck` needs, for example `//:node_modules/@types/react`. Default is none. |

If `react/jsx-runtime` is in `npm_imports`, the macro adds `react/jsx-dev-runtime` for you.

The macro declares `<name>.src`, `.modules`, `.npm`, `.npm.dev`, `.manifest`, `.manifest.dev`, `.bundle`, `.dev` and `.typecheck`. `bazel test :<name>.typecheck` runs `tsc` over the app and its `deps`; SWC strips types without checking them, so this is the only type gate. The root `tsconfig.json` is the single source of truth for `jsx`, `target`, `useDefineForClassFields` and `verbatimModuleSyntax`. Because `verbatimModuleSyntax` is on, type-only imports must be written `import type`. `typecheck_deps` lists the npm targets `tsc` needs and the app does not otherwise load, usually `@types` packages:

```
bazel test //examples/hello:hello.typecheck
```

## CSS

Each `.css` source is processed by Lightning CSS into a `.css` output plus a `.css.js` module. Import a plain stylesheet for its side effect, as `examples/shared/ui/Button.tsx` does with `import "./button.css";`.

A `*.module.css` file is a CSS module. Its default export maps each class to a hashed name, so `.title` in `App.module.css` is used as `className={styles.title}` and renders as `_41Zueq_title`. Lightning CSS's default pattern, a hash of the file name followed by the local name, is applied with the source's workspace-relative path as the file name in the transform, which the dev and production configurations share, so the exported names are the same in both. The production stylesheet uses the same names: esbuild treats the processed `.module.css` as plain CSS and never renames classes. A class that uses `composes` exports its own hashed name followed by the composed ones, separated by spaces.

In dev, evaluating the `.css.js` module puts the stylesheet in a `<style data-dev-css="<key>">` element in `<head>`. In the production bundle, esbuild collects every imported stylesheet into `main.css`, and `index.html` gets a `<link rel="stylesheet" href="./main.css">`. An app without CSS has no `main.css` and no link.

A stylesheet from an npm package is listed by its specifier in `npm_imports`, with its package in `npm_deps`, and imported for its side effect: `examples/hello` lists `"normalize.css"` and `"//:node_modules/normalize.css"` and starts `main.tsx` with `import "normalize.css";`. In dev the prebundle turns it into `/npm/normalize.css.js`, which puts the stylesheet text in a `<style data-dev-css="normalize.css">` element in `<head>`. In the production bundle, esbuild resolves it from `node_modules` and collects it into `main.css` with the workspace stylesheets.

## Running it

```
bazel run //examples/hello:hello.dev
```

Replace the label with your own `<name>.dev`. The dev configuration is reached only through a rule transition, never a command-line flag. Build the production bundle with `bazel build //path:<name>.bundle`.

To pass Bazel options to the nested builds, give them after `--` as `--bazel-arg`, once per option:

```
bazel run //examples/hello:hello.dev -- --bazel-arg=--config=x
```

They are forwarded to the nested `bazel info`, `cquery` and `build`. Only command options work this way, not startup options. If the outer `bazel run` itself was given flags that change the output path, the server still refuses to start (see below); put those in `.bazelrc`.

The server watches only the Bazel packages that hold the app's sources and `index.html`, plus `tsconfig.json`. Every build is a full incremental `bazel build` of `<name>.manifest.dev`, so a change the watcher missed is picked up by the next build. To force one, type `r` and press Enter in the server's terminal. This works only when stdin is a terminal; a server started with stdin redirected, for example in the background with `</dev/null`, ignores it. Run the server in the foreground or with stdin from `/dev/null`: a `bazel run … &` that keeps the terminal as stdin can be stopped by `SIGTTIN`.

## What the terminal prints

- `watching <dirs>` is logged at start and lists the watched packages, for example `watching examples/hello, examples/shared/ui`. It is logged again after a build that changed them, for example when a `deps` entry was added or removed.
- `dev server at http://127.0.0.1:5173` means the server is ready. It listens on 127.0.0.1 only.
- `built in <n>ms (bazel <m>ms): <k> modules changed` means a save triggered one nested `bazel build` of `<name>.manifest.dev`. `n` is the total time, `m` the time spent in Bazel, `k` the number of modules whose output changed. `, <a> added`, `, <r> removed`, `, npm changed` or `, index changed` is appended when modules were added or removed or the npm prebundles or `index.html` changed.
- `update: <k> modules` means the browser was sent `update` for `k` changed modules and hot-updates them in place.
- `reload: <reason>` means the browser was sent `reload` and reloads the page. The reason names what forced it, for example `examples/hello/src/main.tsx cannot hot-update`, `1 removed` or `index changed`.
- `ok: overlay cleared` means the browser was sent `ok`: the first successful build after a failure changed nothing it needs, so it only clears the error overlay.
- `pushed in <n>ms` follows `update:`, `reload:` or `ok:` only when sending took more than 10 ms after the build finished; normally it is absent.
- `build failed in <n>ms` means the build failed, for example on a syntax error. The browser receives `error` and shows an overlay with Bazel's errors.
- `cannot resolve "<spec>" from <key>; add it to npm_imports of <label>` means a bare import is not in `npm_imports`. `cannot resolve "<spec>" from <key>; not in srcs of <label> or its deps` means a relative or workspace-package import matches no module, for example after its file was deleted or renamed. Every import of the app is checked after each build, so these lines appear right after the `built in` line, and the browser shows an overlay starting `unresolved imports:` with one `  <key>: "<spec>"<hint>` line per import. The overlay stays until a build resolves every import, then `ok: overlay cleared` or the update clears it. A browser that connects while an error stands, for example after a reload, is shown it too.
- `rebuild requested` follows `r` + Enter in the terminal and is followed by one build.
- `watcher error: <message>; rebuilding` means the file watcher reported an error. One build runs, so nothing that changed is missed.
- `waiting for Bazel server (another command holds the lock)` is logged when a build has waited 2 s for another Bazel command in the workspace; the build starts when it finishes.
- `analysis cache discarded: Bazel options changed (another command?); this build is slower` means Bazel was last run with different options, usually by another command in the workspace, so this build re-analyzes. The next build is fast again.
- `dev server: bazel <subcommand> failed (exit <code>)` means a startup step failed, for example a `--bazel-arg` Bazel rejected. Bazel's own message is printed above it.
- `dev server: the running binary was built with different Bazel flags than the nested build will use (...)` means `bazel run` was given flags that change the output path. Put them in `.bazelrc` so the nested build uses them too.

## What hot-updates and what reloads

The browser holds a WebSocket at `/@dev/ws` and receives four messages:

| Message | Sent when | Browser does |
| --- | --- | --- |
| `update` | Every changed module can hot-update. Lists each module's key, digest and kind. | Re-imports each module as `/<key>?v=<digest>`, then runs React Refresh. Clears the overlay. |
| `reload` | Any changed module cannot hot-update, a module was removed, or the npm prebundles or `index.html` changed. | Reloads the page. |
| `ok` | A build succeeds with nothing to send after a failed build, for example when a syntax error is reverted to the last good content. | Clears the overlay. |
| `error` | The build failed, or an import cannot be resolved. | Shows the overlay with Bazel's errors or the unresolved imports. The page keeps running. |

- A module whose exports are all React components hot-updates. Component state survives: in `examples/hello`, a counter at 3 stays at 3 after the `<h1>` text changes.
- A stylesheet, plain or `*.module.css`, hot-updates: the new `.css.js` module replaces its `<style>` element and state survives. The exception is a `*.module.css` whose class map changes, because a class was added, renamed or removed: importers still hold the old map, so the browser logs `[dev] reload: <key>: class names changed` to its console and reloads. A stylesheet the page has not loaded, such as one belonging to a lazy route that is not mounted yet, is skipped rather than injected.
- The entry module and any module that is not a component module reload the page, even for a comment-only edit, because its output changes.
- If a module that was a component module starts exporting something that is not a component, or its exports change shape, the browser reloads after re-importing it and logs `[dev] reload: <key>: <reason>` to its console.

## When things go wrong

- **A file was deleted or renamed.** What happens depends on how the file is listed in `srcs`. A file matched by a `glob`, as in `examples/hello`, simply drops out of the build, which succeeds, and every import of the old name is unresolved: renaming `App.module.css` logs `cannot resolve "./App.module.css" from examples/hello/src/App.tsx; not in srcs of //examples/hello:hello or its deps`, and the overlay lists `examples/hello/src/App.tsx: "./App.module.css"`. A file named explicitly in `srcs`, as in `examples/shared/ui`, makes the build fail with Bazel's `missing input file` error in the overlay. Either way, fix the import or restore the file and the next build clears the overlay. Removing a module reloads the page, so the app may be blank until the import is fixed; if it is still blank after the fix, reload the page.
- **A `BUILD` file changed.** It is in a watched package, so it triggers a build. If the build changes the set of packages, for example a library added to or removed from `deps`, the server logs `watching …` with the new list and watches the new packages' files from then on.
- **Another Bazel command is running** in the same workspace. The build waits for it and logs `waiting for Bazel server …` after 2 s. If that command used different options, the next build logs `analysis cache discarded …` and is slower once.
- **When to restart.** Changes to `MODULE.bazel`, `pnpm-lock.yaml`, `tools/` or `bazel/` are not watched and need a restart: stop the server and run `bazel run` again. Edits to files outside the watched packages trigger no build at all.

## Browser acceptance

Run on `examples/hello` in headless Chromium 157 driven over the DevTools protocol, against `bazel run //examples/hello:hello.dev`. A marker set on `window` after load shows whether the page reloaded.

1. Load and click the button three times: `count is 3`; the `<h1>` has class `_41Zueq_title` and color `rgb(102, 51, 153)`; the button has padding `4px 12px`.
2. Change the `<h1>` text in `App.tsx`: `update: 1 modules`; new text, still `count is 3`, marker kept.
3. Change `.title` to `teal` in `App.module.css`: `update: 1 modules`; color `rgb(0, 128, 128)`, still `count is 3`, marker kept.
4. Add a comment to `main.tsx`, then `console.log("x")`: each logs `reload: examples/hello/src/main.tsx cannot hot-update`; the marker is gone, the counter is back to 0, and the console shows `x`.
5. Break `App.tsx` syntax: `build failed in 142ms` and the overlay appears. Revert to the last good content: `built in 168ms (bazel 168ms): 0 modules changed`, then `ok: overlay cleared`; the overlay goes and the counter is kept. Break it again and fix it with new text: `update: 1 modules`, the overlay goes, the new text shows and the counter is kept.

## Warm save-to-update time

Measured on `examples/hello`, changing the `<h1>` text ten times with the server already running and the page open. `Built in` is from the watcher event to the new manifest (the figure in the `built in` log line); each save was followed by `update: 1 modules` and no `pushed in` line, so the update went out within 10 ms of it. `In the browser` is from the file write to the new text in the DOM, read by polling every 10 ms. The median built-in time is 216 ms; the median in the browser is 292 ms.

| Save | Built in (ms) | Bazel (ms) | In the browser (ms) |
| --- | --- | --- | --- |
| 1 | 211 | 210 | 286 |
| 2 | 270 | 270 | 348 |
| 3 | 151 | 150 | 226 |
| 4 | 221 | 221 | 297 |
| 5 | 151 | 151 | 225 |
| 6 | 296 | 295 | 377 |
| 7 | 204 | 203 | 285 |
| 8 | 230 | 230 | 303 |
| 9 | 263 | 263 | 346 |
| 10 | 206 | 206 | 286 |

The counter stayed at its value through all ten saves.

## Differences from production

- Dev uses React's development build with `NODE_ENV=development`, which Fast Refresh needs. The production bundle uses `NODE_ENV=production`.
- Dev wraps modules with React Refresh registration and serves the `react-refresh` runtime and the dev client. The production bundle has neither.
- Dev puts each stylesheet in its own `<style>` element when its module evaluates, so styles arrive with the JavaScript. Production links one `main.css` from `index.html`.
- The production bundle resolves npm packages directly through esbuild from the same Bazel-built `node_modules`. Dev serves one prebundle per package, with a small re-export shim so CommonJS named exports work.

## Current limits

- SWC strips types without checking them, so a type error does not fail the dev build; run `bazel test :<name>.typecheck`.
- No Svelte.
- Sources other than `.ts`, `.tsx` and `.css`, such as images and fonts, are not handled.
- Linux and macOS only.

See the [design spec](superpowers/specs/2026-11-15-hermetic-dev-server-design.md).
