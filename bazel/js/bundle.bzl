"""bundle_config and bundle_dir: the production bundle's esbuild config and output directory."""

load(":providers.bzl", "ModulesInfo")

def _bundle_config_impl(ctx):
    info = ctx.attr.modules[ModulesInfo]
    want = ctx.label.package + "/" + ctx.attr.entry
    entry = None
    for m in info.modules:
        if m.src.short_path == want:
            entry = m.out.short_path
    if entry == None:
        fail("%s: entry %s is not among the modules of %s" % (ctx.label, want, ctx.attr.modules.label))

    modules_label = ctx.attr.modules.label
    packages = {}
    for name, root in info.packages.items():
        packages[name] = modules_label.package + "/" + modules_label.name + "/" + root

    out = ctx.outputs.out
    ctx.actions.expand_template(
        template = ctx.file._template,
        output = out,
        substitutions = {
            "%ENTRY%": json.encode(entry),
            "%PACKAGES%": json.encode(packages),
        },
    )
    return [DefaultInfo(files = depset([out]))]

bundle_config = rule(
    implementation = _bundle_config_impl,
    attrs = {
        "modules": attr.label(mandatory = True, providers = [ModulesInfo]),
        "entry": attr.string(mandatory = True),
        "out": attr.output(mandatory = True),
        "_template": attr.label(
            default = "//bazel/js:esbuild_bundle.config.mjs.tpl",
            allow_single_file = True,
        ),
    },
)

def _bundle_dir_impl(ctx):
    out = ctx.actions.declare_directory(ctx.label.name)
    esbuild_files = ctx.attr.esbuild[DefaultInfo].files.to_list()
    if len(esbuild_files) != 1 or not esbuild_files[0].is_directory:
        fail("%s: esbuild must produce exactly one output directory" % ctx.label)
    esbuild_dir = esbuild_files[0]

    args = ctx.actions.args()
    args.use_param_file("@%s", use_always = True)
    args.set_param_file_format("multiline")
    args.add("--esbuild-dir", esbuild_dir.path)
    args.add("--index", ctx.file.index_html.path)
    args.add("--entry", ctx.attr.entry)
    args.add("--out", out.path)

    ctx.actions.run(
        executable = ctx.executable._writer,
        arguments = [args],
        inputs = [esbuild_dir, ctx.file.index_html],
        outputs = [out],
        mnemonic = "BundleDir",
        env = {
            "BAZEL_BINDIR": ctx.bin_dir.path,
            "JS_BINARY__NO_CD_BINDIR": "1",
        },
        progress_message = "Assembling bundle " + out.short_path,
    )
    return [DefaultInfo(files = depset([out]))]

bundle_dir = rule(
    implementation = _bundle_dir_impl,
    attrs = {
        "esbuild": attr.label(mandatory = True),
        "index_html": attr.label(mandatory = True, allow_single_file = True),
        "entry": attr.string(mandatory = True),
        "_writer": attr.label(
            default = "//tools/bundle:write_bundle",
            executable = True,
            cfg = "exec",
        ),
    },
)
