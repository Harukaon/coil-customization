import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_BROWSER_URL = "about:blank";

/**
 * Normalize text entered by the user or sent through the browser MCP.
 *
 * CoilCoil intentionally does not maintain a protocol or filesystem allowlist:
 * the embedded Chromium instance decides whether it can load a given URL.
 * Absolute paths and home-relative paths are converted to file URLs so local
 * reports can be opened without callers having to encode them first.
 */
export function normalizeBrowserUrl(raw: string | undefined): string {
  const value = raw?.trim();
  if (!value || /^about:blank$/i.test(value)) return DEFAULT_BROWSER_URL;

  const localPath = value === "~"
    ? homedir()
    : value.startsWith("~/")
      ? resolve(homedir(), value.slice(2))
      : isAbsolute(value)
        ? value
        : undefined;
  if (localPath) return pathToFileURL(localPath).toString();

  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value)) return new URL(value).toString();

  const candidate = value.includes(".") && !value.includes(" ")
    ? `https://${value}`
    : `https://cn.bing.com/search?q=${encodeURIComponent(value)}`;
  return new URL(candidate).toString();
}

/** The part of a guest this module needs, so the behaviour is testable without Electron. */
interface LoadableGuest {
  loadURL(url: string): Promise<void>;
  isDestroyed(): boolean;
}

/**
 * Navigate a guest, treating a rejected load as a finished navigation.
 *
 * `loadURL` rejects for outcomes nobody can act on. ERR_ABORTED is what a
 * redirect, a download, or the next navigation looks like from here; a page that
 * genuinely failed already shows Chromium's own error page inside the guest,
 * exactly as any browser would. Turning either into a thrown error cost us twice:
 * the address bar's promise came back rejected and nothing caught it (twelve
 * unhandled rejections in the user's log, every one of them `browser:navigate`),
 * and at tab creation it destroyed a tab whose error page was perfectly readable.
 *
 * A destroyed guest is different — the page is gone, so the failure is real and
 * still travels.
 */
export async function loadGuestUrl(guest: LoadableGuest, url: string): Promise<void> {
  try {
    await guest.loadURL(url);
  } catch (error) {
    if (guest.isDestroyed()) throw error;
    console.error("[browser] 页面没有加载完成", url, error);
  }
}
