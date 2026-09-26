import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 「二维码」是外部插件：产物输出到 dist-plugins/qr-tools，通过“本地导入”安装，不进入应用安装包。
export default defineConfig({
  root: "plugins/qr-tools",
  base: "./",
  plugins: [react()],
  build: { outDir: "../../dist-plugins/qr-tools", emptyOutDir: true },
});
