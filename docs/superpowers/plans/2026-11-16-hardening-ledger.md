# SDD ledger — plan: docs/superpowers/plans/2026-11-16-hardening.md
Spec: docs/superpowers/specs/2026-11-15-hermetic-dev-server-design.md (read)
Branch: hardening (created from main d8f8060; plan commit 1fb1c58)

Ruling: work in place on branch `hardening`, no worktree — a worktree doubles Bazel's output base (same as both earlier plans) — costs nothing beyond a branch switch.
Ruling: chokidar stays (spec names @parcel/watcher; foundation ruled chokidar) — recorded in Global Constraints — cost if wrong: none now.

## Pre-flight scan
| Pair / task | Produces vs consumes | Finding |
|---|---|---|
| T1→T2 | manifest `watch: {roots, files}` workspace-relative, "" = root; T2 `createWatcher({root, roots, files})` with "" meaning root | agree |
| T1→T3 | T3 driver reads `manifest.watch` and compares by JSON.stringify; T1 sorts both lists so equality is stable | agree |
| T2→T3 | `on("error")`, `update({roots, files})`; T3 driver subscribes/calls exactly those | agree |
| T3→T5 | T5 adds `bazelArgs` to createBuilder/createDriver after T3 added `onAnalysisDiscarded`; both are additive options | agree |
| T3→T8 | log lines `watching …`, `watcher error: …; rebuilding`, `rebuild requested`, `analysis cache discarded …`; T8 docs list them | agree |
| T4→T8 | overlay text `unresolved imports:\n  <key>: "<spec>"<hint>`; T8 acceptance step 1 expects `examples/shared/ui/index.ts: "./Button"` | agree |
| T6→T7 | T6 sorts packages longest-first in the bundle template; T7 relies on the template's `.css` onResolve leaving bare specifiers to esbuild (untouched) | agree |
| T7 | `npm_entry_name("normalize.css")` = `normalize.css` → output `normalize.css.js`; rewrite maps entries["normalize.css"] → /npm/normalize.css.js; server /npm/ route serves .js as text/javascript | agree |
| T1 self | test passes `watch` with a duplicate root and expects unique sorted output; `base` fixture named but defined in the existing test file (implementer confirms the name) | agree, implementer may adapt the fixture name |
| T2 self | `DEFAULT_IGNORED` lists `bazel-*` at root only; real-chokidar test expects `src/bazel-utils.ts` reported | agree |
| T3 self | driver test "requestBuild coalesces" expects exactly 2 builds with a delayed first build | agree (fixed before execution) |
| T4 self | server fixture main.tsx imports ["./App","./Missing"]; expected hint for relative spec `; not in srcs of //app:app or its deps` | agree |
| T5 self | mismatch check reuses forwarded flags in cquery | agree |
| T6 self | config.test.js stubs `build.resolve` to return its first argument | agree |
| Global | spec: "watcher over the app's source roots and BUILD files" — BUILD files live inside the roots; tsconfig.json watched as a file | agree |

Scan clean. Model plan: T1 sonnet, T2 sonnet, T3 opus (driver/builder coordination), T4 sonnet, T5 sonnet, T6 sonnet, T7 opus (esbuild plugin + lockfile), T8 opus (browser acceptance); reviewers sonnet except T3/T7 opus; final review opus.

