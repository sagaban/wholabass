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

// Wire global error capture FIRST so any throw from boot init or the
// boot breadcrumb itself reaches the log file. If the logger is the
// broken thing, the inner try/catch falls back to console.error in
// the WebView devtools — so a blank window can never be "no signal
// anywhere", only "check devtools instead of the log file".
window.addEventListener("error", (e) => {
  const stack = e.error instanceof Error ? e.error.stack : undefined;
  try {
    log.error(
      `window.error: ${e.message} @ ${e.filename}:${e.lineno}:${e.colno}` +
        (stack ? `\n${stack}` : ""),
    );
  } catch {
    console.error("window.error (logger failed):", e);
  }
});
window.addEventListener("unhandledrejection", (e) => {
  const reason = e.reason;
  const msg =
    reason instanceof Error
      ? `${reason.name}: ${reason.message}\n${reason.stack ?? ""}`
      : typeof reason === "string"
        ? reason
        : JSON.stringify(reason);
  try {
    log.error(`unhandledrejection: ${msg}`);
  } catch {
    console.error("unhandledrejection (logger failed):", reason);
  }
});

// Apply the stored color mode before first paint to avoid a flash.
// Boot-time setup is wrapped so a localStorage failure or font-load
// throw can never block the render — better to ship with default
// theme than a blank window.
try {
  applyMode(readStoredMode());
} catch (e) {
  console.error("applyMode failed:", e);
}
try {
  ensureBravuraLoaded();
} catch (e) {
  console.error("ensureBravuraLoaded failed:", e);
}

try {
  log.info(`app boot · ua=${navigator.userAgent}`);
} catch (e) {
  console.error("boot log failed:", e);
}

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
