import { storage } from "wxt/utils/storage";

const SERVER_URL_KEY = "local:serverUrl";
const DEFAULT_URL = "http://localhost:8989";

const terminalFrame = document.getElementById("terminal-frame") as HTMLIFrameElement;
const setupScreen = document.getElementById("setup-screen") as HTMLDivElement;
const setupUrl = document.getElementById("setup-url") as HTMLInputElement;
const setupConnect = document.getElementById("setup-connect") as HTMLButtonElement;
const setupError = document.getElementById("setup-error") as HTMLDivElement;
const summarizeBtn = document.getElementById("summarize-btn") as HTMLButtonElement;
const settingsBtn = document.getElementById("settings-btn") as HTMLButtonElement;
const settingsOverlay = document.getElementById("settings-overlay") as HTMLDivElement;
const settingsUrl = document.getElementById("settings-url") as HTMLInputElement;
const settingsSave = document.getElementById("settings-save") as HTMLButtonElement;
const settingsCancel = document.getElementById("settings-cancel") as HTMLButtonElement;
const clearBtn = document.getElementById("clear-btn") as HTMLButtonElement;
const helpBtn = document.getElementById("help-btn") as HTMLButtonElement;
const helpOverlay = document.getElementById("help-overlay") as HTMLDivElement;
const helpClose = document.getElementById("help-close") as HTMLButtonElement;
const authOverlay = document.getElementById("auth-overlay") as HTMLDivElement;
const authLink = document.getElementById("auth-link") as HTMLAnchorElement;
const authTokenInput = document.getElementById("auth-token-input") as HTMLInputElement;
const authSubmit = document.getElementById("auth-submit") as HTMLButtonElement;
const authDismiss = document.getElementById("auth-dismiss") as HTMLButtonElement;

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
    const response = await browser.tabs.sendMessage(tabId, { type: "getCapabilities" });
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
        const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
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
    // Use tracked activeTabId first, fall back to querying
    let tabId = activeTabId;
    let tabUrl: string | undefined;

    if (!tabId) {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
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

    // Try content script first (returns pruned HTML)
    let result: { html: string; title: string; url: string } | null = null;
    try {
      result = await browser.tabs.sendMessage(tabId, { type: "getPageContent" });
    } catch {
      // Content script not available — fall back to scripting API
    }

    if (!result) {
      try {
        // Inline DOM pruning — same logic as extract-page.ts but self-contained
        // for the executeScript context (can't import modules).
        const [injection] = await browser.scripting.executeScript({
          target: { tabId },
          func: () => {
            const REMOVE_TAGS = ["script", "style", "noscript", "svg", "link", "meta", "iframe"];
            const KEEP_ATTRS = new Set(["href", "src", "alt", "role", "data-testid", "aria-label", "dir", "lang"]);

            const root =
              document.querySelector("main") ||
              document.querySelector("[role='main']") ||
              document.body;

            const clone = root.cloneNode(true) as Element;

            for (const tag of REMOVE_TAGS) {
              clone.querySelectorAll(tag).forEach((el) => el.remove());
            }
            clone.querySelectorAll('[aria-hidden="true"], [hidden]').forEach((el) => el.remove());

            for (const el of clone.querySelectorAll("*")) {
              for (const attr of [...el.attributes]) {
                if (!KEEP_ATTRS.has(attr.name)) el.removeAttribute(attr.name);
              }
            }

            for (const a of clone.querySelectorAll("a")) {
              const text = a.textContent?.trim();
              if (text) {
                while (a.firstChild) a.removeChild(a.firstChild);
                a.appendChild(document.createTextNode(text));
              }
            }

            (function removeEmpties(el: Element) {
              for (const child of [...el.children]) removeEmpties(child);
              if (!el.textContent?.trim() && !el.querySelector("img, video, audio") && el !== clone) {
                el.remove();
              }
            })(clone);

            return {
              html: clone.innerHTML,
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
        html: result.html,
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

// Clear button — sends /clear to Claude Code
clearBtn.addEventListener("click", () => {
  typeInTerminal("/clear\r");
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

// ─── Auth modal (from terminal bridge via postMessage) ───────────────────────

// Track the last auth URL to avoid showing duplicates
let lastAuthUrl = "";
let authSuppressUntil = 0;

window.addEventListener("message", (event) => {
  if (!event.data || event.data.type !== "browserbud:auth-url") return;
  const url = event.data.url;
  if (!url || url === lastAuthUrl) return;
  if (Date.now() < authSuppressUntil) return;
  lastAuthUrl = url;
  authLink.href = url;
  authTokenInput.value = "";
  authOverlay.classList.add("visible");
});

authDismiss.addEventListener("click", () => {
  authOverlay.classList.remove("visible");
});

authOverlay.addEventListener("click", (e) => {
  if (e.target === authOverlay) {
    authOverlay.classList.remove("visible");
  }
});

authSubmit.addEventListener("click", () => {
  const token = authTokenInput.value.trim();
  if (!token) return;
  typeInTerminal(token + "\r");
  authOverlay.classList.remove("visible");
  authTokenInput.value = "";
  // Suppress re-detection for a few seconds while auth completes
  authSuppressUntil = Date.now() + 5000;
});

authTokenInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") authSubmit.click();
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

browser.tabs.onActivated.addListener(async ({ tabId }) => {
  activeTabId = tabId;
  activeTabCapabilities = [];
  try {
    const tab = await browser.tabs.get(tabId);
    activeTabCapabilities = await probeTabCapabilities(tabId);
    sendToServer({
      type: "session-update",
      activeTabId: tabId,
      activeTabUrl: tab.url,
      capabilities: activeTabCapabilities,
    });
  } catch {}
});

browser.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === browser.windows.WINDOW_ID_NONE) return;
  try {
    const [tab] = await browser.tabs.query({ active: true, windowId });
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

// ─── Summarize Button ────────────────────────────────────────────────────────

type PageMode = "youtube" | "web" | "unsupported";
let currentPageMode: PageMode = "unsupported";
let currentPageUrl: string | null = null;
let currentVideoId: string | null = null;
let cacheCheckTimer: ReturnType<typeof setInterval> | null = null;

function extractVideoId(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtube.com") && u.pathname === "/watch") {
      return u.searchParams.get("v");
    }
  } catch {}
  return null;
}

async function checkTranscriptCached(videoId: string): Promise<boolean> {
  if (!currentServerUrl) return false;
  try {
    const res = await fetch(`${currentServerUrl}/api/transcript-status/${videoId}`);
    if (!res.ok) return false;
    const data = await res.json();
    return !!data.cached;
  } catch {
    return false;
  }
}

function updateYoutubeSummarize(videoId: string | null) {
  if (cacheCheckTimer) { clearInterval(cacheCheckTimer); cacheCheckTimer = null; }

  if (!videoId) {
    currentVideoId = null;
    summarizeBtn.disabled = true;
    return;
  }

  currentVideoId = videoId;
  summarizeBtn.disabled = true; // disabled until we confirm cache

  const vid = videoId; // capture for closure (non-null)

  // Check immediately, then poll every 2s until cached
  async function poll() {
    if (currentVideoId !== vid) return; // stale
    const cached = await checkTranscriptCached(vid);
    if (currentVideoId !== vid) return; // stale
    if (cached) {
      summarizeBtn.disabled = false;
      if (cacheCheckTimer) { clearInterval(cacheCheckTimer); cacheCheckTimer = null; }
    }
  }

  poll();
  cacheCheckTimer = setInterval(poll, 2000);
}

function updateSummarizeForTab(url: string | undefined) {
  if (cacheCheckTimer) { clearInterval(cacheCheckTimer); cacheCheckTimer = null; }

  if (!url) {
    currentPageMode = "unsupported";
    currentVideoId = null;
    currentPageUrl = null;
    summarizeBtn.disabled = true;
    summarizeBtn.title = "Summarize";
    return;
  }

  const videoId = extractVideoId(url);
  if (videoId) {
    currentPageMode = "youtube";
    currentPageUrl = url;
    summarizeBtn.title = "Summarize this video";
    updateYoutubeSummarize(videoId);
  } else if (url.startsWith("http://") || url.startsWith("https://")) {
    currentPageMode = "web";
    currentVideoId = null;
    currentPageUrl = url;
    summarizeBtn.disabled = false;
    summarizeBtn.title = "Summarize this page";
  } else {
    currentPageMode = "unsupported";
    currentVideoId = null;
    currentPageUrl = null;
    summarizeBtn.disabled = true;
    summarizeBtn.title = "Summarize";
  }
}

const summarizeBtnDefaultHTML = summarizeBtn.innerHTML;

async function handleWebPageSummarize(url: string) {
  if (!currentServerUrl) return;

  // Show loading state
  summarizeBtn.disabled = true;
  summarizeBtn.innerHTML = "<span>Caching\u2026</span>";

  try {
    const res = await fetch(`${currentServerUrl}/api/cache-page`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      console.error("BrowserBud: cache page failed:", (data as any).error || res.status);
      return;
    }

    const data = await res.json() as { ok: boolean; url?: string; error?: string };
    if (data.ok && data.url) {
      typeInTerminal(`/page-reader Summarize this page: ${data.url}\r`);
    }
  } catch (err) {
    console.error("BrowserBud: cache page error:", err);
  } finally {
    summarizeBtn.innerHTML = summarizeBtnDefaultHTML;
    summarizeBtn.disabled = false;
  }
}

summarizeBtn.addEventListener("click", async () => {
  if (summarizeBtn.disabled) return;

  if (currentPageMode === "youtube" && currentVideoId) {
    typeInTerminal(`/yt-research Summarize this video: https://www.youtube.com/watch?v=${currentVideoId}\r`);
  } else if (currentPageMode === "web" && currentPageUrl) {
    await handleWebPageSummarize(currentPageUrl);
  }
});

// Update summarize button when active tab changes
browser.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await browser.tabs.get(tabId);
    updateSummarizeForTab(tab.url);
  } catch {}
});

// Also pick up URL changes within the same tab (SPA navigation, etc.)
browser.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (!tab.active || !changeInfo.url) return;
  updateSummarizeForTab(changeInfo.url);
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

  // Initialize summarize button for current tab
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab?.url) {
      updateSummarizeForTab(tab.url);
    }
  } catch {}
})();
