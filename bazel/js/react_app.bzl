"""react_app: the targets for one React application."""

load("@aspect_rules_esbuild//esbuild:defs.bzl", "esbuild")
load("@aspect_rules_js//js:defs.bzl", "js_binary")
load(":bundle.bzl", "bundle_config", "bundle_dir")
load(":dev.bzl", "dev_config")
load(":js_library.bzl", "js_library")
load(":manifest.bzl", "app_manifest")
load(":npm.bzl", "npm_prebundle")
load(":transform.bzl", "transform_modules")

def react_app(name, srcs, entry, index_html, npm_imports, npm_deps, deps = [], port = 5173):
    """Declares <name>.src, .modules, .npm, .npm.dev, .manifest, .manifest.dev, .dev and .bundle.

    Rule logic lives in the loaded .bzl files; this macro only wires targets.

    Args:
        name: application name, the prefix of every target.
        srcs: the app's .ts/.tsx sources.
        entry: package-relative path of the entry source, e.g. "src/main.tsx".
        index_html: the app's index.html.
        npm_imports: bare specifiers the app imports from npm.
        npm_deps: linked npm package targets providing npm_imports.
        deps: js_library targets the app depends on.
        port: dev server port of <name>.dev.
    """

    js_library(name = name + ".src", srcs = srcs, deps = deps)
    transform_modules(name = name + ".modules", deps = [":" + name + ".src"])

    # Dev-config modules compile JSX against react/jsx-dev-runtime. Both
    # bundles get it so the one npm_entries dict is valid in either config.
    npm_imports = list(npm_imports)
    if "react/jsx-runtime" in npm_imports and "react/jsx-dev-runtime" not in npm_imports:
        npm_imports.append("react/jsx-dev-runtime")

    npm_entries = npm_prebundle(name + ".npm", npm_imports, npm_deps, dev = False)
    npm_prebundle(name + ".npm.dev", npm_imports, npm_deps, dev = True)

    app_manifest(
        name = name + ".manifest",
        modules = ":" + name + ".modules",
        entry = entry,
        index_html = index_html,
        npm_dir = select({
            Label("//bazel/js:is_dev"): ":" + name + ".npm.dev",
            "//conditions:default": ":" + name + ".npm",
        }),
        npm_entries = npm_entries,
    )
    dev_config(name = name + ".manifest.dev", target = ":" + name + ".manifest")

    # Dev server: `bazel run :<name>.dev` serves the dev manifest and rebuilds it
    # with a nested `bazel build` on every change.
    js_binary(
        name = name + ".dev",
        entry_point = Label("//tools/dev/web:main"),
        data = [
            ":" + name + ".manifest.dev",
            Label("//tools/dev/web"),
            Label("//tools/dev/driver"),
        ],
        args = [
            "--manifest",
            "$(execpath :%s.manifest.dev)" % name,
            "--target",
            "//%s:%s.manifest.dev" % (native.package_name(), name),
            "--app",
            "//%s:%s" % (native.package_name(), name),
            "--port",
            str(port),
        ],
    )

    # Production bundle: esbuild over the same transformed modules, with a
    # generated config that sets the entry and resolves package_name imports.
    # <name>.bundle/ holds index.html (entry script pointed at main.js), main.js,
    # its source map and main.css when there is CSS, ready to serve statically.
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
