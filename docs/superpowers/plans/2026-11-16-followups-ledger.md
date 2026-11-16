# SDD ledger — plan: docs/superpowers/plans/2026-11-16-fast-refresh-css-typecheck.md
Spec: docs/superpowers/specs/2026-11-15-hermetic-dev-server-design.md (read)
Branch: followups (created from main 9456281)

Ruling: work in place on branch `followups`, no worktree — same reason as the foundation (a worktree doubles Bazel's output base) — costs nothing beyond a branch switch.

## Pre-flight scan
| Pair / task | Produces vs consumes | Finding |
|---|---|---|
| T1→T3 | bundle config plugin `onResolve` for package names; T3 adds `.css` → `.css.js` resolution in the same template | agree; T3 reuses the package-prefix lookup |
| T1→T5 | `JsSourceInfo.packages` roots; T5 generates tsconfig `paths` from the same map | agree |
| T2→T3 | worker gains `--key`; T3 adds `--css-out` and handler dispatch | agree; T3 keeps `--key` required for css too |
| T2→T4 | wrapper calls `window.__devRefresh.{register,createSignatureFunctionForTransform,registerModule}`; T4 client defines exactly those | agree |
| T2→T4 | manifest v2 `kind`; T4 `decide` reads `manifest.modules[key].refresh` and `.kind` | agree |
| T3→T4 | css module `refresh: true, kind: "css"`; T4 update re-imports css keys with `?v=digest` | agree; server key route serves `.css.js` content as text/javascript (existing route) |
| T3→T6 | `.module.css` exports map; T6 example uses `styles.title` | agree |
| T4→T6 | log lines `update:`/`reload:`; T6 waits on `update:` | agree |
| T5→T6 | `typecheck_deps`, css.d.ts; T6 example imports css in TS | agree (T5 adds css.d.ts before T6 needs it) |
| T1 self | test asserts `renderBundleIndex` throws on missing entry; CLI copies esbuild dir | agree |
| T2 self | test regex matches `window.__devRefresh.register(type, "<key> " + id)`; Step 3 line contains that text | agree (fixed before execution) |
| T3 self | prod css module `import "./a.css"` and `imports: ["./a.css"]` | agree |
| T4 self | `decide(e, failed)` signature matches tests | agree (fixed before execution) |
| T4 self | server test expects `["error","ok","update","reload"]`; fixture gives App.tsx refresh true, main.tsx false | agree |
| T5 self | `bin.tsc_test` from `@npm//:typescript/package_json.bzl`; `$(rootpath)` cwd question left to implementer with a comment | agree |
| Global | spec says toolchain + preprocessor hook; plan defers both to the Svelte plan | Ruling: accepted as written in the plan's "Deferred" section — a hook with one implementation is untested API — cost if wrong: a later refactor to a toolchain touches transform.bzl and worker.js only. |

## Progress
Task 1: dispatched (sonnet) at BASE 9456281
Task 1: implementer DONE at 6a168ce — write_bundle copies file by file (cpSync left symlinks into the execroot); process.cwd() in the esbuild config is the bin dir.
Task 1: review at 6a168ce: Approved, 0 Important. Controller verified hello.bundle builds (index.html, main.js, main.js.map; Hello/ui-button present); hasCss path verified by Task 3.
Task 1: minor (deferred): package-prefix match in the bundle config is first-match not longest-prefix; write_bundle.test.js lacks @ts-check and no CLI/temp-dir test; BUILD attr order cosmetic.
Task 1: complete (commits 9456281..6a168ce, review clean)
Task 2: dispatched (sonnet) at BASE 6a168ce
Task 2: implementer DONE at b8c513c
Task 2: review at b8c513c: Approved, 0 Important. Controller verified manifest.dev has version 2 and kind on every module; consumers of kind are Task 4.
Task 2: minor (deferred): no test executes the no-__devRefresh fallback; no missing --key worker test; wrapper tail does not restore globals if the SWC body throws (plan-mandated shape).
Task 2: complete (commits 6a168ce..b8c513c, review clean)
Task 3: dispatched (sonnet) at BASE b8c513c
Task 3: implementer DONE_WITH_CONCERNS at 63bed5f — brief's css syntax-error input did not throw in Lightning CSS (test input changed to `.a {{ color: red }`); Lightning normalises rebeccapurple to #639; pnpm lockfile refresh needs `--dir $PWD`; lightningcss 1.33.0.
Ruling: the test-input change stands (the brief's input is valid CSS to Lightning) — no cost.
Task 3: review at 63bed5f: Needs fixes — 2 Important: (1) composes silently dropped [plan-mandated "ignore composes"]; (2) prod .css onResolve too broad (bare npm css specifiers; CSS @import/url kinds).
Ruling: finding 1 stands against the brief — the exported class string joins `entry.name` with the composed classes' names, in both configurations — cost if wrong: none (plain `name` is the no-composes case).
Task 3: minor (deferred): dev style selector unescaped key; no unit test for handlerFor unknown-extension throw or .module.css through the worker; worker reads source before dispatching; package.json ordering.
Task 3: fix round 1/5 (2 addressed, 0 open; commits 63bed5f..4524bcf). Controller ran bazel test //... after the fix: 12/12 pass.
Task 3: complete (commits b8c513c..4524bcf, review clean)
Task 4: dispatched (opus) at BASE 4524bcf
Task 4: implementer DONE_WITH_CONCERNS at 8abe05b — commit carries an Opus 5.5 trailer (that model ran it; accepted as in the foundation); fixture imports ./Missing to keep unresolved-import tests meaningful; "first build after failure" test now expects ok; browser state-survival and css swap unverified until Task 6.
Task 4: review at 8abe05b: Approved, 0 Important. Browser state-survival, css swap and client-before-entry ordering are Task 6's acceptance step.
Task 4: minor (deferred): css update injects a stylesheet the page never loaded (plan-mandated; add a css registry); registerModule import() lacks .catch; queued updates continue after reload is triggered; performReactRefresh timer has no try/catch; pre-existing: a rejected holdOutputs leaves the server's events chain rejected and silently skips later broadcasts (server.js ~545).
Task 4: complete (commits 4524bcf..8abe05b, review clean)
Task 5: dispatched (sonnet) at BASE 8abe05b
Task 5: implementer DONE at c290888 — sources and css.d.ts carried as runfiles of the tsconfig rule (rules_js refused cross-package source copies in data); $(rootpath) held, no chdir.
Task 5: review at c290888: Approved, 0 Important. Controller re-ran hello.typecheck uncached.
Task 5: minor (deferred): external-repo short_paths (../repo/...) mis-resolved in typecheck.bzl; css_types label in data redundant with tsconfig runfiles; .mts/.cts not in files filter.
Task 5: complete (commits 8abe05b..c290888, review clean)
Task 6: dispatched (opus) at BASE c290888
Task 6: implementer DONE_WITH_CONCERNS at 35dfb3b — all five browser checks pass in dev (state survives component and css edits); median built-in 216 ms, write-to-DOM 291.5 ms; prod bundle re-hashes *.module.css classes (esbuild local-css loader on top of Lightning's hash) so main.css and main.js disagree — Task 3 defect surfaced by the Step 1 check; docs list it as a known limit for now.
Ruling: the prod class-name mismatch violates the global constraint "esbuild never hashes class names" and is promoted into Task 6 fix round 1, dispatched to the Task 3 implementer who owns esbuild_bundle.config.mjs.tpl, with the docs bullet removed in the same round — cost if wrong: none; a loader override is the smallest change.
Task 6: minor (deferred): navigation entries cannot detect a reload (test used a window marker); server does not log the `ok` message; overlay text starts with Bazel progress lines (foundation minor, still open).
Task 6: fix round 1/5 (1 addressed by Task 3 implementer: .module.css loader forced to css, config_test added, docs bullet removed; commits 35dfb3b..4c22ebb). Task review dispatched over the whole range c290888..4c22ebb.
Controller verified after fix: main.css class _41Zueq_title found once in main.js; bundle has main.css(.map) and index links it.
Task 6: review at 4c22ebb (range c290888..4c22ebb): Approved, 0 Important. ⚠️ bundle class-name match verified by controller (above); ok/reload strings verified by implementer against hmr.js/server.js.
Task 6: minor (deferred): config.test.js lacks @ts-check and leaves its temp dir; config test checks the options object not a real .module.css bundle; "Current limits" keeps typecheck and Linux/macOS lines; docs "Browser acceptance" run-log may go stale.
Task 6: complete (commits c290888..4c22ebb, review clean)
Final review: dispatched (opus) over 9456281..4c22ebb
Final review at 4c22ebb: With fixes — 4 Important: (1) css-module hot update leaves importers with a stale class map (reload when the map changes); (2) css update injects a stylesheet the page never loaded; (3) `ok` decision not logged (Global Constraint; plan gap); (4) npm stylesheet imports work in prod, fail in dev — fail early in npm_prebundle for .css specifiers and document the limit.
Ruling: all four fixed in one wave; the reviewer's optional recommendation (pass --key as the Lightning CSS filename so hashes are config-independent) is included because it bears on dev/prod agreement — cost if wrong: a one-token change.
Ruling: finding 3 is a plan gap (Task 4 Step 5 listed only update/reload logs); the Global Constraint wins — no cost.
Final review: deferred-minor triage accepted as listed (Task 4 css-registry and Task 6 ok-logging promoted; rest wait for plan 3).
Final fix wave: dispatched (opus) at FIX_BASE 4c22ebb
Final fix wave: DONE_WITH_CONCERNS at cdba1f7 (client changes not browser-tested; Lightning errors now name the key).
