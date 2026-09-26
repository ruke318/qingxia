import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "plugins/hosts-switch",
  base: "./",
  plugins: [react()],
  build: { outDir: "../../src-tauri/resources/plugins/hosts-switch", emptyOutDir: true },
});
