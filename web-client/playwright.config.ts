import { defineConfig } from "@playwright/test";
const port = Number(process.env.WORKGRAPH_WEB_TEST_PORT ?? 5173);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw Error("Invalid WORKGRAPH_WEB_TEST_PORT");
const baseURL = "http://127.0.0.1:" + port;
const channel = process.env.WORKGRAPH_WEB_TEST_CHANNEL ?? "chrome";
if (channel !== "chrome" && channel !== "msedge")
  throw Error("Invalid WORKGRAPH_WEB_TEST_CHANNEL: expected chrome or msedge");
const preview = process.env.WORKGRAPH_WEB_TEST_PREVIEW === "1";
export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  use: {
    baseURL,
    channel,
    // Existing end-to-end scenarios assert the Simplified Chinese product copy.
    // English-base behavior is covered by the dedicated language-switcher suite.
    locale: "zh-CN",
    launchOptions: process.env.WORKGRAPH_WEB_TEST_EXECUTABLE
      ? { executablePath: process.env.WORKGRAPH_WEB_TEST_EXECUTABLE }
      : undefined,
    viewport: { width: 1440, height: 1000 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    // Preview consumes an existing build; never rebuild during parallel tests.
    command:
      "npm run " +
      (preview ? "preview" : "dev") +
      " -- --host 127.0.0.1 --port " +
      port +
      " --strictPort",
    url: baseURL,
    // Do not accidentally validate a dev server when static preview was requested.
    reuseExistingServer: !preview && !process.env.CI,
    timeout: 60000,
  },
});
