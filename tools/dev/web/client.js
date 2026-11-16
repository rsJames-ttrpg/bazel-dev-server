// Dev client: Fast Refresh and CSS hot swap on "update", full reload on
// "reload", error overlay on a failed build. Served at /@dev/client.js and
// injected into <head> ahead of the entry module, so __devRefresh exists before
// any app module evaluates.
import * as RefreshRuntime from "/npm/react-refresh__runtime.js";
import { classMapChanged, registerExportsForReactRefresh, validateRefreshBoundary } from "./refresh.js";

const OVERLAY_ID = "__dev_error_overlay";

RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => (type) => type;

// Module key -> the URL it was last evaluated from and its exports.
const modules = new Map();

// Called by the dev wrapper of every refresh-capable module after it
// evaluates, including on each re-import with a ?v= URL.
window.__devRefresh = {
  register: RefreshRuntime.register,
  createSignatureFunctionForTransform: RefreshRuntime.createSignatureFunctionForTransform,
  registerModule(key, url) {
    import(url).then((exports) => {
      registerExportsForReactRefresh(RefreshRuntime, key, exports);
      modules.set(key, { url, exports });
    });
  },
};

let refreshTimer;
function enqueueRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => RefreshRuntime.performReactRefresh(), 16);
}

function showError(message) {
  let overlay = document.getElementById(OVERLAY_ID);
  if (!overlay) {
    overlay = document.createElement("pre");
    overlay.id = OVERLAY_ID;
    overlay.style.cssText = [
      "position:fixed", "inset:0", "z-index:2147483647", "margin:0", "padding:24px",
      "overflow:auto", "background:rgba(20,20,20,0.95)", "color:#ff8080",
      "font:13px/1.5 ui-monospace,Menlo,Consolas,monospace", "white-space:pre-wrap",
    ].join(";");
    document.body.appendChild(overlay);
  }
  overlay.textContent = message;
}

function hideError() {
  document.getElementById(OVERLAY_ID)?.remove();
}

async function applyUpdate(updates) {
  for (const { key, digest, kind } of updates) {
    const url = `/${key}?v=${digest}`;
    if (kind === "css") {
      // A stylesheet this page never loaded (a lazy route not yet mounted) stays out.
      if (!document.head.querySelector(`style[data-dev-css="${CSS.escape(key)}"]`)) continue;
      // Importers hold the class map of the original /<key> instance, already in
      // the module map, so this import does not refetch or re-evaluate it.
      const prevMap = (await import(`/${key}`)).default;
      // Evaluating the new .css.js module replaces its <style> element.
      const nextMap = (await import(url)).default;
      if (classMapChanged(prevMap, nextMap)) {
        console.warn(`[dev] reload: ${key}: class names changed`);
        location.reload();
        return;
      }
      continue;
    }
    // A module this page never loaded has nothing to refresh.
    if (!modules.has(key)) continue;
    // Read before importing: the re-import calls registerModule, which replaces the entry.
    const prevExports = modules.get(key).exports;
    const next = await import(url);
    const reason = validateRefreshBoundary(RefreshRuntime, prevExports, next);
    if (reason) {
      console.warn(`[dev] reload: ${key}: ${reason}`);
      location.reload();
      return;
    }
    modules.set(key, { url, exports: next });
    enqueueRefresh();
  }
}

// Updates are applied one message at a time, in the order they arrive.
let pending = Promise.resolve();

function connect() {
  const ws = new WebSocket(`ws://${location.host}/@dev/ws`);
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "update") {
      hideError();
      pending = pending.then(() => applyUpdate(msg.modules)).catch((err) => {
        console.error("[dev] update failed, reloading", err);
        location.reload();
      });
    } else if (msg.type === "reload") {
      hideError();
      location.reload();
    } else if (msg.type === "ok") {
      hideError();
    } else if (msg.type === "error") {
      showError(msg.message);
    }
  });
  ws.addEventListener("close", () => setTimeout(connect, 1000));
}

connect();
