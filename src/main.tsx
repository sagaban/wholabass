import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { log } from "./diag/logger";
import { applyMode, readStoredMode } from "./theme/mode";
// Bundle the Victor Mono weights we actually use so they ship offline.
import "@fontsource/victor-mono/400.css";
import "@fontsource/victor-mono/500.css";
import "@fontsource/victor-mono/600.css";
import "@fontsource/victor-mono/700.css";
import "@fontsource/victor-mono/400-italic.css";
import "./styles/global.css";
import { ensureBravuraLoaded } from "./audio/smufl-font";

// Apply the stored color mode before first paint to avoid a flash.
applyMode(readStoredMode());
ensureBravuraLoaded();

log.info(`app boot · ua=${navigator.userAgent}`);

// Capture any uncaught JS error / unhandled promise so the next crash
// leaves something behind in the rolling log. The Rust-side rolling
// file persists across WebView reloads — that's the point.
window.addEventListener("error", (e) => {
  const stack = e.error instanceof Error ? e.error.stack : undefined;
  log.error(
    `window.error: ${e.message} @ ${e.filename}:${e.lineno}:${e.colno}` +
      (stack ? `\n${stack}` : ""),
  );
});
window.addEventListener("unhandledrejection", (e) => {
  const reason = e.reason;
  const msg =
    reason instanceof Error
      ? `${reason.name}: ${reason.message}\n${reason.stack ?? ""}`
      : typeof reason === "string"
        ? reason
        : JSON.stringify(reason);
  log.error(`unhandledrejection: ${msg}`);
});

// Print → temporarily strip the `.dark` class so the document renders
// in light-theme tokens (white canvas, dark text, light section bands).
// Without this the note rectangles fill with the dark-mode `canvas`
// token and print as black blocks on a white page. The previous mode
// is restored when the print dialog closes.
{
  let wasDark = false;
  window.addEventListener("beforeprint", () => {
    wasDark = document.documentElement.classList.contains("dark");
    if (wasDark) document.documentElement.classList.remove("dark");
  });
  window.addEventListener("afterprint", () => {
    if (wasDark) document.documentElement.classList.add("dark");
  });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
