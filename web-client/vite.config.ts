import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  build: {
    // RealApp and PreviewPdf are already separate lazy-loaded feature chunks.
    // Keep the warning above their current size instead of forcing dependency
    // graphs into vendor chunks that can change module initialization order.
    chunkSizeWarningLimit: 800,
  },
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/setup.ts"],
  },
});
