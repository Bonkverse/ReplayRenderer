// Entry point: sets up the globals bonk.io's game code expects
// (globals.js), then mounts the app.
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./app/App.jsx";
// Bonkverse/ui first (tokens, Jost, the shared header and components), then
// this site's own layout on top. theme.js runs earlier, inlined into
// index.html by vite.config.js, so the saved theme applies before paint.
import "@bonkverse/ui/tokens.css";
import "@bonkverse/ui/base.css";
import "@bonkverse/ui/components.css";
import "@bonkverse/ui/ui.js";
import "./dev.css";
import "./globals.js";

createRoot(document.getElementById("root")).render(<App />);
