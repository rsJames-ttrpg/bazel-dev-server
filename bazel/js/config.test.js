import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

async function loadConfig(packages = { "@x/ui": "pkg/ui" }) {
  const tpl = readFileSync(resolve("bazel/js/esbuild_bundle.config.mjs.tpl"), "utf8");
  const src = tpl.replace("%ENTRY%", JSON.stringify("app/main.js")).replace("%PACKAGES%", JSON.stringify(packages));
  const file = join(mkdtempSync(join(tmpdir(), "cfg-")), "config.mjs");
  writeFileSync(file, src);
  return (await import(pathToFileURL(file).href)).default;
}

test("bundle config sets the entry and forces the plain css loader for .module.css", async () => {
  const config = await loadConfig();
  const build = { initialOptions: { loader: { ".png": "file" } }, onResolve() {}, resolve() {} };
  for (const plugin of config.plugins) plugin.setup(build);
  assert.equal(build.initialOptions.loader[".module.css"], "css");
  assert.equal(build.initialOptions.loader[".png"], "file");
  assert.equal(build.initialOptions.entryPoints[0].out, "main");
  assert.match(build.initialOptions.entryPoints[0].in, /app\/main\.js$/);
});

test("the longest package name wins in the bundle resolver", async () => {
  const config = await loadConfig({ "@x/ui": "ui", "@x/ui/icons": "icons" });
  const handlers = [];
  const build = { initialOptions: {}, onResolve: (opts, fn) => handlers.push({ opts, fn }), resolve: (p) => p };
  for (const plugin of config.plugins) plugin.setup(build);
  const bare = handlers.find((h) => h.opts.filter.test("@x/ui/icons/Arrow") && !h.opts.filter.test("./a"));
  const last = handlers[handlers.length - 1];
  const result = await (bare ?? last).fn({ path: "@x/ui/icons/Arrow", kind: "import-statement" });
  assert.match(result.path ?? result, /icons\/Arrow$/);
  assert.doesNotMatch(result.path ?? result, /ui\/icons/);
});
