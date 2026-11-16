import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** A Chrome profile, as listed in the user data directory's `Local State`. */
export type ChromeProfile = {
  /** Folder inside the user data directory: "Default", "Profile 3". */
  directory: string;
  /** Name shown in Chrome's profile menu. */
  name: string;
  /** Google account signed in to the profile, if any. */
  email?: string;
  /** That account's obfuscated Gaia id (what chrome.identity reports as `id`). */
  gaiaId?: string;
  /** The account holder's name. */
  accountName?: string;
  /** The profile Chrome used most recently. */
  lastUsed: boolean;
};

/** What an extension knows about the profile it runs in (from its `hello`). */
export type ProfileHint = {
  /** Folder the hub told it earlier, with the user data directory it belongs to. */
  directory?: string;
  userDataDir?: string;
  email?: string;
  gaiaId?: string;
};

/** Google Chrome's user data directory on this platform. */
export function defaultUserDataDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
): string {
  // The platform's own separators, whatever system this runs on.
  const { join } = platform === "win32" ? path.win32 : path.posix;
  switch (platform) {
    case "darwin":
      return join(home, "Library", "Application Support", "Google", "Chrome");
    case "win32":
      return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "Google", "Chrome", "User Data");
    default:
      return join(env.XDG_CONFIG_HOME || join(home, ".config"), "google-chrome");
  }
}

/** Profiles from the text of a `Local State` file, in Chrome's menu order. */
export function parseLocalState(text: string): ChromeProfile[] {
  const state = JSON.parse(text) as { profile?: Record<string, unknown> };
  const section = (state?.profile ?? {}) as {
    info_cache?: Record<string, Record<string, unknown>>;
    profiles_order?: unknown;
    last_used?: unknown;
  };
  const cache = section.info_cache ?? {};
  const order = Array.isArray(section.profiles_order) ? section.profiles_order.filter((d) => typeof d === "string") : [];
  const rank = (directory: string) => {
    const index = order.indexOf(directory);
    return index === -1 ? order.length : index;
  };
  const string = (value: unknown) => (typeof value === "string" && value ? value : undefined);
  return Object.keys(cache)
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, "en", { numeric: true }))
    .map((directory) => {
      const entry = cache[directory] ?? {};
      return {
        directory,
        name: string(entry.name) ?? directory,
        email: string(entry.user_name),
        gaiaId: string(entry.gaia_id),
        accountName: string(entry.gaia_name),
        lastUsed: section.last_used === directory,
      };
    });
}

/** Reads the profile list, re-reading `Local State` only when Chrome has rewritten it. */
export class ChromeProfiles {
  private cache: { mtimeMs: number; profiles: ChromeProfile[] } | undefined;

  constructor(readonly userDataDir: string) {}

  async list(): Promise<ChromeProfile[]> {
    const file = path.join(this.userDataDir, "Local State");
    const info = await stat(file).catch(() => undefined);
    if (!info) return [];
    if (this.cache?.mtimeMs === info.mtimeMs) return this.cache.profiles;
    try {
      const profiles = parseLocalState(await readFile(file, "utf8"));
      this.cache = { mtimeMs: info.mtimeMs, profiles };
      return profiles;
    } catch {
      // Chrome may be rewriting the file right now.
      return this.cache?.profiles ?? [];
    }
  }
}

/** The profile an extension runs in, or undefined when that cannot be told. */
export function identifyProfile(
  profiles: ChromeProfile[],
  hint: ProfileHint | undefined,
  userDataDir: string,
): string | undefined {
  if (!hint) return undefined;
  if (
    hint.directory &&
    (!hint.userDataDir || samePath(hint.userDataDir, userDataDir)) &&
    profiles.some((p) => p.directory === hint.directory)
  ) {
    return hint.directory;
  }
  const unique = (matches: ChromeProfile[]) => (matches.length === 1 ? matches[0].directory : undefined);
  if (hint.gaiaId) {
    const match = unique(profiles.filter((p) => p.gaiaId === hint.gaiaId));
    if (match) return match;
  }
  if (hint.email) {
    const email = hint.email.toLowerCase();
    return unique(profiles.filter((p) => p.email?.toLowerCase() === email));
  }
  return undefined;
}

/** Finds a profile by folder, name or account email. Throws a helpful error otherwise. */
export function findProfile(profiles: ChromeProfile[], query: string): ChromeProfile {
  const wanted = query.trim().toLowerCase();
  const tests: ((p: ChromeProfile) => boolean)[] = [
    (p) => p.directory.toLowerCase() === wanted,
    (p) => p.name.toLowerCase() === wanted,
    (p) => p.email?.toLowerCase() === wanted,
    (p) => p.accountName?.toLowerCase() === wanted,
  ];
  for (const test of tests) {
    const matches = profiles.filter(test);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new Error(
        `Several Chrome profiles match "${query}": ${matches.map((p) => p.directory).join(", ")}. Use the profile folder.`,
      );
    }
  }
  const known = profiles.map((p) => `${p.directory} ("${p.name}")`).join(", ");
  throw new Error(
    profiles.length
      ? `No Chrome profile matches "${query}". Profiles: ${known}.`
      : `No Chrome profiles found. Is Google Chrome installed? (Looked for its "Local State" file; pass --chrome-user-data-dir for another Chromium browser.)`,
  );
}

export function describeProfile(profile: ChromeProfile): string {
  const account = profile.email && profile.email.toLowerCase() !== profile.name.toLowerCase() ? ` · ${profile.email}` : "";
  return `${profile.directory} ("${profile.name}"${account})`;
}

function samePath(a: string, b: string) {
  return path.resolve(a) === path.resolve(b);
}

/** Opens `url` in a Chrome profile, starting Chrome or a window of that profile if needed. */
export type ProfileLauncher = (directory: string, url: string) => Promise<void>;

export type LauncherOptions = {
  userDataDir: string;
  /** Chrome executable; by default Google Chrome is looked up for the platform. */
  chromePath?: string;
};

/**
 * Starts Chrome with `--profile-directory`. A running Chrome receives the
 * command line from the new process and opens the URL in that profile (in a
 * new window if the profile has none); otherwise Chrome starts.
 */
export function chromeLauncher(options: LauncherOptions): ProfileLauncher {
  return async (directory, url) => {
    const flags = [
      ...(samePath(options.userDataDir, defaultUserDataDir()) ? [] : [`--user-data-dir=${options.userDataDir}`]),
      `--profile-directory=${directory}`,
      url,
    ];
    if (options.chromePath) return spawnDetached(options.chromePath, flags);
    if (process.platform === "darwin") {
      // `open -n` hands the arguments to the running Chrome, or launches it through launchd.
      return run("open", ["-n", "-a", "Google Chrome", "--args", ...flags]);
    }
    for (const candidate of chromeCandidates()) {
      try {
        return await spawnDetached(candidate, flags);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    throw new Error("Could not find Google Chrome. Start the server with --chrome-path <path to Chrome>.");
  };
}

function chromeCandidates(): string[] {
  if (process.platform !== "win32") return ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
  const roots = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA];
  return roots
    .filter((root): root is string => !!root)
    .map((root) => path.join(root, "Google", "Chrome", "Application", "chrome.exe"))
    .filter((file) => existsSync(file));
}

function spawnDetached(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`Could not open Google Chrome (${command} exited with ${code}).`)),
    );
  });
}
