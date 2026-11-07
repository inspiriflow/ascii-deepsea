import { defineConfig } from "vite";

// Builds the Chrome extension into dist-extension/ (load it via chrome://extensions → Load unpacked).
export default defineConfig({
  root: "extension",
  base: "./", // extension pages need relative asset paths
  build: {
    outDir: "../dist-extension",
    emptyOutDir: true,
    rollupOptions: { input: "extension/newtab.html" },
  },
});
