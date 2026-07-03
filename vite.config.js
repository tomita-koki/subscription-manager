import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // GitHub Pages(https://<user>.github.io/subscription-manager/)向けビルドのみサブパス配信
  base: process.env.GITHUB_ACTIONS ? "/subscription-manager/" : "/",
  server: {
    port: process.env.PORT ? Number(process.env.PORT) : 5173,
  },
});
