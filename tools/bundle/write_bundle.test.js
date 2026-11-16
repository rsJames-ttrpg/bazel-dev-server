import test from "node:test";
import assert from "node:assert/strict";
import { renderBundleIndex } from "./write_bundle.js";
const html = `<html><head></head><body><script type="module" src="./src/main.tsx"></script></body></html>`;

test("points the entry script at main.js", () => {
  const out = renderBundleIndex(html, "src/main.tsx", false);
  assert.match(out, /src="\.\/main\.js"/);
  assert.doesNotMatch(out, /main\.css/);
});
test("links main.css when the bundle has one", () => {
  const out = renderBundleIndex(html, "src/main.tsx", true);
  assert.match(out, /<link rel="stylesheet" href="\.\/main\.css">\s*<\/head>/);
});
test("throws when the entry script is missing", () => {
  assert.throws(() => renderBundleIndex("<html></html>", "src/main.tsx", false), /entry script/);
});
