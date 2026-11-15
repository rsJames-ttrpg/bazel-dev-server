# Using the dev server

## Declaring an app

Load `react_app` from `//bazel/js:react_app.bzl` in your package's `BUILD.bazel`. See `examples/hello/BUILD.bazel` for a complete example.

| Attribute | Meaning |
| --- | --- |
| `name` | Application name, the prefix of every target. |
| `srcs` | The app's `.ts` and `.tsx` sources. |
| `entry` | Package-relative path of the entry source, for example `src/main.tsx`. |
| `index_html` | The app's `index.html`. |
| `npm_imports` | Bare specifiers the app imports from npm, for example `react` and `react-dom/client`. |
| `npm_deps` | Linked npm package targets that provide `npm_imports`, for example `//:node_modules/react`. |
| `deps` | `js_library` targets the app depends on. Default is none. |
| `port` | Dev server port of `<name>.dev`. Default is 5173. |

If `react/jsx-runtime` is in `npm_imports`, the macro adds `react/jsx-dev-runtime` for you.

The macro declares `<name>.src`, `.modules`, `.npm`, `.npm.dev`, `.manifest`, `.manifest.dev`, `.bundle` and `.dev`. The root `tsconfig.json` is the single source of truth for `jsx`, `target`, `useDefineForClassFields` and `verbatimModuleSyntax`. Because `verbatimModuleSyntax` is on, type-only imports must be written `import type`.

## Running it

```
bazel run //examples/hello:hello.dev
```

Replace the label with your own `<name>.dev`. The dev configuration is reached only through a rule transition, never a command-line flag. Build the production bundle with `bazel build //path:<name>.bundle`.

## What the terminal prints

- `dev server at http://localhost:5173` means the server is ready.
- `built in <n>ms (bazel <m>ms): <k> modules changed` means a save triggered one nested `bazel build` of `<name>.manifest.dev`. `n` is the total time, `m` the time spent in Bazel, `k` the number of modules whose output changed. The browser then receives `reload` over the WebSocket at `/@dev/ws`.
- `build failed in <n>ms` means the build failed, for example on a syntax error. The browser receives `error` and shows an overlay.
- `cannot resolve "<spec>" from <key>; add it to npm_imports of <label>` is logged once for a bare import that is not in `npm_imports`. The import is served untouched, so it fails in the browser.

## Warm save-to-reload latency

Measured on `examples/hello`, alternating the `<h1>` text ten times with the server already running. The median is 187 ms.

| Save | Built in (ms) | Bazel (ms) |
| --- | --- | --- |
| 1 | 306 | 306 |
| 2 | 179 | 179 |
| 3 | 190 | 190 |
| 4 | 173 | 173 |
| 5 | 170 | 169 |
| 6 | 133 | 133 |
| 7 | 233 | 233 |
| 8 | 184 | 184 |
| 9 | 234 | 234 |
| 10 | 250 | 249 |

This is the time to finish the build; the browser reload follows immediately.

## Differences from production

- Dev uses React's development build with `NODE_ENV=development`, which Fast Refresh will need. The production bundle uses `NODE_ENV=production`.
- The production bundle resolves npm packages directly through esbuild from the same Bazel-built `node_modules`. Dev serves one prebundle per package, with a small re-export shim so CommonJS named exports work.

## Current limits

- SWC strips types without checking them, so a type error does not fail the dev build. A syntax error does. There is no `<name>.typecheck` target yet.
- No CSS handling.
- Full page reload only; no Fast Refresh.
- No Svelte.
- Linux and macOS only.

These are the subject of the next plan. See the [design spec](superpowers/specs/2026-11-15-hermetic-dev-server-design.md).