## Progress
Task 1: dispatched (sonnet) at BASE 1fb1c58
Task 1: implementer DONE at 74f427d (watchBase fixture added; tsconfig passed as path only, not an input)
Task 1: review at 74f427d: Approved, 0 Important.
Task 1: minor (deferred): no test of --watch-root/--watch-file parsing in main; external-repo src package would land in roots (Task 6 fails on external sources); duplicated comparators in write_manifest.js.
Task 1: complete (commits 1fb1c58..74f427d, review clean)
Task 2: dispatched (sonnet) at BASE 74f427d
Task 2: implementer DONE at 2b8e810 — the "plain file named bazel-*" test uses roots [""] rather than the brief's ["src"].
Ruling: the deviation stands — with roots ["src"] the bazel-out and node_modules files are outside the watched set and the ignore patterns go unexercised; the brief's test was wrong — no cost.
Task 2: review at 2b8e810: Approved, 0 Important.
Task 2: minor (deferred): update after close not guarded; unwatch of a parent root may drop a nested watched file (chokidar prefix semantics unverified); ignore patterns are root-relative so nested bazel-* dirs under a non-root root are not ignored (by design); no real-chokidar test of update; fs_ naming.
Task 2: complete (commits 74f427d..2b8e810, review clean)
Task 3: dispatched (opus) at BASE 2b8e810
Task 3: implementer DONE_WITH_CONCERNS at 31da1f3 — commit carries an Opus 5.5 trailer (that model ran it; accepted as in earlier plans); progress-line filter runs after the 60-line tail cut; a burst of watcher errors logs one line each (builds still coalesce).
Ruling: filter-after-tail is a minor (tail of 60 rarely contains 60 progress lines after an action error); reviewer may promote it — cost if wrong: an overlay missing early lines of a long error.
Task 3: review at 31da1f3: Approved, 0 Important.
Ruling: reviewer minors 1 (filter progress lines in pushLine so the 60-line tail is all useful) and 2 (a throwing watcher.update is misreported as "could not load manifest" and never retried) are carried into Task 5's dispatch, which edits builder.js and driver.js anyway — cost if wrong: none.
Task 3: minor (deferred): stdin read from a backgrounded `bazel run … &` can raise SIGTTIN (document); watcher error bursts log one line each.
Task 3: complete (commits 2b8e810..31da1f3, review clean)
Task 4: dispatched (sonnet) at BASE 31da1f3
Task 4: implementer DONE_WITH_CONCERNS at a613b5b — tests written alongside code (no RED run); four sequence tests now use a resolvable fixture; new test sees the replayed startup error first; while an unresolved import persists every no-change build sends ok then error (overlay flicker).
Ruling: the ok-then-error flicker is a plan gap (decide's `failed` flag conflates "overlay showing" with "last build failed"); reviewer asked to grade it; if Important, fix round: when nothing changed and the error text is unchanged, send nothing — cost if wrong: one redundant pair of messages per idle build.
Task 4: review at a613b5b: Needs fixes — 1 Important: idle rebuild with a persisting unresolved import sends ok then error (overlay blinks, scroll lost, false "ok: overlay cleared" log). Plan gap; ruling above applies.
Task 4: minor (deferred): per-build unresolved log repeats on every idle build plus the per-request line (plan-mandated); lastError assigned before `if (!msg) return` (no realistic path); resolvable() mutates the fixture.
Task 4: fix round 1/5 dispatched (resume implementer) at FIX_BASE a613b5b
Task 4: fix round 1 DONE at bd52884; re-review dispatched (sonnet)
Task 4: fix round 1/5 re-review: 1 addressed, 0 open, no new breakage (commits a613b5b..bd52884).
Task 4: complete (commits 31da1f3..bd52884, review clean after one fix round)
Task 5: dispatched (sonnet) at BASE bd52884 — carries Task 3 minors 1 and 2 (filter progress lines in pushLine; guard a throwing watcher.update).
Task 5: implementer DONE_WITH_CONCERNS at 7d3f4cb (one commit incl. both Task 3 carried fixes) — ready line now 127.0.0.1; bazel-failed message read-verified only; --bazel-arg also reaches `bazel info` (must be command options, not startup options).
Ruling: forwarding to `bazel info` stands — `info` accepts build options, and a flag that changes the output base would need to be a startup option the user passes before `run` anyway; Task 8 docs say "command options only" — no cost.
Task 5: review at 7d3f4cb: Approved, 0 Important.
Task 5: minor (deferred): ENOENT/signal startup failure prints "(exit unknown)" with no hint that bazel is missing; malformed --bazel-arg makes parseArgs throw with a stack trace (pre-existing for all flags); no driver-level forwarding test.
Task 5: complete (commits bd52884..7d3f4cb, review clean)
Task 6: dispatched (sonnet) at BASE 7d3f4cb
Task 6: implementer DONE at 317276c — external-repo fail() not exercised by hand (no external source exists); stem-collision message verified.
Task 6: review at 317276c: Approved, 0 Important.
Task 6: minor (deferred): package sort runs per resolve call rather than once (hoist to a module constant in the template; per-call array in rewrite.js); config test's `bare ?? last` fallback should assert `bare` is defined.
Task 6: complete (commits 7d3f4cb..317276c, review clean)
Task 7: dispatched (opus) at BASE 317276c
Task 7: implementer DONE_WITH_CONCERNS at 6c462dd — brief's `html{line-height:1.15` check assumed minified CSS (bundle CSS is unminified; rule present once); Opus 5.5 trailer (accepted); jsx-dev-runtime import precedes the normalize import in rewritten main.tsx.
Ruling: the unminified-CSS check mismatch is a plan-text error, verified equivalent by the implementer — no cost. Bundle CSS minification is not in scope (prod bundle minification was never specified).
Task 7: review at 6c462dd: Approved, 0 Important.
Task 7: minor (deferred): no automated test of the css entry source; a JS package whose name ends in .css would be misrouted (document); the prebundle text loader turns a bundled package's internal css import into an unused string (was an unserved sibling file; no regression).
Task 7: complete (commits 317276c..6c462dd, review clean)
Task 8: dispatched (opus) at BASE 6c462dd
Task 8: implementer DONE_WITH_CONCERNS at c422b57 (pnpm 8.15.9 pinned; MODULE.bazel.lock included; Opus trailer accepted) — acceptance: step 1 gave a Bazel "missing input file" overlay because examples/shared/ui lists srcs explicitly (plan-text error; behaviour correct); step 2 showed the unresolved-imports overlay but after the fix the page stayed blank until a manual reload; step 3/4/6 pass (median built in 158 ms); step 5 skipped (no TTY).
Ruling: step 1 stands as observed (explicit srcs → Bazel error overlay; glob srcs → unresolved-imports overlay); docs describe both — no cost.
Ruling: blank page after a fixed rename is Important (spec milestone 5 covers renames): an `update` arriving while the overlay is showing, for modules this page never registered, must reload — pure helper in refresh.js with a unit test; client uses it. Fix round 1 for Task 8 — cost if wrong: one extra full reload after fixing an error.
Ruling: edits under a removed root still building is Important (the re-root is the whole point of Task 1–3): the watcher drops events whose path is not under the current watched set, independent of chokidar's unwatch semantics; fake-emitter test. Same fix round — cost if wrong: none.
Task 8: fix round 1/5 dispatched (resume implementer) at FIX_BASE c422b57
Task 8: fix round 1 DONE at 864ae5a (both fixes browser-verified); task review dispatched (opus) over 6c462dd..864ae5a
Task 8: review at 864ae5a (range 6c462dd..864ae5a): both fix-round findings ADDRESSED; Needs fixes — 1 Important: restoring a deleted glob-matched file yields `ok` (importer output unchanged), client only hides the overlay, page stays blank.
Ruling: the reload predicate becomes "overlay showing and this page registered no module" (`registeredKeys.size === 0`) and applies to both `update` and `ok`; this also removes reviewer minor 2 (css-only fix reloading a mounted page) — cost if wrong: a page with no component modules reloads after a fix, which it would have anyway.
Task 8: minor (deferred): duplicate `cannot resolve` lines per build (Task 4 plan-mandated); buffered events for a removed root go out once.
Task 8: fix round 2/5 dispatched (resume implementer) at FIX_BASE 864ae5a — carries minors 3 (README overlay claim), 4 (`; roots unchanged` log line in docs), 5 (watched-file/root isWatched test).
Task 8: fix round 2 DONE at 8ea14e1 (browser-verified: delete/restore glob file recovers; mounted page css hot-swap and ok keep state); re-review dispatched (sonnet)
Task 8: fix round 2/5 re-review: 4 addressed, 0 open, no new breakage (commits 864ae5a..8ea14e1).
Task 8: minor (deferred): an `ok` arriving before the first registerModule import() completes would reload once, spuriously.
Task 8: complete (commits 6c462dd..8ea14e1, review clean after two fix rounds)
Final review: dispatched (opus) over 1fb1c58..8ea14e1
Final review at 8ea14e1: With fixes — 3 Important: (1) watch set follows only successful builds, so a new dep whose first build fails is never watched; (2) a watched root deleted and recreated is never watched again (chokidar 4 probe: no events after recreate); (3) a package_name rename/re-point changes no digest, so no reload and no overlay until a manual reload.
Ruling: all three fixed in one wave. (1) widen to roots [""] while the last build failed, narrow on the next good build; (2) the watcher records roots whose own path got unlinkDir and re-adds those that exist again on every `update`, which the driver now calls after every cycle; (3) `packages` differences push "packages" into `other` (forces reload, which replays the error). Also in the wave: minors 1 (dirty=true when update added paths), 2 (empty error text fallback + `Computing main repo mapping:` progress line), 6 (.bazelrc on the restart list), and `cannot resolve` logged only when lastError changes (closes the Task 4 duplicate-line minor) — cost if wrong: a few extra no-op builds while builds fail.
Final review: remaining minors deferred as listed (3 barrel-library BUILD roots, 4 output-path flags wording, 5 npm-internal css, 7 ENOSPC hint, 8 per-call sort, 10 EADDRINUSE stack trace). Ledger committed by the controller after the wave.
Final fix wave: dispatched (opus) at FIX_BASE 8ea14e1
Final fix wave: DONE at 1590a41 (2 commits; Opus trailer accepted) — deviations: deleted-root detection also counts any unlink under a root whose directory is gone (unlinkDir alone flaked 14/24 under load); update never unwatches a path inside or containing a still-wanted one (unwatching "" after widening dropped nested watchers); M1's extra cycle runs after good builds only.
Ruling: deviations accepted — both were found by running the tests under load and each is the smaller change — cost if wrong: after any failed build chokidar keeps inotify watches on the whole workspace until restart (events are filtered); recorded as a deferred minor.
Final fix wave re-review: dispatched (opus) over 8ea14e1..1590a41
Final fix wave re-review at 1590a41: all 7 addressed, no new Critical/Important breakage.
Final: minor (deferred): revival of a root deleted while widened is untested; a persistently throwing update logs every cycle; watcher state advances before fs.add; whole-workspace inotify watch persists after the first failed build until restart (ENOSPC risk in large monorepos).
Final review: clean after one fix wave.
