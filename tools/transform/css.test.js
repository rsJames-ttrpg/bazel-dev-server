import test from "node:test";
import assert from "node:assert/strict";
import { transformCss } from "./css.js";

test("plain css: dev module injects a style element and exports an empty map", () => {
  const r = transformCss({ code: ".a { color: red }", filename: "a.css", key: "app/a.css", dev: true });
  assert.match(r.css, /\.a\s*{\s*color:\s*red/);
  assert.match(r.code, /data-dev-css="\$\{id\}"/);
  assert.match(r.code, /const id = "app\/a\.css"/);
  assert.match(r.code, /export default {}/);
  assert.equal(r.meta.kind, "css");
  assert.equal(r.meta.refresh, true);
  assert.deepEqual(r.meta.imports, []);
});
test("plain css: prod module imports the css file and exports the map", () => {
  const r = transformCss({ code: ".a { color: red }", filename: "a.css", key: "app/a.css", dev: false });
  assert.match(r.code, /^import "\.\/a\.css";/);
  assert.doesNotMatch(r.code, /document/);
  assert.deepEqual(r.meta.imports, ["./a.css"]);
});
test("module css: class names are hashed identically in dev and prod", () => {
  const dev = transformCss({ code: ".button { color: red }", filename: "x.module.css", key: "app/x.module.css", dev: true });
  const prod = transformCss({ code: ".button { color: red }", filename: "x.module.css", key: "app/x.module.css", dev: false });
  assert.match(dev.meta.exports.button, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(dev.meta.exports.button, "button");
  assert.equal(dev.meta.exports.button, prod.meta.exports.button);
  assert.ok(dev.css.includes(dev.meta.exports.button));
  assert.match(dev.code, new RegExp(`export default {"button":"${dev.meta.exports.button}"}`));
});
test("dev module changes digest when the css changes", () => {
  const a = transformCss({ code: ".a { color: red }", filename: "a.css", key: "app/a.css", dev: true });
  const b = transformCss({ code: ".a { color: blue }", filename: "a.css", key: "app/a.css", dev: true });
  assert.notEqual(a.meta.digest, b.meta.digest);
});
test("a css syntax error throws with file and line", () => {
  assert.throws(() => transformCss({ code: ".a {{ color: red }", filename: "a.css", key: "app/a.css", dev: true }), /^Error: a\.css:1:5: /);
});
test("module css: composes adds the composed class names, identically in dev and prod", () => {
  const src = ".base { color: red } .button { composes: base; margin: 0 }";
  const dev = transformCss({ code: src, filename: "x.module.css", key: "app/x.module.css", dev: true });
  const prod = transformCss({ code: src, filename: "x.module.css", key: "app/x.module.css", dev: false });
  const parts = dev.meta.exports.button.split(" ");
  assert.equal(parts.length, 2);
  assert.ok(parts.includes(dev.meta.exports.base));
  assert.deepEqual(dev.meta.exports, prod.meta.exports);
});
