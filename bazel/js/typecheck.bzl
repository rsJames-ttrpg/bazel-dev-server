"""typecheck_tsconfig: the tsconfig that <name>.typecheck runs tsc with."""

load(":providers.bzl", "JsSourceInfo")

def _typecheck_tsconfig_impl(ctx):
    out = ctx.actions.declare_file(ctx.attr.out)

    # Every path is relative to the directory of the generated file.
    depth = len(out.short_path.split("/")) - 1
    up = "../" * depth

    srcs = depset(transitive = [d[JsSourceInfo].srcs for d in ctx.attr.deps]).to_list()
    for f in srcs:
        if f.short_path.startswith("../"):
            fail("sources from external repositories are not supported: " + f.short_path)
    packages = {}
    for d in ctx.attr.deps:
        packages.update(d[JsSourceInfo].packages)

    # Only what tsc can load: .css and other assets are typed by css.d.ts.
    files = [
        up + f.short_path
        for f in srcs + ctx.files.extra_files
        if f.extension in ["ts", "tsx"]
    ]
    paths = {}
    for pkg, root in packages.items():
        paths[pkg] = [up + root]
        paths[pkg + "/*"] = [up + root + "/*"]

    ctx.actions.write(out, json.encode_indent({
        "extends": up + "tsconfig.json",
        "compilerOptions": {"noEmit": True, "paths": paths},
        "files": sorted(files),
    }) + "\n")

    # The sources travel as runfiles, not files: rules_js refuses to copy
    # another package's source files to bin, and the runfiles tree has them at
    # their workspace paths, which is where the tsconfig points.
    return [DefaultInfo(
        files = depset([out]),
        runfiles = ctx.runfiles(files = srcs + ctx.files.extra_files),
    )]

typecheck_tsconfig = rule(
    implementation = _typecheck_tsconfig_impl,
    attrs = {
        "deps": attr.label_list(providers = [JsSourceInfo]),
        "extra_files": attr.label_list(allow_files = True, default = ["//bazel/js:css.d.ts"]),
        "out": attr.string(mandatory = True),
    },
)
