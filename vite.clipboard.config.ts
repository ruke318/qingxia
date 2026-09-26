import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "plugins/clipboard-history",
  base: "./",
  plugins: [react()],
  build: { outDir: "../../src-tauri/resources/plugins/clipboard-history", emptyOutDir: true },
});
