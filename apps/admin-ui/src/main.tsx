import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { legacyAdminPath } from "./routes";
import "./styles.css";

const legacyPath = legacyAdminPath(window.location.pathname, window.location.hash);
if (legacyPath) window.history.replaceState(window.history.state, "", legacyPath);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
