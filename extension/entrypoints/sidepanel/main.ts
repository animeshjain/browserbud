import { storage } from "wxt/utils/storage";

const SERVER_URL_KEY = "local:serverUrl";
const DEFAULT_URL = "http://localhost:8989";

const terminalFrame = document.getElementById("terminal-frame") as HTMLIFrameElement;
const setupScreen = document.getElementById("setup-screen") as HTMLDivElement;
const setupUrl = document.getElementById("setup-url") as HTMLInputElement;
const setupConnect = document.getElementById("setup-connect") as HTMLButtonElement;
const setupError = document.getElementById("setup-error") as HTMLDivElement;
const settingsBtn = document.getElementById("settings-btn") as HTMLButtonElement;
const settingsOverlay = document.getElementById("settings-overlay") as HTMLDivElement;
const settingsUrl = document.getElementById("settings-url") as HTMLInputElement;
const settingsSave = document.getElementById("settings-save") as HTMLButtonElement;
const settingsCancel = document.getElementById("settings-cancel") as HTMLButtonElement;
const helpBtn = document.getElementById("help-btn") as HTMLButtonElement;
const helpOverlay = document.getElementById("help-overlay") as HTMLDivElement;
const helpClose = document.getElementById("help-close") as HTMLButtonElement;

function normalizeUrl(raw: string): string {
  let url = raw.trim();
  if (url.endsWith("/")) url = url.slice(0, -1);
  return url;
}

async function getServerUrl(): Promise<string | null> {
  return storage.getItem<string>(SERVER_URL_KEY);
}

async function setServerUrl(url: string): Promise<void> {
  await storage.setItem<string>(SERVER_URL_KEY, url);
}

function showSetup() {
  terminalFrame.style.display = "none";
  setupScreen.style.display = "flex";
  setupUrl.focus();
}

// Track the current server URL for postMessage targeting
let currentServerUrl: string | null = null;

function postToTerminal(message: { type: "browserbud:type-text"; text: string }) {
  if (!terminalFrame.contentWindow || !currentServerUrl) return;
  const origin = new URL(currentServerUrl).origin;
  terminalFrame.contentWindow.postMessage(message, origin);
}

function showTerminal(url: string) {
  setupScreen.style.display = "none";
  terminalFrame.style.display = "block";
  currentServerUrl = url;
  if (terminalFrame.src !== url) {
    terminalFrame.src = url;
  }
}

// Type text into the Claude Code terminal via the injected bridge script
function typeInTerminal(text: string) {
  postToTerminal({ type: "browserbud:type-text", text });
}

// ─── Command WebSocket (bidirectional channel to server) ─────────────────────

let extensionSocket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let activeTabCapabilities: string[] = [];
let activeTabId: number | null = null;

function sendToServer(msg: Record<string, unknown>) {
  if (extensionSocket && extensionSocket.readyState === WebSocket.OPEN) {
    extensionSocket.send(JSON.stringify(msg));
  }
}

// Probe the content script on a tab for its capabilities
async function probeTabCapabilities(tabId: number): Promise<string[]> {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "getCapabilities" });
    return response?.capabilities || [];
  } catch {
    return []; // no content script on this tab
  }
}

async function connectExtensionWs() {
  if (!currentServerUrl) return;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

  // Close any existing socket before opening a new one
  if (extensionSocket) {
    const old = extensionSocket;
    extensionSocket = null;
    old.close();
  }

  const wsUrl = currentServerUrl.replace(/^http/, "ws") + "/ws/extension";

  try {
    const ws = new WebSocket(wsUrl);

    ws.addEventListener("open", async () => {
      console.log("BrowserBud: panel WebSocket connected");
      extensionSocket = ws;

      // Client-side heartbeat every 20s to keep connection alive
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ping" }));
        }
      }, 20000);

      // Send current tab context on connect
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id) {
          activeTabId = tab.id;
          activeTabCapabilities = await probeTabCapabilities(tab.id);
          sendToServer({
            type: "panel-hello",
            activeTabId: tab.id,
            activeTabUrl: tab.url,
            capabilities: activeTabCapabilities,
          });
        }
      } catch {}
    });

    ws.addEventListener("message", async (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "pong") return;
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
      if (extensionSocket !== ws) return; // stale socket, ignore
      console.log("BrowserBud: panel WebSocket disconnected, reconnecting in 3s...");
      extensionSocket = null;
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
      reconnectTimer = setTimeout(connectExtensionWs, 3000);
    });

    ws.addEventListener("error", (err) => {
      console.error("BrowserBud: panel WebSocket error", err);
    });
  } catch (err) {
    console.error("BrowserBud: panel WebSocket connection failed", err);
    reconnectTimer = setTimeout(connectExtensionWs, 3000);
  }
}

// ─── Command handlers (direct side panel → content script) ───────────────────

