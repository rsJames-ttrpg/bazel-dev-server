# hermetic-dev-server

A dev server for TypeScript React apps built with Bazel. Every module the browser loads is a Bazel output, so the dev server and the production build share the same toolchain and the same pinned dependencies.

To try it, run the example app. It prints `dev server at http://localhost:5173`; open that address, edit `examples/hello/src/App.tsx`, and the page updates after each save.

```
bazel run //examples/hello:hello.dev
```

- Fast Refresh: editing a component updates it in place and keeps its state; editing the entry or a non-component module reloads the page.
- CSS: `.css` sources go through Lightning CSS, `*.module.css` exports hashed class names, and a stylesheet edit hot-swaps without a reload.
- Typecheck: `bazel test //examples/hello:hello.typecheck` runs `tsc` over the app and its libraries.

Read the [user guide](docs/using-the-dev-server.md) to declare your own app, and the [design spec](docs/superpowers/specs/2026-11-15-hermetic-dev-server-design.md) for how it works.
