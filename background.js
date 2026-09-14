const MAX_HEIGHT = 20000;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "CAPTURE") {
    captureFullPage(msg.tabId)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // keep the message channel open for the async response
  }
});

async function captureFullPage(tabId) {
  const [{ result: prep }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: findScrollTargetAndPositions,
    args: [MAX_HEIGHT],
  });
  if (!prep) throw new Error("Could not find any content to capture on this page.");

  const shots = [];
  for (const pos of prep.positions) {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: scrollToPosition,
      args: [prep.mode, pos],
    });
    await sleep(400);
    const dataUrl = await chrome.tabs.captureVisibleTab(undefined, { format: "png" });
    shots.push({ pos, dataUrl });
    await sleep(150); // stay under captureVisibleTab's rate limit
  }

  const finalDataUrl = await stitch(shots, prep);
  await chrome.downloads.download({
    url: finalDataUrl,
    filename: "fullpage-shot.png",
    saveAs: true,
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stitch(shots, prep) {
  const { x, y, width, height, totalHeight, dpr } = prep;
  const canvas = new OffscreenCanvas(Math.round(width * dpr), Math.round(totalHeight * dpr));
  const ctx = canvas.getContext("2d");

  for (const { pos, dataUrl } of shots) {
    const blob = await (await fetch(dataUrl)).blob();
    const bitmap = await createImageBitmap(blob);
    const sx = Math.round(x * dpr);
    const sy = Math.round(y * dpr);
    const sw = Math.round(width * dpr);
    const sh = Math.round(height * dpr);
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, Math.round(pos * dpr), sw, sh);
  }

  const blob = await canvas.convertToBlob({ type: "image/png" });
  return blobToDataURL(blob);
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// --- Functions below are injected into the page via chrome.scripting.executeScript. ---
// They must be fully self-contained (no references to outer scope).

function findScrollTargetAndPositions(maxHeight) {
  const vw = innerWidth;
  const vh = innerHeight;
  const dpr = window.devicePixelRatio || 1;
  const els = [...document.querySelectorAll("*")];
  const candidates = [];

  for (const el of els) {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const oy = s.overflowY;
    const cls = (el.className || "").toString();
    if (/modal|bottomsheet|overlay/i.test(cls)) continue;
    const scrollable =
      (oy === "auto" || oy === "scroll") &&
      el.scrollHeight > el.clientHeight + 30 &&
      r.width > vw * 0.25 &&
      r.height > vh * 0.3;
    if (scrollable) {
      candidates.push({ el, score: el.scrollHeight - el.clientHeight });
    }
  }
  candidates.sort((a, b) => b.score - a.score);

  let mode, x = 0, y = 0, width = vw, height = vh, totalHeight;
  if (candidates.length) {
    const target = candidates[0].el;
    target.setAttribute("data-fps-target", "1");
    const r = target.getBoundingClientRect();
    mode = "container";
    x = Math.max(0, r.x);
    y = Math.max(0, r.y);
    width = r.width;
    height = r.height;
    totalHeight = Math.min(target.scrollHeight, maxHeight);
  } else {
    mode = "window";
    totalHeight = Math.min(
      Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
      maxHeight
    );
  }

  const step = Math.max(150, height - 60);
  const positions = [];
  for (let p = 0; p < Math.max(1, totalHeight - height + 1); p += step) {
    positions.push(Math.round(p));
  }
  const last = Math.max(0, Math.round(totalHeight - height));
  if (!positions.length || positions[positions.length - 1] !== last) {
    positions.push(last);
  }

  return { mode, x, y, width, height, totalHeight, positions, dpr };
}

function scrollToPosition(mode, pos) {
  if (mode === "container") {
    const el = document.querySelector('[data-fps-target="1"]');
    if (el) el.scrollTop = pos;
  } else {
    window.scrollTo(0, pos);
  }
}
