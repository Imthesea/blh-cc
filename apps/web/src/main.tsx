import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { setRemoteTransport } from "@blh/logger";
import { reportLogs } from "@blh/web-client";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./styles.css";

setRemoteTransport((entry) => {
  void reportLogs([entry]);
});

const root = document.getElementById("root");
if (root !== null) {
  createRoot(root).render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  );
}
