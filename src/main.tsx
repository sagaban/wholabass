import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { applyMode, readStoredMode } from "./theme/mode";
// Bundle the Victor Mono weights we actually use so they ship offline.
import "@fontsource/victor-mono/400.css";
import "@fontsource/victor-mono/500.css";
import "@fontsource/victor-mono/600.css";
import "@fontsource/victor-mono/700.css";
import "@fontsource/victor-mono/400-italic.css";
import "./styles/global.css";

// Apply the stored color mode before first paint to avoid a flash.
applyMode(readStoredMode());

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
