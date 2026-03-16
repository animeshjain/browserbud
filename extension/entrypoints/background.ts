export default defineBackground(() => {
  // Open the side panel when the extension icon is clicked
  chrome.action.onClicked.addListener(async (tab) => {
    if (tab.id != null) {
      await chrome.sidePanel.open({ tabId: tab.id });
    }
  });

  // Enable the side panel to open on action click
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});
