<p align="center">
  <img src="icons/icon128.png" width="72" height="72" alt="FullPage Shot logo">
</p>

<h1 align="center">FullPage Shot</h1>

<p align="center">
  A Chrome extension that captures a full page screenshot of the current tab, including SPA style pages with internal scroll containers, using your own logged in session.
</p>

## Quick install

1. Download or clone this repository.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top right toggle).
4. Click **Load unpacked** and select the project folder.
5. Pin the FullPage Shot icon to your toolbar if you want quick access.

## How to use it

1. Go to the page you want to capture and log in normally, in a regular tab.
2. Click the **FullPage Shot** toolbar icon.
3. Click **Capture Full Page**.
4. The page (or its internal scroll container, for app style sites) is scrolled and captured in steps, stitched into one image, and downloaded as a PNG.

## Why it works this way

Many modern sites do not scroll the whole page. Instead, the real content sits inside an inner element with its own scrollbar, while the page body stays a fixed height. A plain full page screenshot misses that content entirely.

FullPage Shot looks for the actual scrollable element on the page, scrolls it step by step, captures each step with `chrome.tabs.captureVisibleTab`, and stitches the results together in the background using `OffscreenCanvas`.

Because it runs inside your normal browser tab, it uses whatever session or login you already have. There is no separate automation browser and no need to log in again.

## Permissions

The extension only requests:

- `activeTab`, to act on the tab you are currently viewing
- `scripting`, to detect the scroll container and drive scrolling
- `downloads`, to save the final PNG

No content script is declared in the manifest and no broad host permissions are requested. The scripting code only runs when you click the capture button.

## Notes and limits

- Very tall pages are capped at 20,000 px to keep memory usage reasonable.
- Some pages use a location or cookie modal on first load that can end up in the screenshot if it is still open when you capture. Close it first for a cleaner result.
- `chrome.tabs.captureVisibleTab` has a short rate limit, which is why capture of very long pages takes a few seconds per section.

## License

[MIT](LICENSE)
