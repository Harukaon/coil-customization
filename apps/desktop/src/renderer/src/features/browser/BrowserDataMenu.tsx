import * as Popover from "@radix-ui/react-popover";
import { Compass, Download, ExternalLink, Globe, LoaderCircle, Trash2, UserRound } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { BrowserDataStats, ImportableProfile } from "../../../../shared/desktop-api";
import { ConfirmDialog } from "../../ui/dialog";
import { toastError, toastInfo, toastSuccess } from "../../ui/toast";
import { rendererPlatform } from "../../platform";
import { Checkbox } from "../../ui/form";

function profileKey(profile: ImportableProfile): string {
  return `${profile.browser}:${profile.id}`;
}

/** 列表里那一行放不下的完整说明。 */
function profileHint(profile: ImportableProfile): string | undefined {
  if (profile.fix !== "full-disk-access") return undefined;
  return `macOS 不允许 CoilCoil 读取 ${profile.browserName} 的数据。点这一行去「系统设置 → 隐私与安全性 → 完全磁盘访问权限」里允许 CoilCoil，然后重开 CoilCoil 再来导入。`;
}

function describeProfile(profile: ImportableProfile): string {
  if (profile.problem) return profile.problem;
  const parts: string[] = [];
  if (profile.email) parts.push(profile.email);
  if (profile.cookieCount !== undefined) parts.push(`${profile.cookieCount} 条 Cookie`);
  if (profile.passwordCount) parts.push(`${profile.passwordCount} 个密码`);
  return parts.join(" · ");
}

/**
 * The built-in browser's identity menu, on the tab strip.
 *
 * This belongs next to the tabs rather than in application settings: it is
 * about the browser in front of the user — who it is signed in as right now —
 * the same place every browser puts its profile button. Settings is where
 * things are configured once; this is used while browsing.
 *
 * Importing copies one existing browser profile's cookies (and, if asked, its
 * saved passwords) into CoilCoil's own jar. Clearing is deliberately one click
 * away from it: handing an agent live sessions is only reasonable when taking
 * them back is just as easy.
 */
