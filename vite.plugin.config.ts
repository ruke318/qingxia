import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "plugins/json-tools",
  base: "./",
  plugins: [react()],
  build: {
    outDir: "../../src-tauri/resources/plugins/json-tools",
    emptyOutDir: true,
  },
});
