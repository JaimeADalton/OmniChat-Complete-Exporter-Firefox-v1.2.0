"use strict";

browser.runtime.onMessage.addListener(async (message, sender) => {
  if (!message || typeof message !== "object") return undefined;

  if (message.type === "OMNICHAT_CAPTURE_VISIBLE") {
    try {
      const windowId = sender?.tab?.windowId;
      const options = {
        format: message.format === "png" ? "png" : "jpeg"
      };
      if (options.format === "jpeg") options.quality = Math.max(10, Math.min(100, Number(message.quality) || 72));
      const dataUrl = await browser.tabs.captureVisibleTab(windowId, options);
      return { ok: true, dataUrl };
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  }

  if (message.type === "OMNICHAT_DOWNLOAD_URL") {
    try {
      const downloadId = await browser.downloads.download({
        url: message.url,
        filename: String(message.filename || "omnichat-export.zip"),
        saveAs: false,
        conflictAction: "uniquify"
      });
      return { ok: true, downloadId };
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  }

  return undefined;
});
