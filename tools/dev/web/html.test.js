import test from "node:test";
import assert from "node:assert/strict";
import { renderIndex } from "./html.js";
test("entry script and client injected", () => {
  const out = renderIndex(`<html><head></head><body><div id="root"></div><script type="module" src="./src/main.tsx"></script></body></html>`, { entry: "app/src/main.tsx" });
  assert.match(out, /src="\/app\/src\/main\.tsx"/);
  assert.match(out, /<script type="module" src="\/@dev\/client\.js"><\/script><\/head>/);
});
