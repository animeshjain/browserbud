import { defineConfig } from "wxt";

export default defineConfig({
  manifest: {
    name: "BrowserBud",
    description: "AI terminal in your browser via Claude Code",
    version: "0.1.0",
    permissions: ["sidePanel", "activeTab"],
    action: {
      default_title: "Open BrowserBud",
    },
    side_panel: {
      default_path: "sidepanel/index.html",
    },
  },
});
