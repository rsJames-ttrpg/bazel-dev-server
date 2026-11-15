"""js_library: a set of JS/TS sources plus their transitive deps."""

load(":providers.bzl", "JsSourceInfo")

def _js_library_impl(ctx):
    srcs = depset(ctx.files.srcs, transitive = [d[JsSourceInfo].srcs for d in ctx.attr.deps])
    packages = {}
    for d in ctx.attr.deps:
        packages.update(d[JsSourceInfo].packages)
    if ctx.attr.package_name:
        packages[ctx.attr.package_name] = ctx.label.package
    return [
        JsSourceInfo(srcs = srcs, packages = packages),
        DefaultInfo(files = srcs),
    ]

js_library = rule(
    implementation = _js_library_impl,
    attrs = {
        "srcs": attr.label_list(allow_files = True),
        "deps": attr.label_list(providers = [JsSourceInfo]),
        "package_name": attr.string(),
    },
)
