import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: "src/client",
  resolve: {
    // @maniclang/scene is a symlinked file: dependency with its own dev copy of
    // React; without dedupe the bundle ships two Reacts and hooks crash.
    dedupe: ["react", "react-dom"],
  },
  build: {
    outDir: "../../dist/client",
    emptyOutDir: true,
  },
});
