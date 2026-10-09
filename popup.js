const $ = id => document.getElementById(id);

const prompts = $("prompts");
const fileInput = $("fileInput");
const status = $("status");
const total = $("total");
const counter = $("counter");
const images = $("images");
const batch = $("batch");
const progress = $("progress");

function parse(text) {
  return text.split(/\r?\n/)
    .map(x => x.trim())
    .filter(Boolean);
}

function refresh() {
  chrome.storage.local.get(
    ["currentIndex", "total", "imageCount", "batchNumber", "status"],
    d => {
      const n = Number(d.total || 0);
      const i = Number(d.currentIndex || 0);

      total.textContent = n;
      counter.textContent = `${i} / ${n}`;
      images.textContent = Number(d.imageCount || 0);
      batch.textContent = n ? Number(d.batchNumber || 1) : "—";
      status.textContent = d.status || "Ready";
      progress.style.width = `${n ? Math.min(100, i / n * 100) : 0}%`;
    }
  );
}

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  prompts.value = await file.text();
  total.textContent = parse(prompts.value).length;
});

prompts.addEventListener("input", () => {
  total.textContent = parse(prompts.value).length;
});

$("start").addEventListener("click", async () => {
  const list = parse(prompts.value);

  if (!list.length) {
    status.textContent = "Add prompts first.";
    return;
  }

  chrome.tabs.query({active: true, currentWindow: true}, tabs => {
    const tab = tabs[0];

    if (!tab?.url?.startsWith("https://chatgpt.com/") &&
        !tab?.url?.startsWith("https://chat.openai.com/")) {
      status.textContent = "Open ChatGPT first.";
      return;
    }

    chrome.tabs.sendMessage(
      tab.id,
      {action: "START", prompts: list},
      () => {
        if (chrome.runtime.lastError) {
          status.textContent =
            "Refresh ChatGPT and try again.";
        }
      }
    );
  });
});

$("pause").addEventListener("click", () => {
  chrome.tabs.query({active: true, currentWindow: true}, tabs => {
    if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, {action: "PAUSE"});
  });
});

$("stop").addEventListener("click", () => {
  chrome.tabs.query({active: true, currentWindow: true}, tabs => {
    if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, {action: "STOP"});
  });
});

setInterval(refresh, 500);
refresh();
