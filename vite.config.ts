import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  build: {
    // 主入口与截图覆盖窗两个页面
    rollupOptions: { input: { main: "index.html", capture: "capture.html" } },
  },
  server: {
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
