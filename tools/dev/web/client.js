// Dev client: full reload on rebuild, error overlay on a failed build.
const OVERLAY_ID = "__dev_error_overlay";

// Dev modules carry SWC's Fast Refresh registration calls. Until the refresh
// runtime exists they are no-ops; this script runs before the entry module.
window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => (type) => type;

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

function connect() {
  const ws = new WebSocket(`ws://${location.host}/@dev/ws`);
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "reload") {
      hideError();
      location.reload();
    } else if (msg.type === "error") {
      showError(msg.message);
    }
  });
  ws.addEventListener("close", () => setTimeout(connect, 1000));
}

connect();
