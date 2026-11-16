"""app_manifest: the JSON manifest the dev server reads."""

load(":providers.bzl", "ModulesInfo")

def _app_manifest_impl(ctx):
    info = ctx.attr.modules[ModulesInfo]
    out = ctx.actions.declare_file(ctx.label.name + ".json")

    args = ctx.actions.args()
    args.use_param_file("@%s", use_always = True)
    args.set_param_file_format("multiline")
    args.add("--out", out)
    args.add("--package", ctx.label.package)
    args.add("--entry", ctx.label.package + "/" + ctx.attr.entry)
    args.add("--index", ctx.file.index_html.path)

    inputs = [ctx.file.index_html]
    for m in info.modules:
        args.add("--module", "%s=%s=%s" % (m.src.short_path, m.out.path, m.meta.path))
        inputs.append(m.out)
        inputs.append(m.meta)
        inputs.extend(m.extra)
    if ctx.files.npm_dir:
        args.add("--npm-dir", ctx.files.npm_dir[0].path)
        inputs.extend(ctx.files.npm_dir)
    for spec, file in ctx.attr.npm_entries.items():
        args.add("--npm-entry", "%s=%s" % (spec, file))
    for name, dir in info.packages.items():
        args.add("--package-root", "%s=%s" % (name, dir))

    # The .js outputs are inputs although the script never reads them: building
    # the manifest builds every module (and npm bundle) the server will serve.
    ctx.actions.run(
        executable = ctx.executable._writer,
        arguments = [args],
        inputs = inputs,
        outputs = [out],
        mnemonic = "AppManifest",
        env = {
            "BAZEL_BINDIR": ctx.bin_dir.path,
            "JS_BINARY__NO_CD_BINDIR": "1",
        },
        progress_message = "Writing manifest " + out.short_path,
    )
    return [DefaultInfo(
        files = depset([out]),
        runfiles = ctx.runfiles(files = inputs),
    )]

app_manifest = rule(
    implementation = _app_manifest_impl,
    attrs = {
        "modules": attr.label(mandatory = True, providers = [ModulesInfo]),
        "entry": attr.string(mandatory = True),
        "index_html": attr.label(mandatory = True, allow_single_file = True),
        "npm_dir": attr.label(allow_files = True),
        "npm_entries": attr.string_dict(),
        "_writer": attr.label(
            default = "//tools/manifest:write_manifest",
            executable = True,
            cfg = "exec",
        ),
    },
)
