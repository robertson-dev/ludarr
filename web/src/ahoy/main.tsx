/** Ahoy — the launcher's own UI, served by ludarr at /ahoy. Same API, same bridge, its own identity. */
import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "@fontsource-variable/figtree";
import "@fontsource-variable/bricolage-grotesque";
import "@fontsource-variable/jetbrains-mono";
import "./ahoy.css";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter basename="/ahoy">
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