async function handleExtractTranscriptCommand(msg: {
  type: string;
  videoId: string;
  requestId: string;
}) {
  const { videoId, requestId } = msg;

  const tabs = await chrome.tabs.query({ url: "*://*.youtube.com/watch*" });
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

  try {
    await chrome.tabs.sendMessage(targetTabId, {
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

  const tabs = await chrome.tabs.query({ url: "*://*.youtube.com/watch*" });
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
    await chrome.tabs.sendMessage(targetTabId, {
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

  const tabs = await chrome.tabs.query({ url: "*://*.youtube.com/watch*" });
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
    await chrome.tabs.sendMessage(targetTabId, {
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
    // Use tracked activeTabId first, fall back to querying
    let tabId = activeTabId;
    let tabUrl: string | undefined;

    if (!tabId) {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs?.[0];
      if (!tab?.id) {
        sendToServer({
          type: "page-content-result",
          requestId,
          success: false,
          error: "No active tab found",
        });
        return;
      }
      tabId = tab.id;
      tabUrl = tab.url;
    }

    // Try content script first
    let result: { content: string; title: string; url: string } | null = null;
    try {
      result = await chrome.tabs.sendMessage(tabId, { type: "getPageContent" });
    } catch {
      // Content script not available — fall back to scripting API
    }

    if (!result) {
      try {
        const [injection] = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            const semantic = document.querySelector("article, main, [role='main']");
            if (semantic) {
              return {
                content: semantic.textContent?.trim() || "",
                title: document.title.trim(),
                url: window.location.href,
              };
            }
            const clone = document.body.cloneNode(true) as HTMLElement;
            for (const tag of ["script", "style", "nav", "header", "footer", "aside", "noscript"]) {
              for (const el of clone.querySelectorAll(tag)) el.remove();
            }
            return {
              content: clone.textContent?.trim() || "",
              title: document.title.trim(),
              url: window.location.href,
            };
          },
        });
        result = injection?.result ?? null;
      } catch (scriptErr) {
        sendToServer({
          type: "page-content-result",
          requestId,
          success: false,
          error: `Cannot extract content from this page (${tabUrl || "unknown URL"})`,
        });
        return;
      }
    }

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
        error: "No content extracted from page",
      });
    }
  } catch (err) {
    sendToServer({
      type: "page-content-result",
      requestId,
      success: false,
      error: `Page content extraction failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

// ─── UI event handlers ──────────────────────────────────────────────────────

// First-time setup
setupConnect.addEventListener("click", async () => {
  const url = normalizeUrl(setupUrl.value || DEFAULT_URL);
  setupError.textContent = "";

  try {
    const res = await fetch(`${url}/api/context`, { method: "GET" });
    if (!res.ok) throw new Error(`Server returned ${res.status}`);
  } catch {
    setupError.textContent = "Could not reach server. Is it running?";
    return;
  }

  await setServerUrl(url);
  showTerminal(url);
  connectExtensionWs();
});

setupUrl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") setupConnect.click();
});

// Settings modal
settingsBtn.addEventListener("click", async () => {
  const current = await getServerUrl();
  settingsUrl.value = current || DEFAULT_URL;
  settingsOverlay.classList.add("visible");
  settingsUrl.focus();
  settingsUrl.select();
});

settingsCancel.addEventListener("click", () => {
  settingsOverlay.classList.remove("visible");
});

settingsOverlay.addEventListener("click", (e) => {
  if (e.target === settingsOverlay) {
    settingsOverlay.classList.remove("visible");
  }
});

settingsSave.addEventListener("click", async () => {
  const url = normalizeUrl(settingsUrl.value || DEFAULT_URL);
  await setServerUrl(url);
  settingsOverlay.classList.remove("visible");
  showTerminal(url);
  connectExtensionWs();
});

settingsUrl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") settingsSave.click();
});

// Help modal
helpBtn.addEventListener("click", () => {
  helpOverlay.classList.add("visible");
});

helpClose.addEventListener("click", () => {
  helpOverlay.classList.remove("visible");
});

helpOverlay.addEventListener("click", (e) => {
  if (e.target === helpOverlay) {
    helpOverlay.classList.remove("visible");
  }
});

// ─── Message listener (results from content scripts + typeInTerminal) ────────

browser.runtime.onMessage.addListener((message: Record<string, any>, sender: any) => {
  if (message.type === "typeInTerminal" && message.text) {
    typeInTerminal(message.text);
  } else if (message.type === "transcriptResult") {
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
    const { type: _ignored, ...rest } = message;
    sendToServer({
      type: "player-state-result",
      ...rest,
    });
  } else if (message.type === "contentScriptReady") {
    // Only accept from the active tab (or if we haven't tracked one yet)
    if (activeTabId != null && sender.tab?.id !== activeTabId) return;
    activeTabCapabilities = message.capabilities || [];
    sendToServer({
      type: "session-update",
      capabilities: activeTabCapabilities,
      activeTabUrl: message.url,
    });
  }
});

// ─── Tab tracking ────────────────────────────────────────────────────────────

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  activeTabId = tabId;
  activeTabCapabilities = [];
  try {
    const tab = await chrome.tabs.get(tabId);
    activeTabCapabilities = await probeTabCapabilities(tabId);
    sendToServer({
      type: "session-update",
      activeTabId: tabId,
      activeTabUrl: tab.url,
      capabilities: activeTabCapabilities,
    });
  } catch {}
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    if (tab?.id && tab.id !== activeTabId) {
      activeTabId = tab.id;
      activeTabCapabilities = await probeTabCapabilities(tab.id);
      sendToServer({
        type: "session-update",
        activeTabId: tab.id,
        activeTabUrl: tab.url,
        capabilities: activeTabCapabilities,
      });
    }
  } catch {}
});

// ─── Init ────────────────────────────────────────────────────────────────────

(async () => {
  const serverUrl = await getServerUrl();
  if (serverUrl) {
    showTerminal(serverUrl);
    connectExtensionWs();
  } else {
    showSetup();
  }
})();
