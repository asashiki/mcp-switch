import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// 默认把 /api 转发到生产 gateway，本地调试无需配置 CORS。
// 也可以用 VITE_API_BASE 直接指向 http://127.0.0.1:4200 然后跳过 proxy。
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const apiTarget = env.VITE_DEV_PROXY || "http://127.0.0.1:4200";
  return {
    // 生产挂在 example.com/console/ 子路径下（gateway 静态服务）
    base: "/console/",
    plugins: [react()],
    resolve: {
      alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    },
    server: {
      port: 5173,
      proxy: {
        "/api": {
          target: apiTarget,
          changeOrigin: true,
          secure: true,
        },
      },
    },
    build: {
      // 直接产出到 gateway 的静态服务目录，省掉手工拷贝；docker build 时也由此生成。
      outDir: fileURLToPath(new URL("../mcp-gateway/console-web-dist", import.meta.url)),
      emptyOutDir: true,
      sourcemap: false,
      target: "es2020",
    },
  };
});
