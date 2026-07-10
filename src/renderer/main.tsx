import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./globals.css";
import { ensureRpc } from "./lib/api-client";
import { installApiShims } from "./lib/api-fetch";

// Install /api fetch + EventSource shims before any component mounts
installApiShims();

// Boot RPC early so the first UI interactions are ready
void ensureRpc().catch((err) => {
  console.error("[pi-desktop] failed to connect to agent host:", err);
});

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
