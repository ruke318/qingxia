import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 「编码工具」是外部插件：产物输出到 dist-plugins/crypto-tools，通过“本地导入”安装，不进入应用安装包
export default defineConfig({
  root: "plugins/crypto-tools",
  base: "./",
  plugins: [react()],
  build: { outDir: "../../dist-plugins/crypto-tools", emptyOutDir: true },
});
