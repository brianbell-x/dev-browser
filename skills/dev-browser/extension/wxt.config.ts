import { defineConfig } from "wxt";

export default defineConfig({
  manifest: {
    name: "dev-browser",
    description: "Connect your browser to dev-browser for Playwright automation",
    permissions: ["debugger"],
    host_permissions: ["<all_urls>"],
    action: {
      default_title: "Click to attach debugger to this tab",
    },
  },
});
