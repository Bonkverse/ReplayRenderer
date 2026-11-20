// Two pages: the site (index.html) and the bare player that the video
// renderer opens in headless Chrome (render.html, server/render-server.mjs).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { defineConfig } from "vite";

const require = createRequire(import.meta.url);

// Bonkverse/ui's theme.js must run before the page paints, so the saved theme
// (Bonkverse, Light or Dark) applies without a flash. A module import runs too
// late, so the script is inlined into the site's <head>. render.html draws
// videos only and keeps its own fixed look.
function inlineTheme() {
  return {
    name: "bonkverse-inline-theme",
    transformIndexHtml(html, ctx) {
      if (!ctx.filename.endsWith("index.html")) return html;
      // "</script" inside the file's own comments would end the tag early.
      const theme = readFileSync(require.resolve("@bonkverse/ui/theme.js"), "utf8").replace(
        /<\/script/gi,
        "<\\/script"
      );
      return {
        html,
        tags: [{ tag: "script", children: theme, injectTo: "head-prepend" }],
      };
    },
  };
}

export default defineConfig({
  plugins: [inlineTheme()],
  build: {
    rolldownOptions: {
      input: {
        main: "index.html",
        render: "render.html",
      },
    },
  },
});
