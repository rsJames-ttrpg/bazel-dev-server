"""npm_prebundle: one esbuild invocation that pre-bundles bare npm specifiers."""

load("@aspect_bazel_lib//lib:expand_template.bzl", "expand_template")
load("@aspect_rules_esbuild//esbuild:defs.bzl", "esbuild")

def npm_entry_name(specifier):
    """Output file stem for a bare specifier: "react-dom/client" -> "react-dom__client"."""
    return specifier.replace("/", "__")

def npm_prebundle(name, npm_imports, npm_deps, dev):
    """Pre-bundles npm_imports into one ES module each, sharing chunks.

    Each output re-exports the package's named exports as well as its
    default, CommonJS packages included (see the config template).

    All specifiers are entry points of a single esbuild run with code
    splitting, so a package imported by several entries (React) lives in one
    shared chunk and the browser gets exactly one instance of it.

    Args:
        name: target name; the output directory is <name>/.
        npm_imports: bare specifiers to expose, e.g. "react/jsx-runtime".
        npm_deps: linked npm package targets the specifiers resolve to.
        dev: if True define process.env.NODE_ENV as "development", else "production".

    Returns:
        dict from specifier to output file name within the directory.
    """
    entries = {spec: npm_entry_name(spec) + ".js" for spec in npm_imports}
    node_env = "development" if dev else "production"
    config = name + ".config.mjs"
    expand_template(
        name = name + ".config",
        out = config,
        template = Label("//bazel/js:esbuild_prebundle.config.mjs.tpl"),
        substitutions = {
            "%ENTRY_POINTS%": json.encode([
                {"in": spec, "out": npm_entry_name(spec)}
                for spec in npm_imports
            ]),
            "%NODE_ENV%": json.encode(node_env),
        },
    )
    esbuild(
        name = name,
        # rules_esbuild requires a file entry point; the config's plugin
        # replaces it with one virtual entry per specifier.
        entry_points = [config],
        config = config,
        deps = npm_deps,
        output_dir = True,
        splitting = True,
        format = "esm",
        define = {"process.env.NODE_ENV": json.encode(node_env)},
    )
    return entries
