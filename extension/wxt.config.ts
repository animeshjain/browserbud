import { defineConfig } from "wxt";

export default defineConfig({
  manifest: ({ browser }) => ({
    name: "BrowserBud",
    description: "AI terminal in your browser via Claude Code",
    version: "0.1.0",
    permissions: [
      "activeTab",
      "tabs",
      "storage",
      ...(browser === "chrome" ? ["sidePanel" as const] : []),
    ],
    host_permissions: ["<all_urls>"],
    action: {
      default_title: "Open BrowserBud",
    },
    web_accessible_resources: [
      {
        resources: ["youtube-player.js"],
        matches: ["*://*.youtube.com/*"],
      },
    ],
    // Chrome: side_panel manifest key
    ...(browser === "chrome" && {
      side_panel: {
        default_path: "sidepanel/index.html",
      },
    }),
    // Firefox: sidebar_action manifest key
    ...(browser === "firefox" && {
      sidebar_action: {
        default_panel: "sidepanel/index.html",
        default_title: "BrowserBud",
        open_at_install: false,
      },
    }),
  }),
});
