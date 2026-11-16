# SDD ledger — plan: docs/superpowers/plans/2026-11-15-hermetic-dev-server-foundation.md
Spec: docs/superpowers/specs/2026-11-15-hermetic-dev-server-design.md (read)
Branch: foundation (created from main 5c96af8)

Ruling: work in place on branch `foundation`, no worktree — main holds only docs, nothing to protect, and a worktree would double Bazel's output base — costs nothing if wrong beyond a branch switch.

## Pre-flight scan
| Pair / task | Produces vs consumes | Finding |
|---|---|---|
| T1→T2 | node_modules targets for @swc/core, es-module-lexer | agree |
| T1→T3 | `bazel_skylib` needed for bool_flag; T3 says add if missing | agree, T3 implementer adds to MODULE.bazel |
| T2→T3 | worker CLI `--src --out --meta --dev --tsconfig`, `@argsfile`, JSON worker protocol | agree with transform.bzl args |
| T3→T4 | ModulesInfo struct(src,out,meta); manifest uses out.path/meta.path/src.short_path | agree |
| T3/T4→T7 | dev_config forwards target's DefaultInfo.files; T7 needs a single file for $(execpath) | app_manifest must return DefaultInfo(files=[json]) only, and dev_config must forward the json as files with everything else as runfiles. Ruling: app_manifest DefaultInfo.files is exactly the manifest json; dev_config DefaultInfo(files = target files, runfiles = target runfiles + files). Carry into T4 and T7 dispatches. |
| T4→T5 | npm_dir label + npm_entries dict; T5 passes select() for npm_dir | agree; entries identical for both flavours |
| T5→T7 | `<name>.dev` js_binary args with $(execpath :name.manifest.dev) | agree |
| T6→T7 | driver.manifest property, events built/failed/waiting/building; builder target `<name>.manifest.dev` | agree |
| T1 self | `bazel run -- @pnpm//:pnpm` needs the rules_js `pnpm` extension in MODULE.bazel | note for T1 implementer |
| T2 self | js_test data source files copied to bin (rules_js copy_data_to_bin default) | agree |
| T3 self | outputs under `<name>.modules/<short_path>.js`; step 5 ls path matches | agree |
| T6 self | watcher test drives chokidar's `all` event; watcher must subscribe to `all` | agree |
| T7 self | server test uses Node 22 global fetch and `ws` | agree |
| Global | plan said "commit on main"; branch is `foundation` | Ruling: commits go on `foundation`; merge is the finishing step — no cost |

