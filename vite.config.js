// Two pages: the site (index.html) and the bare player that the video
// renderer opens in headless Chrome (render.html, server/render-server.mjs).
// Everything else is Vite's defaults, as before this file existed.
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    rolldownOptions: {
      input: {
        main: "index.html",
        render: "render.html",
      },
    },
  },
});
