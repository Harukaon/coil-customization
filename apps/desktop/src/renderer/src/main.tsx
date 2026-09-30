// First on purpose: every other stylesheet, including the ones components pull in, must come after the form base so a class given to a control overrides it.
import "./ui/form/form.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { BubbleApp } from "./BubbleApp";
import { diagnostics, installRendererErrorHandlers } from "./diagnostics";
import { AppErrorBoundary } from "./ui/AppErrorBoundary";
import { WindowControls } from "./ui/WindowControls";
import { installIdleMotionPause } from "./ui/idle-motion";
import { installWindowDragFailureReport } from "./ui/window-drag-report";
import { initTheme } from "./theme";
import { ToastHost } from "./ui/toast";
import { UpdateDialog } from "./ui/update/UpdateDialog";
import "./styles.css";
import "./mobile.css";
import "./features/composer/mobile-model-picker.css";

/**
 * Mark the browser-side client and turn off Safari's automatic zoom.
 *
 * Tapping a field makes iOS scale the whole page up and leave it there, which
 * on a remote-control screen is disorienting rather than helpful. Doing it in
 * the viewport declaration keeps the app's own type sizes untouched, and only
 * the remote client is affected — the desktop window never runs this.
 */
if (window.coilcoil?.isRemote) {
  document.documentElement.dataset.client = "remote";
  const viewport = document.querySelector<HTMLMetaElement>("meta[name=viewport]");
  if (viewport) {
    viewport.content = "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover";
  }
}

installRendererErrorHandlers();
initTheme();
// 常驻的墨团标志每帧都要重算一整条 blur + contrast 滤镜链，没人看的时候先停下。
installIdleMotionPause();
// 标题栏偶发拖不动，只在发生的那一刻留得下痕迹，见 ui/window-drag-report.ts。
// 手机远程端没有窗口可拖，不用挂。
if (!window.coilcoil?.isRemote) installWindowDragFailureReport();
diagnostics.info("process", "renderer_started", { userAgent: navigator.userAgent });

const root = document.getElementById("root");
if (!root) throw new Error("Missing root element");

// The bubble is this same bundle loaded with #bubble: one renderer to build, and
// the workspace's reducers and styles come along unchanged.
const isBubble = window.location.hash === "#bubble";
if (isBubble) document.documentElement.classList.add("bubble");

createRoot(root).render(isBubble ? (
  <StrictMode>
    <AppErrorBoundary>
      <BubbleApp />
    </AppErrorBoundary>
    <ToastHost />
  </StrictMode>
) : (
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
    {/* Outside the boundary: these are what a crashed App is reported through,
        so they have to survive it. */}
    <WindowControls />
    <ToastHost />
    <UpdateDialog />
  </StrictMode>
));
