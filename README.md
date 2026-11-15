# hermetic-dev-server

A dev server for TypeScript React apps built with Bazel. Every module the browser loads is a Bazel output, so the dev server and the production build share the same toolchain and the same pinned dependencies.

To try it, run the example app. It prints `dev server at http://localhost:5173`; open that address, edit `examples/hello/src/App.tsx`, and the page reloads after each save.

```
bazel run //examples/hello:hello.dev
```

Read the [user guide](docs/using-the-dev-server.md) to declare your own app, and the [design spec](docs/superpowers/specs/2026-11-15-hermetic-dev-server-design.md) for how it works.
