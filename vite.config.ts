import { defineConfig } from "vite";

// base を "./" にして、GitHub Pages の https://<ユーザー>.github.io/<リポジトリ名>/ でも動くようにする
export default defineConfig({
  base: "./",
  server: { host: "0.0.0.0", allowedHosts: true },
  preview: { host: "0.0.0.0", allowedHosts: true },
  build: { target: "es2022" },
});
