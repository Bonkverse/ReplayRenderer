// Entry point for the About replay dates page (about/dates.html): the page's
// text is plain HTML; this adds the shared Bonkverse header and footer.
import React from "react";
import { createRoot } from "react-dom/client";
import { SiteHeader, SiteFooter } from "./app/components.jsx";
import "@bonkverse/ui/tokens.css";
import "@bonkverse/ui/base.css";
import "@bonkverse/ui/components.css";
import "@bonkverse/ui/seasons.css";
import "@bonkverse/ui/ui.js";
import "./about.css";

createRoot(document.getElementById("site-header")).render(<SiteHeader inApp={false} />);
createRoot(document.getElementById("site-footer")).render(<SiteFooter />);
