import { storage } from "wxt/utils/storage";

const SERVER_URL_KEY = "local:serverUrl";
const DEFAULT_SERVER_URL = "http://localhost:8989";

const isChrome = !!globalThis.chrome?.sidePanel;

async function getServerUrl(): Promise<string> {
  const url = await storage.getItem<string>(SERVER_URL_KEY);
  return url || DEFAULT_SERVER_URL;
}

async function sendContext(data: Record<string, string>) {
  const serverUrl = await getServerUrl();
  fetch(`${serverUrl}/api/context`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  }).catch((err) => console.error("BrowserBud: failed to send context", err));
}

async function sendTranscript(data: {
  videoId: string;
  text: string;
  lang: string;
  meta: Record<string, string>;
  source: string;
}) {
  const serverUrl = await getServerUrl();
  fetch(`${serverUrl}/api/transcript`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  })
    .then((res) => res.json())
    .then((result) => {
      if (result.ok) {
        console.log(`BrowserBud: transcript cached for ${data.videoId}`);
      }
    })
    .catch((err) =>
      console.error("BrowserBud: failed to send transcript", err),
    );
}

async function sendFrame(videoId: string, timestamp: number, image: string) {
  const serverUrl = await getServerUrl();
  const res = await fetch(`${serverUrl}/api/frame`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videoId, timestamp, image }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST /api/frame failed (${res.status}): ${text}`);
  }
  const result = await res.json();
  if (!result.ok || !result.path) {
    throw new Error(`POST /api/frame unexpected response: ${JSON.stringify(result)}`);
  }
  console.log(`BrowserBud: frame saved to ${result.path}`);
  // Type the file reference into Claude Code's terminal input
  browser.runtime.sendMessage({
    type: "typeInTerminal",
    text: `@${result.path} `,
  });
}

// ─── Extension WebSocket (bidirectional command channel) ──────────────────

let extensionSocket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

async function connectExtensionWs() {
  const serverUrl = await getServerUrl();
  const wsUrl = serverUrl.replace(/^http/, "ws") + "/ws/extension";

  try {
    const ws = new WebSocket(wsUrl);

    ws.addEventListener("open", async () => {
      console.log("BrowserBud: WebSocket connected to server");
      extensionSocket = ws;
      // Send current tab's context so the server has it immediately
      try {
        const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
        if (tab?.id) {
          const ctx = await browser.tabs.sendMessage(tab.id, { type: "getContext" });
          if (ctx) sendContext(ctx);
        }
      } catch {}
    });

    ws.addEventListener("message", async (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "extract-transcript") {
          await handleExtractTranscriptCommand(msg);
        } else if (msg.type === "extract-comments") {
          await handleExtractCommentsCommand(msg);
        } else if (msg.type === "get-player-state") {
          await handleGetPlayerStateCommand(msg);
        } else if (msg.type === "get-page-content") {
          await handleGetPageContentCommand(msg);
        }
      } catch (err) {
        console.error("BrowserBud: WebSocket message error", err);
      }
    });

    ws.addEventListener("close", () => {
      console.log("BrowserBud: WebSocket disconnected, reconnecting in 3s...");
      extensionSocket = null;
      reconnectTimer = setTimeout(connectExtensionWs, 3000);
    });

    ws.addEventListener("error", (err) => {
      console.error("BrowserBud: WebSocket error", err);
    });
  } catch (err) {
    console.error("BrowserBud: WebSocket connection failed", err);
    reconnectTimer = setTimeout(connectExtensionWs, 3000);
  }
}

async function handleExtractTranscriptCommand(msg: {
  type: string;
  videoId: string;
  requestId: string;
}) {
  const { videoId, requestId } = msg;

  // Find a YouTube tab with this video
  const tabs = await browser.tabs.query({ url: "*://*.youtube.com/watch*" });
  let targetTabId: number | null = null;

  for (const tab of tabs) {
    if (tab.id != null && tab.url?.includes(`v=${videoId}`)) {
      targetTabId = tab.id;
      break;
    }
  }

  if (targetTabId == null) {
    sendToServer({
      type: "extract-transcript-result",
      requestId,
      success: false,
      error: `Video ${videoId} not open in any tab`,
    });
    return;
  }

  // Forward to the content script on that tab
  try {
    await browser.tabs.sendMessage(targetTabId, {
      type: "extractTranscript",
      videoId,
      requestId,
    });
  } catch (err) {
    sendToServer({
      type: "extract-transcript-result",
      requestId,
      success: false,
      error: `Failed to reach content script: ${err}`,
    });
  }
}

async function handleExtractCommentsCommand(msg: {
  type: string;
  videoId: string;
  requestId: string;
  maxComments?: number;
  includeReplies?: boolean;
  minLikesForReplies?: number;
  minRepliesForReplies?: number;
}) {
  const { videoId, requestId } = msg;

  const tabs = await browser.tabs.query({ url: "*://*.youtube.com/watch*" });
  let targetTabId: number | null = null;

  for (const tab of tabs) {
    if (tab.id != null && tab.url?.includes(`v=${videoId}`)) {
      targetTabId = tab.id;
      break;
    }
  }

  if (targetTabId == null) {
    sendToServer({
      type: "extract-comments-result",
      requestId,
      success: false,
      error: `Video ${videoId} not open in any tab`,
    });
    return;
  }

  try {
    await browser.tabs.sendMessage(targetTabId, {
      type: "extractComments",
      videoId,
      requestId,
      maxComments: msg.maxComments,
      includeReplies: msg.includeReplies,
      minLikesForReplies: msg.minLikesForReplies,
      minRepliesForReplies: msg.minRepliesForReplies,
    });
  } catch (err) {
    sendToServer({
      type: "extract-comments-result",
      requestId,
      success: false,
      error: `Failed to reach content script: ${err}`,
    });
  }
}

async function handleGetPlayerStateCommand(msg: {
  type: string;
  videoId: string;
  requestId: string;
}) {
  const { videoId, requestId } = msg;

  const tabs = await browser.tabs.query({ url: "*://*.youtube.com/watch*" });
  let targetTabId: number | null = null;

  for (const tab of tabs) {
    if (tab.id != null && tab.url?.includes(`v=${videoId}`)) {
      targetTabId = tab.id;
      break;
    }
  }

  if (targetTabId == null) {
    sendToServer({
      type: "player-state-result",
      requestId,
      success: false,
      error: `Video ${videoId} not open in any tab`,
    });
    return;
  }

  try {
    await browser.tabs.sendMessage(targetTabId, {
      type: "getPlayerState",
      requestId,
    });
  } catch (err) {
    sendToServer({
      type: "player-state-result",
      requestId,
      success: false,
      error: `Failed to reach content script: ${err}`,
    });
  }
}

async function handleGetPageContentCommand(msg: {
  type: string;
  requestId: string;
}) {
  const { requestId } = msg;

  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      sendToServer({
        type: "page-content-result",
        requestId,
        success: false,
        error: "No active tab found",
      });
      return;
    }

    const result = await browser.tabs.sendMessage(tab.id, {
      type: "getPageContent",
    });

    if (result) {
      sendToServer({
        type: "page-content-result",
        requestId,
        success: true,
        content: result.content,
        title: result.title,
        url: result.url,
      });
    } else {
      sendToServer({
        type: "page-content-result",
        requestId,
        success: false,
        error: "No response from content script",
      });
    }
  } catch (err) {
    sendToServer({
      type: "page-content-result",
      requestId,
      success: false,
      error: `Failed to reach content script: ${err}`,
    });
  }
}

function sendToServer(msg: Record<string, any>) {
  if (extensionSocket && extensionSocket.readyState === WebSocket.OPEN) {
    extensionSocket.send(JSON.stringify(msg));
  }
}

export default defineBackground(() => {
  if (isChrome) {
    // Chrome: clicking the action icon toggles the side panel per-tab.
    // Chrome's sidePanel API already handles per-tab visibility natively.
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } else {
    // Firefox MV2: browserAction (not action) + sidebarAction
    browser.browserAction.onClicked.addListener(() => {
      browser.sidebarAction.toggle();
    });
  }

  // Forward context, transcript, and frame data from content scripts to the server
  browser.runtime.onMessage.addListener((message) => {
    if (message.type === "context") {
      sendContext(message.data);
    } else if (message.type === "transcript") {
      sendTranscript({
        videoId: message.videoId,
        text: message.text,
        lang: message.lang,
        meta: message.meta,
        source: message.source,
      });
    } else if (message.type === "captureFrame") {
      sendFrame(message.videoId, message.timestamp, message.image);
    } else if (message.type === "transcriptResult") {
      // Forward extraction result back to server via WebSocket
      sendToServer({
        type: "extract-transcript-result",
        requestId: message.requestId,
        success: message.success,
        text: message.text,
        lang: message.lang,
        meta: message.meta,
        error: message.error,
      });
    } else if (message.type === "commentsResult") {
      // Forward comment extraction result back to server via WebSocket
      sendToServer({
        type: "extract-comments-result",
        requestId: message.requestId,
        success: message.success,
        comments: message.comments,
        totalCount: message.totalCount,
        meta: message.meta,
        error: message.error,
      });
    } else if (message.type === "playerStateResult") {
      // Forward player state result back to server via WebSocket
      const { type: _ignored, ...rest } = message;
      sendToServer({
        type: "player-state-result",
        ...rest,
      });
    }
  });

  // Shared helper: query the active tab's content script for context
  async function refreshContextForTab(tabId: number) {
    try {
      const response = await browser.tabs.sendMessage(tabId, {
        type: "getContext",
      });
      if (response) {
        sendContext(response);
      }
    } catch {
      // No content script on this tab — clear context
      sendContext({});
    }
  }

  // When the user switches tabs, update context
  browser.tabs.onActivated.addListener(async ({ tabId }) => {
    refreshContextForTab(tabId);
  });

  // When a browser window gains focus, update context for its active tab
  // (handles switching between browser windows or returning from another app)
  browser.windows.onFocusChanged.addListener(async (windowId) => {
    if (windowId === browser.windows.WINDOW_ID_NONE) return;
    const [tab] = await browser.tabs.query({ active: true, windowId });
    if (tab?.id) {
      refreshContextForTab(tab.id);
    }
  });

  // Start the bidirectional WebSocket connection to the server
  connectExtensionWs();
});
