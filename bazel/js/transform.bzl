"""transform_modules: one persistent-worker action per .ts/.tsx source."""

load("@bazel_skylib//rules:common_settings.bzl", "BuildSettingInfo")
load(":providers.bzl", "JsSourceInfo", "ModulesInfo")

def _transform_modules_impl(ctx):
    dev = ctx.attr._dev[BuildSettingInfo].value
    tsconfig = ctx.file.tsconfig
    srcs = depset(transitive = [d[JsSourceInfo].srcs for d in ctx.attr.deps])
    packages = {}
    for d in ctx.attr.deps:
        packages.update(d[JsSourceInfo].packages)

    modules = []
    for src in srcs.to_list():
        if src.extension not in ("ts", "tsx"):
            continue
        stem = src.short_path[:-(len(src.extension) + 1)]
        out = ctx.actions.declare_file(ctx.label.name + "/" + stem + ".js")
        meta = ctx.actions.declare_file(ctx.label.name + "/" + stem + ".js.meta.json")

        args = ctx.actions.args()
        args.use_param_file("@%s", use_always = True)
        args.set_param_file_format("multiline")
        args.add("--src", src)
        args.add("--key", src.short_path)
        args.add("--out", out)
        args.add("--meta", meta)
        args.add("--dev", "true" if dev else "false")
        args.add("--tsconfig", tsconfig)

        ctx.actions.run(
            executable = ctx.executable._worker,
            arguments = [args],
            inputs = [src, tsconfig],
            outputs = [out, meta],
            mnemonic = "JsTransform",
            execution_requirements = {
                "supports-workers": "1",
                "requires-worker-protocol": "json",
            },
            # BAZEL_BINDIR satisfies the js_binary launcher; NO_CD_BINDIR keeps the
            # worker in the execroot, where --src/--out/--meta paths are rooted.
            env = {
                "BAZEL_BINDIR": ctx.bin_dir.path,
                "JS_BINARY__NO_CD_BINDIR": "1",
            },
            progress_message = "Transforming " + src.short_path,
        )
        modules.append(struct(src = src, out = out, meta = meta))

    return [
        DefaultInfo(files = depset([f for m in modules for f in (m.out, m.meta)])),
        ModulesInfo(modules = modules, packages = packages),
    ]

transform_modules = rule(
    implementation = _transform_modules_impl,
    attrs = {
        "deps": attr.label_list(providers = [JsSourceInfo]),
        "tsconfig": attr.label(default = "//:tsconfig.json", allow_single_file = True),
        "_dev": attr.label(default = "//bazel/js:dev"),
        "_worker": attr.label(
            default = "//tools/transform:worker",
            executable = True,
            cfg = "exec",
        ),
    },
)