## Progress
Task 1: implementer DONE_WITH_CONCERNS at 89a4bb5 — esbuild toolchain pinned 0.27.0 (rules_esbuild 0.25.1 vendors no 0.25.1 hash); rules_js "dependency checking of directories is unsound" warnings on @swc/core platform packages; MODULE.bazel.lock committed. Versions: rules_js 2.9.3, rules_esbuild 0.25.1, bazel_lib 2.22.5, rules_nodejs 6.7.7 / Node 22.21.1, skylib 1.8.2.
Task 1: minor (deferred): rules_js unsound-directory warnings on @swc/core platform packages — noise in every build; consider the rules_js fix (lifecycle/`.d` handling) in hardening.
Task 1: minor (deferred): no pnpm version pin (package.json packageManager / MODULE pnpm.pnpm) — pin in hardening.
Task 1: complete (commits 5c96af8..89a4bb5, review clean)
Task 2: implementer DONE_WITH_CONCERNS at 3a69c4b — added jsc.transform.verbatimModuleSyntax=true (SWC otherwise drops unused imports); running the js_binary from ctx.actions.run needs env BAZEL_BINDIR.
Ruling: root tsconfig.json gains `verbatimModuleSyntax: true` and the worker derives SWC's setting from it, so tsc and SWC agree on import elision (spec: tsconfig is the source of truth) — carried into Task 3 dispatch — cost if wrong: type-only imports must be written `import type`, which isolatedModules already pushes toward.
Ruling: Task 3's worker action sets env BAZEL_BINDIR = ctx.bin_dir.path (rules_js launcher requirement) — carried into Task 3 dispatch — no cost if wrong beyond a build error.
Task 2: review at 3a69c4b: Needs fixes — 4 Important (hardcoded verbatimModuleSyntax; no worker-protocol tests; tsconfig cache stale in persistent mode [plan-mandated "once per process"]; dynamic imports counted as static).
Ruling: tsconfig cache finding stands against the plan text — Bazel does not restart a worker when an input changes, so "read once per process" is a real staleness bug; the worker re-reads the tsconfig on every request (it is tiny) — cost if wrong: microseconds per action.
Ruling: fix the verbatimModuleSyntax finding in this task by adding `verbatimModuleSyntax: true` to root tsconfig.json and deriving it (supersedes the "carry into Task 3" note above).
Task 2: minor (deferred): JSONC tsconfig unsupported; `--dev` accepts only exact "true"; CRLF argsfile; `--k=v` flag form; test file lacks @ts-check; missing edge-case tests (empty file, re-export, dev .ts, known digest).
Task 2: fix round 1/5 (4 addressed, 0 open; commits 3a69c4b..4326316). Root BUILD gained js_library tsconfig_json (rules_js needs it for cross-package data).
Task 2: minor (deferred): worker_test tmpdir not cleaned up; exports_files(tsconfig.json) now redundant beside js_library tsconfig_json.
Task 2: complete (commits 89a4bb5..4326316, review clean)
Task 3: implementer DONE_WITH_CONCERNS at cc1cf9b — action env also sets JS_BINARY__NO_CD_BINDIR=1 (launcher otherwise cds to bindir and breaks execroot-relative paths); glob needs allow_empty; allowlist attr not needed on Bazel 8.
Task 3: minor (deferred): .d.ts files get a transform action; foo.ts+foo.tsx stem collision and external-repo `../` short_paths fail with unclear errors; no doc= strings on rules; `_dev` lacks providers=[BuildSettingInfo]; packages merge loop duplicated in js_library.bzl and transform.bzl; BAZEL_BINDIR in env splits worker pools per configuration; dev_config forwards only DefaultInfo.
Task 3: complete (commits 4326316..cc1cf9b, review clean)
Task 4: implementer DONE at 27a2ac7
Task 4: minor (deferred): CLI does not validate required single flags; meta read errors don't name the module; no CLI/arg-parsing tests (splitEq, expandArgs); `dir` shadows builtin in manifest.bzl; no doc= strings; test file lacks @ts-check.
Task 4: complete (commits cc1cf9b..27a2ac7, review clean)
Task 5: implementer DONE_WITH_CONCERNS at e372df0 — dev modules import react/jsx-dev-runtime which npm_imports lacks; prebundle config discovers CJS named exports by require()ing the package in Node at build time; esbuild plugin sets {in,out} entry points because rules_esbuild ignores entryPoints in config; hello.bundle is a genrule over hello.bundle.esbuild.
Task 5: review at e372df0: Needs fixes — 1 Important (dev prebundle lacks react/jsx-dev-runtime; macro must add it).
Ruling: prod bundle resolves npm_deps directly instead of consuming the `.npm` prebundle (plan text mandates `deps = npm_deps`; spec says "same prebundle actions") — accepted for this plan: both resolve the same Bazel-built node_modules through esbuild, and the dev shim only re-exports names; Task 8's guide must document it as a known dev/prod difference alongside the React development build — cost if wrong: a CJS-interop edge case that differs between dev and prod, caught by the hardening plan.
Ruling: no manifest-time validation that every bare import has an npm entry; Task 7's server logs unresolved specifiers per the plan's Review Focus — cost if wrong: a missing npm_import is found at page load instead of build time.
Task 5: minor (deferred): export-name discovery requires() with Node conditions, may differ from esbuild's browser resolution for dual packages (fix: resolve via build.resolve in onLoad; per-specifier override); identifier filter admits reserved words; entry-point override needs a comment that output_dir=True is required; bundle genrule copies only main.js/main.js.map (CSS/assets would be dropped) and escapes only `.` in sed; macro computes the transform output path itself (root package yields "//", no-extension entry fails) — expose via output group; npm.bzl computes entry mapping twice.
Task 5: fix round 1/5 (1 addressed, 0 open; commits e372df0..7ac1ae2)
Task 5: complete (commits 27a2ac7..7ac1ae2, review clean). Note: browser check of hello.bundle deferred to the Task 7 end-to-end step.
Ruling: createDriver takes no executionRoot (brief lists it; only the web server needs it) — carried into Task 6 and 7 dispatches — no cost.
Task 6: implementer DONE_WITH_CONCERNS at 0bf73b4 — driver.js untested (brief specifies none); watchToBuild includes queue time; manifest load failure after a good build emits failed.
Task 6: review at 0bf73b4: Needs fixes — Critical: chokidar 4 ignores glob strings and follows bazel-* symlinks (endless rebuild loop); Important: builder can overlap two builds; driver runs one cycle per change (duplicate events, manifest read races next build); driver untested with no seams.
Ruling: the brief's glob-string `ignored` default assumed chokidar 3; keep the `ignored: string[]` parameter but implement it as a function matcher with `followSymlinks: false`, and add a real-chokidar temp-dir test — cost if wrong: none beyond the rework.
Ruling: the sync-spawn-throw unhandled rejection (reviewer Minor 2) is promoted into this fix round because it violates the "server never exits on a build failure" constraint.
Task 6: minor (deferred): builder resolves on `exit` and may miss the last stderr lines (prefer `close`); subscriber exceptions in driver misreported/unhandled; stop() leaves an in-flight child and timer; start() twice makes two watchers; allText unbounded; loose JSDoc Function types; watchToBuild derived not measured; test gaps (negative onWaiting, promise identity, process.env not restored [plan-mandated test code]).
Task 6: fix round 1/5 (5 addressed, 0 open; commits 0bf73b4..50325f5)
Task 6: minor (deferred): real-chokidar test uses a fixed 500ms ready sleep (expose a ready promise); glob-to-regex for `**/bazel-*/**` also ignores plain files named bazel-* (e.g. src/bazel-utils.ts); a throwing built/failed listener is an unhandled rejection that drops a dirty change.
Task 6: complete (commits 7ac1ae2..50325f5, review clean)
Task 7: implementer DONE_WITH_CONCERNS at 4ee0cc1 — headless e2e: built in 260/176/249ms; deviations: entry_point via copy_to_bin label; server caches last good module output in memory (bazel deletes outputs on failed build); reload sent on first success after failure even with 0 changes; client defines empty $RefreshReg$/$RefreshSig$; brief's type-error check doesn't fail SWC (use a syntax error); error text includes Bazel progress lines; browser check still pending.
Task 7: controller browser check (headless chromium): page renders 'Hello from Bazel' with the counter button, only console message is React DevTools hint, served from Bazel outputs.
Task 7: review at 4ee0cc1: Approved, 0 Important.
Ruling: the server's `reload` on the first successful build after a failure, even with 0 modules changed, stands for this plan (it is what clears the overlay after a reverted edit); the next plan's HMR messaging adds a distinct clear-overlay message instead — cost if wrong: one unnecessary full reload after a build failure is fixed.
Task 7: minor (deferred): "add it to npm_imports" hint logged for unresolved relative imports too; ETag unquoted (plan-mandated test) and computed pre-rewrite; index.html not in the last-good cache; a browser connecting during a failure gets no overlay; malformed percent-encoding yields 500 not 400; server listens on all interfaces (bind localhost); renderIndex regex narrow; rewrite re-parsed per request (cache by digest); test gaps (traversal, /npm success, dynamic import rewrite, fixture cleanup, server close on assert failure, 50ms sleeps); main.js bare stack traces; driver error string includes Bazel Loading/Analyzing lines.
Task 7: complete (commits 50325f5..4ee0cc1, review clean)
Task 8: implementer DONE at bb5c76c — median save-to-reload 187ms (10 runs: 133..306ms); docs claims partly from controller fact list, not re-verified.
Task 8: minor (deferred): guide omits internal helper targets and the "no reload when output unchanged" nuance.
Task 8: complete (commits 4ee0cc1..bb5c76c, review clean)
Final review at bb5c76c: With fixes — 7 Important: (1) digest hashes source not output (stale code after tsconfig/SWC change); (2) diff ignores npm/index changes so no reload; (3) listens on all interfaces, no Origin check; (4) nested bazel drops outer CLI options silently; (5) `waiting` never logged; (6) dev/prod resolution differs (.js-suffix imports; no esbuild aliases for package_name); (7) builder resolves on exit, may truncate stderr.
Ruling: finding 6's package-name alias half is a plan gap (the spec requires esbuild aliases from the provider; no task assigned them) — deferred to the next plan as its first task; the `.js`-suffix candidate half is fixed now — cost if wrong: a prod bundle using `package_name` imports fails until the next plan lands, and the example does not use them.
Ruling: finding 4 is fixed as the minimal startup mismatch check (cquery the nested target's manifest path and exit with a clear message if it differs from --manifest); flag forwarding waits for hardening — cost if wrong: users must put build flags in .bazelrc.
Ruling: the plan's Review Focus "comment edit" example is wrong (SWC keeps comments); the fix wave corrects the plan text to "a type-only edit" and the docs' metric label to build-cycle time.
Final review: deferred minors triage accepted as the reviewer listed; T7 all-interfaces and T6 exit-vs-close promoted into the fix wave.
Final fix wave: DONE_WITH_CONCERNS at 31f31c4 (6 commits; fix-wave commits carry an Opus 5.5 trailer since that model ran them; finding 4 verified by hand only).
Final fix wave re-review at 31f31c4: all 8 addressed, no new Critical/Important.
Final: minor (deferred): doc says build-cycle time ends at the reload message but `built in` ends at manifest load; dirDigest skips symlinked files (use !isDirectory or stat); startup cquery failure prints a stack trace; server binds 127.0.0.1 while the log says localhost (IPv6-only resolvers).
Final review: clean after one fix wave.
