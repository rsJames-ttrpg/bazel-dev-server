// @ts-check

const CLIENT = `<script type="module" src="/@dev/client.js"></script>`;

/**
 * Pure: point the entry script at the entry module and inject the dev client.
 * @param {string} html @param {{ entry: string }} manifest
 */
export function renderIndex(html, manifest) {
  const out = html.replace(
    /(<script\b[^>]*\btype="module"[^>]*\bsrc=")\.\/[^"]*(")/,
    (_, before, after) => `${before}/${manifest.entry}${after}`,
  );
  return out.includes("</head>") ? out.replace("</head>", `${CLIENT}</head>`) : CLIENT + out;
}
