import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { build } from "vite";
import { fileURLToPath } from "node:url";

const chunkSizeWarningLimit = 800;
const chunkSizeWarningAllowlist = new Set(["RealApp"]);

export default defineConfig({
  plugins: [
    react(),
    {
      name: "visualize-page-sdk",
      resolveId(id) {
        if (id === "virtual:visualize-sdk") return "\0virtual:visualize-sdk";
      },
      async load(id) {
        if (id !== "\0virtual:visualize-sdk") return;
        const result = await build({
          configFile: false,
          logLevel: "error",
          build: {
            write: false,
            lib: {
              entry: fileURLToPath(new URL("../packages/protocol/src/index.ts", import.meta.url)),
              name: "VisualizeProtocol",
              formats: ["iife"],
            },
          },
        });
        const bundles = Array.isArray(result) ? result : [result];
        const chunk = bundles.flatMap(bundle => "output" in bundle ? bundle.output : []).find(output => output.type === "chunk");
        if (!chunk || chunk.type !== "chunk") throw new Error("Visualize SDK bundle is unavailable");
        return "export default " + JSON.stringify(chunk.code) + ";";
      },
    },
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
    // The iframe serializer consumes CSS as text, so this import must not be stubbed.
    css: { include: [/visualize-default\.css/] },
  },
});
