(() => {
  "use strict";

  const BATCH_SIZE = 9;
  const BRIDGE = "http://127.0.0.1:8765";

  // Delays are intentionally short. ChatGPT generation itself is the
  // dominant wait; the extension does not add unnecessary multi-second waits.
  const POLL_MS = 500;
  // Give ChatGPT a full 30 seconds to finish loading before the master job
  // is accepted. This prevents images from the previous conversation state
  // from being mistaken for the current run.
  const INITIAL_PAGE_LOAD_WAIT_MS = 30000;
  const IMAGE_STABLE_MS = 900;
  const COMPOSER_TIMEOUT = 180000;
  const IMAGE_TIMEOUT = 15 * 60 * 1000;

  let prompts = [];
  let index = 0;
  let running = false;
  let paused = false;
  let processing = false;
  let activeJobId = null;
  let downloadFolder = "";
  // Keep recent prompt descriptions as a lightweight visual-continuity
  // reference for recurring characters across collage batches.
  let continuityReference = [];
  let bridgeReady = false;

  console.log("ChatGPT-Prompt-Automator 5.1 loaded");

  // Tell the extension service worker which ChatGPT tab owns the queue.
  // The service worker then marks this tab autoDiscardable=false and
  // periodically pings it while the user works in another tab.
  try {
    chrome.runtime.sendMessage({action: "REGISTER_CHATGPT_TAB"});
  } catch (_) {}

  let lastHeartbeat = Date.now();


  // ------------------------------------------------------------
  // Bridge: automatically receive jobs from master_pipeline.py
  // ------------------------------------------------------------

  async function bridgeLoop() {
    // IMPORTANT: wait once after the ChatGPT page loads.
    // Do not accept a master job immediately while the old conversation/images
    // are still being restored by ChatGPT.
    await sleep(INITIAL_PAGE_LOAD_WAIT_MS);
    bridgeReady = true;

    while (true) {
      try {
        if (bridgeReady && !running && !activeJobId) {
          const response = await fetch(`${BRIDGE}/job?ts=${Date.now()}`, {
            cache: "no-store"
          });

          if (response.ok) {
            const data = await response.json();

            if (data.available && data.job) {
              const job = data.job;

              activeJobId = job.jobId;
              prompts = Array.isArray(job.prompts)
                ? job.prompts.map(String).map(x => x.trim()).filter(Boolean)
                : [];

              index = 0;
              downloadFolder = String(job.downloadFolder || "");
              continuityReference = [];
              running = prompts.length > 0;
              paused = false;

              await saveState(
                running
                  ? `Received ${prompts.length} prompts — starting automatically`
                  : "ERROR: Master sent no prompts"
              );

              // Acknowledge only after the job has been copied locally.
              try {
                await fetch(`${BRIDGE}/ack`, {
                  method: "POST",
                  headers: {"Content-Type": "application/json"},
                  body: JSON.stringify({jobId: job.jobId})
                });
              } catch (_) {}

              if (running) {
                runQueue();
              }
            }
          }
        }
      } catch (_) {}

      await sleep(1000);
    }
  }

  bridgeLoop();

  // ------------------------------------------------------------
  // Background-tab heartbeat
  // ------------------------------------------------------------
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.action === "BACKGROUND_HEARTBEAT") {
      lastHeartbeat = Date.now();

      // Force a lightweight layout read. This does not activate the tab,
      // but helps ensure the content script remains attached and responsive.
      try {
        void document.documentElement?.scrollHeight;
      } catch (_) {}
    }
  });

  // ------------------------------------------------------------
  // Popup/manual control support
  // ------------------------------------------------------------

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === "START") {
      prompts = Array.isArray(msg.prompts)
        ? msg.prompts.map(String).map(x => x.trim()).filter(Boolean)
        : [];

      index = 0;
      running = prompts.length > 0;
      paused = false;
      processing = false;
      activeJobId = `manual-${Date.now()}`;
      downloadFolder = "";
      continuityReference = [];

      saveState(`Started ${prompts.length} prompts`);

      if (running) runQueue();

      sendResponse({
        message: running
          ? `Started ${prompts.length} prompts`
          : "No prompts"
      });
      return true;
    }

    if (msg.action === "PAUSE") {
      paused = true;
      saveState("Paused");
    }

    if (msg.action === "STOP") {
      running = false;
      paused = false;
      processing = false;
      activeJobId = null;
      saveState("Stopped");
    }
  });

  // ------------------------------------------------------------
  // Main queue
  // ------------------------------------------------------------

  async function runQueue() {
    if (processing || !running) return;

    processing = true;

    try {
      const totalBatches = Math.ceil(prompts.length / BATCH_SIZE);

      while (running && index < prompts.length) {
        while (paused && running) await sleep(300);
        if (!running) return;

        const start = index;
        const end = Math.min(start + BATCH_SIZE, prompts.length);
        const batchNumber = Math.floor(start / BATCH_SIZE) + 1;
        const batch = prompts.slice(start, end);

        await saveState(
          `Batch ${batchNumber}/${totalBatches}: ${start + 1}-${end}`
        );

        // This is the critical protection:
        // remember the actual image DOM elements before sending.
        // Old images can NEVER be accepted later, even if their URL changes.
        // Snapshot BOTH DOM image elements and their URLs.
        // ChatGPT can re-render old messages, creating brand-new <img>
        // elements for OLD images. URL fingerprinting prevents those clones
        // from ever being downloaded as the current batch.
        const oldImages = new Set(document.images);
        const oldImageUrls = new Set(
          [...document.images]
            .map(imageUrl)
            .filter(Boolean)
        );

        const composer = await waitForComposer();
        if (!composer) {
          throw new Error("ChatGPT composer not found.");
        }

        await putText(composer, makePrompt(batch, continuityReference));

        // Very short React settling time.
        await sleep(250);

        const sent = await send(composer);
        if (!sent) {
          throw new Error(`Could not send batch ${batchNumber}.`);
        }

        await saveState(
          `Batch ${batchNumber}/${totalBatches} sent — waiting for NEW image`
        );

        // Wait ONLY for an image element created after this send.
        const image = await waitForNewImage(
          oldImages,
          oldImageUrls,
          IMAGE_TIMEOUT
        );

        if (!image) {
          throw new Error(
            `No NEW generated image detected for batch ${batchNumber}.`
          );
        }

        // One final short stability check.
        const stable = await confirmStable(image);
        if (!stable) {
          throw new Error(
            `Generated image for batch ${batchNumber} changed before download.`
          );
        }

        await saveState(
          `Batch ${batchNumber}/${totalBatches}: downloading NEW image ${batchNumber}.png`
        );

        const filename = `${downloadFolder
          ? downloadFolder.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "") + "/"
          : ""}${batchNumber}.png`;

        await downloadImage(image, filename);

        index = end;

        // Preserve the latest scene descriptions so recurring characters
        // have a textual continuity reference in the next batch. Keep only
        // the most recent 12 prompts to avoid making prompts unnecessarily huge.
        continuityReference = [
          ...continuityReference,
          ...batch
        ].slice(-12);

        await saveState(
          `Saved ${batchNumber}.png — ${index}/${prompts.length} prompts complete`
        );

        // Do not add an arbitrary 5–10 second delay.
        // Wait only until the composer is actually available.
        if (index < prompts.length) {
          await waitForComposer();
        }
      }

      if (index >= prompts.length) {
        running = false;
        paused = false;

        await saveState(
          `COMPLETED — ${Math.ceil(prompts.length / BATCH_SIZE)} collage images downloaded`
        );

        activeJobId = null;
      }
    } catch (e) {
      console.error("PromptFlow:", e);

      running = false;
      paused = false;

      await saveState(`ERROR: ${e?.message || String(e)}`);

      activeJobId = null;
    } finally {
      processing = false;
    }
  }

  // ------------------------------------------------------------
  // Collage prompt
  // ------------------------------------------------------------

  function makePrompt(batch, continuity = []) {
    const n = batch.length;

    let layout;
    if (n === 9) layout = "3 columns by 3 rows";
    else if (n === 5) layout = "3 columns by 2 rows with one empty panel";
    else if (n === 4) layout = "2 columns by 2 rows";
    else if (n === 3) layout = "3 columns by 1 row";
    else if (n === 2) layout = "2 columns by 1 row";
    else layout = "one panel";

    let text =
`Create ONE single image containing exactly ${n} separate visual scenes arranged as a clean ${layout} collage.

STRICT REQUIREMENTS:

- IMAGE QUALITY & PROMPT ACCURACY — VERY IMPORTANT:
  - Every panel must look like a clean, finished, normal high-quality image: crystal clear, sharp, high-resolution, and fully detailed.
  - Generate each panel exactly according to its corresponding prompt description.
  - Do not change, reinterpret, add, remove, or replace any described character, object, action, environment, clothing, pose, composition, or other detail.
  - Follow the prompt description precisely while maintaining maximum visual clarity, clean edges, accurate anatomy, and fine detail.
  - Do NOT add random symbols, glyphs, strange markings, abstract patterns, scribbles, repeated textures, visual noise, distortion, glitches, artifacts, or unexplained objects.
  - Do NOT place any decorative symbols or meaningless marks over the characters, faces, objects, backgrounds, or scenery.
  - Each panel must be visually coherent and clean from edge to edge, with no accidental overlays or generated artifacts.
  - Keep important subjects, faces, objects, and details clearly recognizable and unobstructed.
- ONE image output only.
- Exactly one panel for each prompt.
- Preserve prompt order exactly.
- Do not merge prompts.
- Do not omit prompts.
- No captions, labels, numbers, speech bubbles, watermarks, or readable text.
- Every panel must be clearly visible and separated.
- Use the full canvas efficiently.

CHARACTER CONSISTENCY — VERY IMPORTANT:
- Treat every recurring named character as a LOCKED character identity.
- If the same character appears in multiple panels or batches, keep the SAME face, facial proportions, skin tone, hairstyle, hair color, eye color, age, body type, and distinctive features.
- Keep the character's clothing, armor, accessories, and signature colors consistent unless a prompt explicitly says they changed.
- Do not redesign, age, de-age, or randomly change recurring characters between panels.
- Use the first clear description of a recurring character as the canonical appearance and preserve it in later panels.
- Keep recurring characters visually recognizable even when the scene, pose, camera angle, lighting, or background changes.
- Prioritize character identity consistency over unnecessary stylistic variation.
- Maintain the same overall cinematic visual style, lighting language, anatomy quality, and level of detail across all panels.

PROMPTS:
`;

    if (continuity.length) {
      text += `\nCONTINUITY REFERENCE — PREVIOUS SCENE DESCRIPTIONS (REFERENCE ONLY):\n`;
      continuity.forEach((p, i) => {
        text += `\nREFERENCE ${i + 1}: ${p}\n`;
      });
      text += `\nUse these previous descriptions only to preserve recurring character identity and visual style. Do NOT create extra panels from the reference scenes.\n`;
    }

    batch.forEach((p, i) => {
      text += `\nPANEL ${i + 1}:\n${p}\n`;
    });

    return text;
  }

  // ------------------------------------------------------------
  // Composer
  // ------------------------------------------------------------

  async function waitForComposer() {
    const started = Date.now();

    while (running && Date.now() - started < COMPOSER_TIMEOUT) {
      const box = findComposer();

      if (box && !box.disabled && !box.readOnly) {
        return box;
      }

      await sleep(POLL_MS);
    }

    return findComposer();
  }

  function findComposer() {
    const selectors = [
      "#prompt-textarea",
      "textarea",
      "[contenteditable='true']"
    ];

    for (const selector of selectors) {
      const nodes = document.querySelectorAll(selector);

      for (const node of nodes) {
        if (
          node.offsetParent !== null &&
          !node.disabled &&
          !node.readOnly
        ) {
          return node;
        }
      }
    }

    return null;
  }

  async function putText(box, text) {
    box.focus();

    if (box.tagName === "TEXTAREA") {
      const setter =
        Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value"
        )?.set;

      if (setter) setter.call(box, text);
      else box.value = text;

      box.dispatchEvent(new Event("input", {bubbles: true}));
      box.dispatchEvent(new Event("change", {bubbles: true}));
      return;
    }

    // React contenteditable.
    document.execCommand("selectAll", false, null);
    document.execCommand("insertText", false, text);

    box.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: text
    }));
  }

  async function send(box) {
    box.focus();

    const button = findSendButton();

    if (button) {
      button.click();

      // Confirm the composer cleared or generation started.
      for (let i = 0; i < 16; i++) {
        await sleep(250);

        if (
          composerEmpty(box) ||
          generationStarted()
        ) {
          return true;
        }
      }

      // One retry only.
      const retry = findSendButton();

      if (retry) {
        retry.click();

        for (let i = 0; i < 16; i++) {
          await sleep(250);

          if (
            composerEmpty(box) ||
            generationStarted()
          ) {
            return true;
          }
        }
      }
    }

    // Keyboard fallback.
    box.focus();

    box.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true
    }));

    await sleep(500);

    return composerEmpty(box) || generationStarted();
  }

  function findSendButton() {
    const buttons = [...document.querySelectorAll("button")];

    return buttons.find(button => {
      if (button.offsetParent === null || button.disabled) return false;

      const aria = (
        button.getAttribute("aria-label") || ""
      ).toLowerCase();

      const title = (
        button.getAttribute("title") || ""
      ).toLowerCase();

      return aria.includes("send") || title.includes("send");
    });
  }

  function generationStarted() {
    return [...document.querySelectorAll("button")].some(button => {
      if (button.offsetParent === null) return false;

      const text = (
        button.getAttribute("aria-label") || ""
      ).toLowerCase();

      const title = (
        button.getAttribute("title") || ""
      ).toLowerCase();

      return (
        text === "stop" ||
        text.includes("stop generating") ||
        title.includes("stop generating")
      );
    });
  }

  function composerEmpty(box) {
    if (!box) return false;

    if (box.tagName === "TEXTAREA") {
      return !box.value.trim();
    }

    return !(
      box.innerText ||
      box.textContent ||
      ""
    ).trim();
  }

  // ------------------------------------------------------------
  // NEW IMAGE DETECTION
  // ------------------------------------------------------------

  async function waitForNewImage(oldImages, oldImageUrls, timeout) {
    const started = Date.now();

    return new Promise(resolve => {
      let done = false;
      let candidate = null;
      let candidateUrl = null;
      let stableSince = 0;

      function finish(value) {
        if (done) return;
        done = true;
        observer.disconnect();
        clearInterval(timer);
        clearTimeout(timeoutTimer);
        resolve(value);
      }

      function check() {
        if (!running) {
          finish(null);
          return;
        }

        if (Date.now() - started > timeout) {
          finish(null);
          return;
        }

        const candidates = [];

        for (const img of document.images) {
          // Reject anything that existed before the current batch.
          if (oldImages.has(img)) continue;

          if (!usableImage(img)) continue;

          // IMPORTANT: ChatGPT may rebuild old message DOM nodes. In that
          // case the <img> element is new but the image URL is old. Reject it.
          const url = imageUrl(img);
          if (oldImageUrls.has(url)) continue;

          candidates.push(img);
        }

        if (!candidates.length) return;

        // Prefer the largest NEW image.
        candidates.sort(
          (a, b) => imageArea(b) - imageArea(a)
        );

        const best = candidates[0];
        const url = imageUrl(best);

        if (candidate !== best) {
          candidate = best;
          candidateUrl = url;
          stableSince = Date.now();
          return;
        }

        if (url !== candidateUrl) {
          candidateUrl = url;
          stableSince = Date.now();
          return;
        }

        if (Date.now() - stableSince >= IMAGE_STABLE_MS) {
          finish(best);
        }
      }

      const observer = new MutationObserver(check);

      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["src", "srcset", "style", "class"]
      });

      // Keep polling even when the ChatGPT tab is not visible.
      // Chrome may reduce timer frequency in background tabs, so the
      // observer + polling combination is intentionally redundant.
      const timer = setInterval(check, POLL_MS);

      const timeoutTimer = setTimeout(
        () => finish(null),
        timeout + 1000
      );

      check();
    });
  }

  function usableImage(img) {
    if (!img || !img.isConnected) return false;

    const url = imageUrl(img);

    return (
      img.complete &&
      img.naturalWidth >= 300 &&
      img.naturalHeight >= 200 &&
      !!url
    );
  }

  function imageUrl(img) {
    return img?.currentSrc || img?.src || null;
  }

  function imageArea(img) {
    return (
      (img.naturalWidth || 0) *
      (img.naturalHeight || 0)
    );
  }

  async function confirmStable(img) {
    const url = imageUrl(img);

    if (!url || !usableImage(img)) return false;

    await sleep(350);

    return (
      img.isConnected &&
      usableImage(img) &&
      imageUrl(img) === url
    );
  }

  // ------------------------------------------------------------
  // DOWNLOAD
  // ------------------------------------------------------------

  async function downloadImage(img, filename) {
    if (!img || !img.isConnected) {
      throw new Error("NEW image disappeared before download.");
    }

    const url = imageUrl(img);

    if (!url) {
      throw new Error("NEW image has no URL.");
    }

    // Fast path: normal network URL -> Chrome downloads it directly.
    if (!url.startsWith("blob:") && !url.startsWith("data:")) {
      const result = await sendDownload(url, filename);

      if (!result.ok) {
        throw new Error(result.error || "Chrome download failed.");
      }

      return;
    }

    // Blob/data URLs need to be read in the page.
    let dataUrl = url;

    if (url.startsWith("blob:")) {
      const response = await fetch(url, {cache: "no-store"});

      if (!response.ok) {
        throw new Error(`Could not read NEW image: HTTP ${response.status}`);
      }

      const blob = await response.blob();

      dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();

        reader.onload = () => resolve(reader.result);
        reader.onerror = () =>
          reject(reader.error || new Error("Could not read image blob."));

        reader.readAsDataURL(blob);
      });
    }

    const result = await sendDownload(dataUrl, filename);

    if (!result.ok) {
      throw new Error(result.error || "Chrome download failed.");
    }
  }

  function sendDownload(url, filename) {
    return new Promise(resolve => {
      chrome.runtime.sendMessage(
        {
          action: "DOWNLOAD_IMAGE",
          url,
          filename
        },
        response => {
          if (chrome.runtime.lastError) {
            resolve({
              ok: false,
              error: chrome.runtime.lastError.message
            });
            return;
          }

          resolve(
            response || {
              ok: false,
              error: "No background response."
            }
          );
        }
      );
    });
  }

  // ------------------------------------------------------------
  // Background / visibility resilience
  // ------------------------------------------------------------
  document.addEventListener("visibilitychange", () => {
    // Never pause the queue merely because the user switched tabs.
    // The queue must continue unless the user explicitly presses PAUSE/STOP.
    if (!document.hidden && running) {
      try { void document.body?.offsetHeight; } catch (_) {}
    }
  });

  window.addEventListener("pageshow", () => {
    if (running) {
      try { void document.body?.offsetHeight; } catch (_) {}
    }
  });

  // ------------------------------------------------------------
  // STATE
  // ------------------------------------------------------------

  async function saveState(status) {
    await chrome.storage.local.set({
      currentIndex: index,
      total: prompts.length,
      imageCount: Math.floor(index / BATCH_SIZE),
      batchNumber: Math.floor(index / BATCH_SIZE) + 1,
      status
    });
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
})();
