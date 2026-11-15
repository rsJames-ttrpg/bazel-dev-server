"""dev_config: builds a target with //bazel/js:dev set to True."""

def _dev_transition_impl(_settings, _attr):
    return {"//bazel/js:dev": True}

_dev_transition = transition(
    implementation = _dev_transition_impl,
    inputs = [],
    outputs = ["//bazel/js:dev"],
)

def _dev_config_impl(ctx):
    info = ctx.attr.target[DefaultInfo]
    runfiles = ctx.runfiles(transitive_files = info.files).merge(info.default_runfiles)
    return [DefaultInfo(files = info.files, runfiles = runfiles)]

dev_config = rule(
    implementation = _dev_config_impl,
    cfg = _dev_transition,
    attrs = {
        "target": attr.label(mandatory = True),
    },
)
