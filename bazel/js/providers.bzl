"""Providers shared by the JS rules."""

JsSourceInfo = provider(
    doc = "Transitive JS/TS sources of a js_library.",
    fields = {
        "srcs": "depset[File]: transitive source files",
        "packages": "dict[str, str]: package_name to workspace-relative BUILD directory",
    },
)

ModulesInfo = provider(
    doc = "Per-file transform outputs of transform_modules.",
    fields = {
        "modules": "list[struct(src: File, out: File, meta: File)]",
        "packages": "dict[str, str]: package_name to workspace-relative BUILD directory",
    },
)
