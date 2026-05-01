import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { applyMode, readStoredMode } from "./theme/mode";
import "./styles/global.css";

// Apply the stored color mode before first paint to avoid a flash.
applyMode(readStoredMode());

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
