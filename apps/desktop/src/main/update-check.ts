/**
 * Ask GitHub whether a newer build exists.
 *
 * Notify only — never install. The macOS packages are unsigned, and Squirrel.Mac
 * refuses to apply an update to an unsigned app, so a silent updater would work
 * on Windows and fail on the Mac. One popup that points at the download page
 * behaves the same on both.
 */

// Private-deployment build: update notices come from this repository's own releases, not from stock CoilCoil.
export const UPDATE_REPOSITORY = "Harukaon/coil-customization";

/** Long enough that a cold start is never competing with a network call. */
export const UPDATE_FIRST_CHECK_MS = 8_000;

export const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1_000;

export interface ReleaseSummary {
  version: string;
  url: string;
  prerelease: boolean;
  publishedAt?: string;
}

export interface UpdateAvailable {
  current: string;
  latest: string;
  url: string;
}

interface GithubRelease {
  tag_name?: unknown;
  html_url?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  published_at?: unknown;
}

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9a-z.-]+))?$/i;

interface ParsedVersion {
  release: [number, number, number];
  prerelease: string[];
}

export function parseVersion(value: string): ParsedVersion | undefined {
  const match = VERSION_PATTERN.exec(value.trim());
  if (!match) return undefined;
  return {
    release: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

/**
 * Semver precedence, enough of it for our own tags.
 *
 * The identifier rules matter here rather than being pedantry: `beta.10` has to
 * win over `beta.9`, which a string comparison gets backwards, and a finished
 * `0.1.0` has to win over every `0.1.0-beta.N` that led to it.
 */
export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (a.release[index]! !== b.release[index]!) return a.release[index]! < b.release[index]! ? -1 : 1;
  }
  if (!a.prerelease.length && !b.prerelease.length) return 0;
  if (!a.prerelease.length) return 1;
  if (!b.prerelease.length) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const one = a.prerelease[index];
    const other = b.prerelease[index];
    if (one === undefined) return -1;
    if (other === undefined) return 1;
    if (one === other) continue;
    const oneNumeric = /^\d+$/.test(one);
    const otherNumeric = /^\d+$/.test(other);
    if (oneNumeric && otherNumeric) return Number(one) < Number(other) ? -1 : 1;
    if (oneNumeric !== otherNumeric) return oneNumeric ? -1 : 1;
    return one < other ? -1 : 1;
  }
  return 0;
}

/**
 * The newest release worth offering.
 *
 * Drafts are invisible to everyone but the author, and a tag that is not a
 * version — the rolling `beta` pointer, say — cannot be compared against what
 * is installed, so neither can be offered as an update.
 */
export function newestRelease(payload: unknown): ReleaseSummary | undefined {
  if (!Array.isArray(payload)) return undefined;
  const releases: ReleaseSummary[] = [];
  for (const entry of payload as GithubRelease[]) {
    if (!entry || typeof entry !== "object" || entry.draft === true) continue;
    const tag = typeof entry.tag_name === "string" ? entry.tag_name : "";
    const url = typeof entry.html_url === "string" ? entry.html_url : "";
    if (!parseVersion(tag) || !url) continue;
    releases.push({
      version: tag.replace(/^v/i, ""),
      url,
      prerelease: entry.prerelease === true,
      publishedAt: typeof entry.published_at === "string" ? entry.published_at : undefined,
    });
  }
  return releases.sort((left, right) => compareVersions(right.version, left.version))[0];
}

export async function fetchReleases(repository = UPDATE_REPOSITORY): Promise<unknown> {
  const response = await fetch(`https://api.github.com/repos/${repository}/releases?per_page=20`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "CoilCoil-Updater" },
  });
  if (!response.ok) throw new Error(`GitHub 返回 ${response.status}`);
  return response.json();
}

/**
 * Compare what is published against what is running.
 *
 * Returns nothing when the installed build is current or newer — a developer
 * running an unreleased build must not be told to downgrade to the last tag.
 */
export async function checkForUpdate(
  currentVersion: string,
  load: () => Promise<unknown> = () => fetchReleases(),
): Promise<UpdateAvailable | undefined> {
  const latest = newestRelease(await load());
  if (!latest) return undefined;
  if (compareVersions(latest.version, currentVersion) <= 0) return undefined;
  return { current: currentVersion, latest: latest.version, url: latest.url };
}
