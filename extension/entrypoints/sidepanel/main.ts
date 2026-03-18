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
  if (!terminalFrame.contentWindow || !currentServerUrl) return;
  const origin = new URL(currentServerUrl).origin;
  terminalFrame.contentWindow.postMessage(
    { type: "browserbud:type-text", text },
    origin,
  );
}

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

// Listen for typeInTerminal messages from background/content scripts
browser.runtime.onMessage.addListener((message: { type: string; text?: string }) => {
  if (message.type === "typeInTerminal" && message.text) {
    typeInTerminal(message.text);
  }
});

// Init: load stored URL or show setup
(async () => {
  const serverUrl = await getServerUrl();
  if (serverUrl) {
    showTerminal(serverUrl);
  } else {
    showSetup();
  }
})();
