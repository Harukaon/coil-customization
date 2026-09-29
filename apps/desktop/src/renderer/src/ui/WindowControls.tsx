import { useEffect, useState } from "react";
import { rendererPlatform } from "../platform";

/**
 * Minimise, maximise and close, drawn by the app.
 *
 * Windows and Linux get a frameless window with no system buttons at all, so
 * these are the only ones. The system's own were rejected for looking foreign
 * against the app's chrome; the price is Windows 11's Snap Layouts, the tiling
 * menu the system shows when its maximise button is hovered, which is a
 * non-client hit test a page cannot reproduce. Double-clicking the drag strip
 * still toggles maximise, which Windows expects and Electron gives us for free.
 *
 * Rendered as a sibling of the app rather than inside it: the settings dialog
 * and the skills workspace each replace the whole tree, and a window with no way
 * to close it is worse than any of them.
 *
 * Icons are 10px, the size of Windows' own caption glyphs; a 13px version looked
 * oversized next to native windows. The strip is 44px tall (see .window-controls)
 * so the three buttons share the 22px centre line of the inspector header's
 * controls.
 */
export function WindowControls(): React.JSX.Element | null {
  const platform = rendererPlatform();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (platform === "darwin") return;
    void window.coilcoil.isWindowMaximized().then(setMaximized).catch(() => undefined);
    return window.coilcoil.onWindowMaximizedChange(setMaximized);
  }, [platform]);

  // macOS keeps its own traffic lights, positioned by the main process.
  if (platform === "darwin") return null;

  return (
    <div className="window-controls no-drag">
      <button type="button" aria-label="最小化" title="最小化" onClick={() => window.coilcoil.minimizeWindow()}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0 5h10" stroke="currentColor" strokeWidth="1" /></svg>
      </button>
      <button
        type="button"
        aria-label={maximized ? "还原" : "最大化"}
        title={maximized ? "还原" : "最大化"}
        onClick={() => window.coilcoil.toggleWindowMaximized()}
      >
        {maximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M2.5 0.5h7v7h-2" fill="none" stroke="currentColor" strokeWidth="1" />
            <rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" />
          </svg>
        )}
      </button>
      <button className="window-close" type="button" aria-label="关闭" title="关闭" onClick={() => window.coilcoil.closeWindow()}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" /></svg>
      </button>
    </div>
  );
}
