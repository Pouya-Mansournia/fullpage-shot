const btn = document.getElementById("captureBtn");
const statusEl = document.getElementById("status");

btn.addEventListener("click", async () => {
  btn.disabled = true;
  statusEl.textContent = "Capturing...";

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.runtime.sendMessage({ type: "CAPTURE", tabId: tab.id }, (resp) => {
    btn.disabled = false;
    if (chrome.runtime.lastError) {
      statusEl.textContent = "Error: " + chrome.runtime.lastError.message;
      return;
    }
    if (resp && resp.ok) {
      statusEl.textContent = "Done, check your downloads.";
    } else {
      statusEl.textContent = "Error: " + (resp && resp.error);
    }
  });
});
