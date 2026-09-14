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
    func: findScrollTarget,
    args: [MAX_HEIGHT],
  });
  if (!prep) throw new Error("Could not find any content to capture on this page.");

  const { mode, dpr } = prep;
  const width = prep.width;
  let height = prep.height;
  let totalHeight = Math.min(prep.totalHeight, MAX_HEIGHT);
  let step = Math.max(150, height - 60);

  const shots = [];
  let pos = 0;
  const maxIterations = Math.ceil(MAX_HEIGHT / step) + 20;

  for (let i = 0; i < maxIterations; i++) {
    const scrollTarget = Math.min(pos, Math.max(0, totalHeight - height));
    const [{ result: measured }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: scrollToPosition,
      args: [mode, scrollTarget],
    });
    await sleep(400);
    const dataUrl = await chrome.tabs.captureVisibleTab(undefined, { format: "png" });
    // The crop rect is re-measured after every scroll (not just once up
    // front) because some sites collapse/resize a sticky header as you
    // scroll, which shifts where the scrollable content sits on screen.
    shots.push({
      pos: measured.actualPos,
      dataUrl,
      x: measured.x,
      y: measured.y,
      width: measured.width,
      height: measured.height,
    });
    await sleep(150); // stay under captureVisibleTab's rate limit

    height = measured.height;
    step = Math.max(150, height - 60);

    if (measured.totalHeight > totalHeight) {
      totalHeight = Math.min(measured.totalHeight, MAX_HEIGHT);
    }

    const reachedBottom = measured.actualPos + height >= totalHeight - 1;
    if (!reachedBottom) {
      pos = measured.actualPos + step;
      continue;
    }

    // Give lazy-loaded content (common on infinite-scroll pages) a chance to
    // arrive — some sites fetch the next batch slowly, so keep checking a
    // few times before concluding the page is really done growing.
    let grew = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      await sleep(700);
      const [{ result: recheck }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: measureHeight,
        args: [mode],
      });
      if (recheck.totalHeight > totalHeight + 5) {
        totalHeight = Math.min(recheck.totalHeight, MAX_HEIGHT);
        grew = true;
        break;
      }
    }
    if (grew) {
      pos = measured.actualPos + step;
      continue;
    }
    break;
  }

  // Append any fixed/sticky bottom bar (e.g. a bottom nav) once, at the very
  // end — it's chrome, not scrollable content, so it's deliberately excluded
  // from every mid-page shot to avoid it repeating down the whole image.
  if (shots.length) {
    const [{ result: footer }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: findFixedBottomBar,
      args: [],
    });
    if (footer) {
      const last = shots[shots.length - 1];
      shots.push({
        pos: totalHeight,
        dataUrl: last.dataUrl,
        x: last.x,
        y: footer.y,
        width: last.width,
        height: footer.height,
      });
      totalHeight += footer.height;
    }
  }

  const finalDataUrl = await stitch(shots, { width, totalHeight, dpr });
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
  const { width, totalHeight, dpr } = prep;
  const canvas = new OffscreenCanvas(Math.round(width * dpr), Math.round(totalHeight * dpr));
  const ctx = canvas.getContext("2d");

  for (const { pos, dataUrl, x, y, width: shotWidth, height: shotHeight } of shots) {
    const blob = await (await fetch(dataUrl)).blob();
    const bitmap = await createImageBitmap(blob);
    const sx = Math.round(x * dpr);
    const sy = Math.round(y * dpr);
    const sw = Math.round(shotWidth * dpr);
    const sh = Math.round(shotHeight * dpr);
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

function findScrollTarget(maxHeight) {
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

  const windowTotalHeight = Math.max(
    document.documentElement.scrollHeight,
    document.body.scrollHeight
  );
  const windowScrollable = windowTotalHeight > vh + 30;

  let mode, x = 0, y = 0, width = vw, height = vh, totalHeight;
  if (candidates.length) {
    const target = candidates[0].el;
    const containerTotalHeight = target.scrollHeight;
    // The whole document can genuinely cover more content than the detected
    // inner container (e.g. the heuristic locked onto the wrong scrollable
    // panel) — prefer whichever actually spans more of the page.
    if (windowScrollable && windowTotalHeight >= containerTotalHeight) {
      mode = "window";
      totalHeight = Math.min(windowTotalHeight, maxHeight);
    } else {
      target.setAttribute("data-fps-target", "1");
      const r = target.getBoundingClientRect();
      mode = "container";
      x = Math.max(0, r.x);
      y = Math.max(0, r.y);
      width = r.width;
      height = r.height;
      totalHeight = Math.min(containerTotalHeight, maxHeight);
    }
  } else {
    mode = "window";
    totalHeight = Math.min(windowTotalHeight, maxHeight);
  }

  return { mode, x, y, width, height, totalHeight, dpr };
}

function findFixedBottomBar() {
  const vw = innerWidth;
  const vh = innerHeight;
  const els = [...document.querySelectorAll("*")];
  let best = null;

  for (const el of els) {
    const s = getComputedStyle(el);
    if (s.position !== "fixed" && s.position !== "sticky") continue;
    const r = el.getBoundingClientRect();
    if (r.height < 20 || r.height > vh * 0.4) continue;
    if (r.width < vw * 0.3) continue;
    if (r.bottom < vh - 40) continue; // must be anchored near the viewport bottom
    const area = r.width * r.height;
    if (!best || area > best.area) {
      best = { area, y: Math.max(0, r.y), height: r.height };
    }
  }

  return best ? { y: best.y, height: best.height } : null;
}

function measureHeight(mode) {
  if (mode === "container") {
    const el = document.querySelector('[data-fps-target="1"]');
    return { totalHeight: el ? el.scrollHeight : document.documentElement.scrollHeight };
  }
  return {
    totalHeight: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
  };
}

function scrollToPosition(mode, pos) {
  if (mode === "container") {
    const el = document.querySelector('[data-fps-target="1"]');
    if (el) el.scrollTop = pos;
    const r = el ? el.getBoundingClientRect() : null;
    return {
      actualPos: el ? el.scrollTop : pos,
      totalHeight: el ? el.scrollHeight : document.documentElement.scrollHeight,
      x: r ? Math.max(0, r.x) : 0,
      y: r ? Math.max(0, r.y) : 0,
      width: r ? r.width : innerWidth,
      height: r ? r.height : innerHeight,
    };
  }
  window.scrollTo(0, pos);
  return {
    actualPos: window.scrollY,
    totalHeight: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
    x: 0,
    y: 0,
    width: innerWidth,
    height: innerHeight,
  };
}
