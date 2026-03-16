import { defineConfig } from "wxt";

export default defineConfig({
  manifest: {
    name: "BrowserBud",
    description: "AI terminal in your browser via Claude Code",
    version: "0.1.0",
    permissions: ["sidePanel", "activeTab", "tabs"],
    host_permissions: ["https://aj-sprite-lgk.sprites.app/*"],
    action: {
      default_title: "Open BrowserBud",
    },
    side_panel: {
      default_path: "sidepanel/index.html",
    },
  },
});
