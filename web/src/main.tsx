import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { urlBase } from "./api";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter basename={urlBase || undefined}>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
