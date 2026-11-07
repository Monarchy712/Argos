import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // PORT is set by the harness when it assigns a port; 5180 is the default otherwise.
  server: { port: Number(process.env.PORT ?? 5180), strictPort: false },
  build: { target: "es2022", sourcemap: true },
});
