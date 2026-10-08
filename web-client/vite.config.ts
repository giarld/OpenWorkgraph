import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const chunkSizeWarningLimit = 800;
const chunkSizeWarningAllowlist = new Set(["RealApp"]);

export default defineConfig({
  plugins: [
    react(),
    {
      name: "chunk-size-warning-allowlist",
      apply: "build",
      generateBundle(_options, bundle) {
        for (const output of Object.values(bundle)) {
          if (output.type !== "chunk" || chunkSizeWarningAllowlist.has(output.name)) continue;
          const size = Buffer.byteLength(output.code);
          if (size > chunkSizeWarningLimit * 1000) {
            this.warn(
              `${output.fileName} is ${(size / 1000).toFixed(2)} kB after minification, ` +
              `exceeding the ${chunkSizeWarningLimit} kB chunk size warning limit. ` +
              "Consider using dynamic import() to code-split the application.",
            );
          }
        }
      },
    },
  ],
  build: {
    rollupOptions: { input: { home: 'index.html', workgraphs: 'workgraphs.html' } },
    // Vite's built-in reporter only supports a global limit. The plugin above
    // keeps the 800 kB warning for other chunks while allowing lazy-loaded RealApp.
    chunkSizeWarningLimit: Infinity,
  },
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/setup.ts"],
  },
});
