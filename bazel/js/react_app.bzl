"""react_app: the targets for one React application."""

load("@aspect_bazel_lib//lib:output_files.bzl", "output_files")
load("@aspect_rules_esbuild//esbuild:defs.bzl", "esbuild")
load("@aspect_rules_js//js:defs.bzl", "js_binary")
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

    # Production bundle: esbuild over the same transformed modules, then
    # <name>.bundle/ holds index.html (entry script pointed at main.js),
    # main.js and its source map, ready to serve as static files.
    entry_stem = entry[:entry.rindex(".")]
    output_files(
        name = name + ".bundle.entry",
        target = ":" + name + ".modules",
        paths = ["%s/%s.modules/%s/%s.js" % (
            native.package_name(),
            name,
            native.package_name(),
            entry_stem,
        )],
    )
    esbuild(
        name = name + ".bundle.esbuild",
        entry_point = ":" + name + ".bundle.entry",
        srcs = [":" + name + ".modules"],
        deps = npm_deps,
        output_dir = True,
        splitting = False,
        format = "esm",
        define = {"process.env.NODE_ENV": '"production"'},
        # Whatever the entry file is called, the bundle is main.js.
        config = {"entryNames": "main"},
    )
    native.genrule(
        name = name + ".bundle",
        srcs = [index_html, ":" + name + ".bundle.esbuild"],
        outs = [
            name + ".bundle/index.html",
            name + ".bundle/main.js",
            name + ".bundle/main.js.map",
        ],
        cmd = " && ".join([
            "out=$(RULEDIR)/%s.bundle" % name,
            "sed 's#src=\"\\./%s\"#src=\"./main.js\"#' $(location %s) > $$out/index.html" % (
                entry.replace(".", "\\."),
                index_html,
            ),
            "cp $(location :%s.bundle.esbuild)/main.js $(location :%s.bundle.esbuild)/main.js.map $$out/" % (name, name),
            "grep -q 'src=\"./main.js\"' $$out/index.html",
        ]),
    )
