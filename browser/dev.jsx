// Entry point: sets up the globals bonk.io's game code expects
// (globals.js), then mounts the app.
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./app/App.jsx";
import "./dev.css";
import "./globals.js";

createRoot(document.getElementById("root")).render(<App />);