export function BrowserDataMenu(): React.JSX.Element | null {
  const supported = rendererPlatform() === "darwin";
  const [open, setOpen] = useState(false);
  const [profiles, setProfiles] = useState<ImportableProfile[]>();
  const [stats, setStats] = useState<BrowserDataStats>();
  const [withPasswords, setWithPasswords] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [confirmClear, setConfirmClear] = useState(false);
  const [problemHosts, setProblemHosts] = useState<string[]>([]);

  const refresh = useCallback(async (): Promise<void> => {
    const [found, current] = await Promise.all([
      window.coilcoil.listImportableBrowsers(),
      window.coilcoil.getBrowserDataStats(),
    ]);
    setProfiles(found);
    setStats(current);
  }, []);

  // Reading the profile list copies every browser's cookie database, so it is
  // done when the menu opens rather than when the panel mounts.
  useEffect(() => {
    if (!open) return;
    void refresh().catch((caught: unknown) => toastError(caught instanceof Error ? caught.message : String(caught)));
  }, [open, refresh]);

  if (!supported) return null;

  const importFrom = async (profile: ImportableProfile): Promise<void> => {
    setBusy(profileKey(profile));
    setProblemHosts([]);
    try {
      const summary = await window.coilcoil.importBrowserCookies({
        browser: profile.browser,
        profile: profile.id,
        includePasswords: withPasswords,
      });
      if (summary.error) {
        toastError(summary.error);
      } else if (summary.imported === 0 && summary.passwords === 0) {
        toastError("没有可导入的登录状态，可能这个配置文件本来就是空的。");
      } else {
        // The unreadable count is worth surfacing: it is the difference between
        // "everything came over" and "your one important site did not".
        const failed = summary.failed + summary.unreadable;
        toastSuccess(
          `已导入 ${summary.imported} 条 Cookie，覆盖 ${summary.hosts} 个网站`
          + (summary.passwords > 0 ? `，另存 ${summary.passwords} 个密码` : "")
          + (failed > 0 ? `，${failed} 条读不出来已跳过` : "")
          + "。",
        );
      }
      setProblemHosts(summary.problemHosts);
      if (summary.note) toastInfo(summary.note);
      await refresh();
    } catch (caught) {
      toastError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(undefined);
    }
  };

  const clearAll = async (): Promise<void> => {
    setConfirmClear(false);
    // The menu is not where progress belongs: closing it leaves the toast as the
    // one place the outcome is reported, success or failure.
    setOpen(false);
    setBusy("clear");
    try {
      setStats(await window.coilcoil.clearBrowserData());
      toastSuccess("内置浏览器已退出所有登录，缓存和已保存的密码也一并清空。");
    } catch (caught) {
      toastError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(undefined);
    }
  };

  const empty = (stats?.cookies ?? 0) === 0 && (stats?.savedLogins ?? 0) === 0;

  return (
    <>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <button className="browser-identity" type="button" aria-label="登录状态">
            <UserRound size={13} />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content className="browser-identity-popover" side="bottom" align="end" sideOffset={6} collisionPadding={12}>
            <header>
              <strong>登录状态</strong>
              <span>
                {stats === undefined
                  ? "读取中…"
                  : empty
                    ? "内置浏览器还没有任何登录"
                    : `${stats.cookies} 条 Cookie · ${stats.hosts} 个网站`
                      + (stats.savedLogins > 0 ? ` · ${stats.savedLogins} 个密码` : "")}
              </span>
            </header>

            {problemHosts.length > 0 ? (
              <div className="browser-identity-problems">
                <strong>{problemHosts.length} 个网站的 Cookie 没能导入</strong>
                <ul>{problemHosts.map((host) => <li key={host}>{host}</li>)}</ul>
                <small>多是浏览器用新版加密写的、或本机浏览器拒绝的记录；这些网站需要在内置浏览器里重新登录一次。</small>
              </div>
            ) : (
              <p className="browser-identity-lead">从这台电脑上已有的浏览器复制一份登录状态，原浏览器不受影响。登录状态按工作区分开存，这里导入的只属于当前工作区。</p>
            )}

            {profiles === undefined ? (
              <div className="browser-identity-loading"><LoaderCircle className="spin" size={14} />正在查找浏览器…</div>
            ) : profiles.length === 0 ? (
              <p className="browser-identity-empty">没有找到可以导入的浏览器。</p>
            ) : (
              <ul className="browser-identity-list">
                {profiles.map((profile) => (
                  <li key={profileKey(profile)}>
                    <button
                      type="button"
                      title={profileHint(profile)}
                      disabled={(!profile.available && !profile.fix) || busy !== undefined}
                      onClick={() => {
                        // 缺权限的那一行不是死路：点它就去开权限，回来再导入。
                        if (profile.fix) void window.coilcoil.openPermissionSettings("full-disk");
                        else void importFrom(profile);
                      }}
                    >
                      <span className="browser-identity-icon">
                        {profile.browser === "safari" ? <Compass size={14} /> : <Globe size={14} />}
                      </span>
                      <span className="browser-identity-label">
                        <strong>{profile.browserName} · {profile.name}</strong>
                        <small>{describeProfile(profile)}</small>
                      </span>
                      {busy === profileKey(profile)
                        ? <LoaderCircle className="spin" size={13} />
                        : profile.fix ? <ExternalLink size={13} /> : <Download size={13} />}
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <label className="browser-identity-check">
              <Checkbox look="plain" className="browser-identity-check-input" checked={withPasswords} onChange={(event) => setWithPasswords(event.target.checked)} />
              <span>连保存的密码一起导入<small>只用于内置浏览器登录页自动填充，不会交给模型</small></span>
            </label>

            <footer>
              <button
                className="browser-identity-clear"
                type="button"
                disabled={busy !== undefined || empty}
                onClick={() => setConfirmClear(true)}
              >
                {busy === "clear" ? <LoaderCircle className="spin" size={13} /> : <Trash2 size={13} />}
                清空全部登录状态
              </button>
            </footer>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>

      <ConfirmDialog
        open={confirmClear}
        title="清空内置浏览器的数据？"
        description="所有 Cookie、本地存储、缓存和已保存的密码都会删除，内置浏览器会退出全部登录。你自己的 Chrome、Safari 不受影响。"
        actions={[
          { label: "取消", onClick: () => setConfirmClear(false) },
          { label: "清空", variant: "danger", onClick: () => void clearAll() },
        ]}
        onClose={() => setConfirmClear(false)}
      />
    </>
  );
}
