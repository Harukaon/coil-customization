import type { WebContents } from "electron";

export interface BrowserElementBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Wide enough to read a page on a phone, small enough to push every second. */
const DEFAULT_MAX_WIDTH = 900;

/** JPEG quality: text stays legible, a frame stays well under a hundred KB. */
const QUALITY = 70;

/**
 * A picture of what a browser guest is showing right now.
 *
 * A phone cannot receive the live picture the desktop window draws, but the
 * page itself is live on the Mac and the agent is driving it. The
 * remote browser panel watches frames of it rather than embedding a browser of
 * its own, which is why this exists at all.
 */
export async function captureGuestFrame(
  guest: WebContents | undefined,
  maxWidth = DEFAULT_MAX_WIDTH,
): Promise<string | undefined> {
  if (!guest || guest.isDestroyed()) return undefined;
  const image = await guest.capturePage();
  if (image.isEmpty()) return undefined;
  const { width } = image.getSize();
  const scaled = width > maxWidth ? image.resize({ width: maxWidth }) : image;
  return `data:image/jpeg;base64,${scaled.toJPEG(QUALITY).toString("base64")}`;
}

/** Capture only the selected DOM rectangle through CDP, never the whole page. */
export async function captureGuestElement(
  guest: WebContents | undefined,
  bounds: BrowserElementBounds | undefined,
): Promise<string | undefined> {
  if (!guest || guest.isDestroyed() || !bounds || bounds.width <= 0 || bounds.height <= 0) return undefined;
  if (!guest.debugger.isAttached()) return undefined;
  const padding = 8;
  // DOM.getBoxModel reports the element relative to the visible viewport, but the
  // screenshot clip is in page coordinates. On a page scrolled down 1400px the clip
  // therefore pointed 1400px above the element and came back as an empty area.
  let pageX = 0;
  let pageY = 0;
  try {
    const metrics = await guest.debugger.sendCommand("Page.getLayoutMetrics") as {
      cssVisualViewport?: { pageX?: number; pageY?: number };
    };
    pageX = metrics.cssVisualViewport?.pageX ?? 0;
    pageY = metrics.cssVisualViewport?.pageY ?? 0;
  } catch {
    // Unscrolled pages still work with a zero offset.
  }
  const clip = {
    x: Math.max(0, pageX + bounds.x - padding),
    y: Math.max(0, pageY + bounds.y - padding),
    width: Math.max(1, bounds.width + padding * 2),
    height: Math.max(1, bounds.height + padding * 2),
    scale: 1,
  };
  try {
    const result = await guest.debugger.sendCommand("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
      clip,
    }) as { data?: unknown };
    if (typeof result.data !== "string" || !result.data) return undefined;
    return `data:image/png;base64,${result.data}`;
  } catch {
    // A browser that is in the middle of navigation can reject one CDP frame;
    // the caller will still receive the DOM metadata and can continue without an
    // image rather than accidentally attaching a full-screen screenshot.
    return undefined;
  }
}
