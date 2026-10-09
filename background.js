const BRIDGE = "http://127.0.0.1:8765";

async function protectTab(tabId) {
  if (!tabId) return;
  try {
    await chrome.tabs.update(tabId, {autoDiscardable: false});
  } catch (_) {}
}

async function pingTab(tabId) {
  if (!tabId) return;
  try {
    await chrome.tabs.sendMessage(tabId, {
      action: "BACKGROUND_HEARTBEAT",
      ts: Date.now()
    });
  } catch (_) {}
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "REGISTER_CHATGPT_TAB") {
    const tabId = sender?.tab?.id;
    if (tabId) {
      protectTab(tabId);
      sendResponse({ok: true, tabId});
    } else {
      sendResponse({ok: false, error: "No sender tab."});
    }
    return true;
  }

  if (msg.action === "DOWNLOAD_IMAGE") {
    (async () => {
      try {
        if (!msg.url) throw new Error("Missing image data.");

        const filename = String(msg.filename || "1.png")
          .replace(/^[/\\]+/, "")
          .replace(/\.\.(?:[/\\]|$)/g, "");

        const id = await chrome.downloads.download({
          url: msg.url,
          filename,
          saveAs: false,
          conflictAction: "overwrite"
        });

        sendResponse({ok: true, downloadId: id});
      } catch (e) {
        sendResponse({ok: false, error: e?.message || String(e)});
      }
    })();
    return true;
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (
    tab?.url &&
    (tab.url.startsWith("https://chatgpt.com/") ||
     tab.url.startsWith("https://chat.openai.com/"))
  ) {
    protectTab(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  // No persistent state is required here. The content script owns the queue.
});

chrome.alarms.create("chatgpt-heartbeat", {periodInMinutes: 0.5});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "chatgpt-heartbeat") return;

  try {
    const tabs = await chrome.tabs.query({
      url: [
        "https://chatgpt.com/*",
        "https://chat.openai.com/*"
      ]
    });

    for (const tab of tabs) {
      await protectTab(tab.id);
      await pingTab(tab.id);
    }
  } catch (_) {}
});
