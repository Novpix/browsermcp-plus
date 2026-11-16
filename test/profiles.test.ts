import { describe, expect, it } from "vitest";

import { defaultUserDataDir, describeProfile, findProfile, identifyProfile, parseLocalState } from "../src/profiles";
import { formatProfiles } from "../src/tools/profiles";

const LOCAL_STATE = JSON.stringify({
  profile: {
    last_used: "Profile 3",
    profiles_order: ["Default", "Profile 3", "Profile 10", "Profile 2"],
    info_cache: {
      "Profile 2": { name: "Spare" },
      "Profile 10": { name: "Shop", user_name: "", gaia_id: "" },
      Default: { name: "Personal", user_name: "me@example.com", gaia_id: "111", gaia_name: "Mia Example" },
      "Profile 3": { name: "work@example.com", user_name: "work@example.com", gaia_id: "333" },
    },
  },
});

const profiles = parseLocalState(LOCAL_STATE);

describe("Chrome profiles", () => {
  it("reads folder, name and account from Local State, in Chrome's order", () => {
    expect(profiles).toEqual([
      { directory: "Default", name: "Personal", email: "me@example.com", gaiaId: "111", accountName: "Mia Example", lastUsed: false },
      { directory: "Profile 3", name: "work@example.com", email: "work@example.com", gaiaId: "333", accountName: undefined, lastUsed: true },
      { directory: "Profile 10", name: "Shop", email: undefined, gaiaId: undefined, accountName: undefined, lastUsed: false },
      { directory: "Profile 2", name: "Spare", email: undefined, gaiaId: undefined, accountName: undefined, lastUsed: false },
    ]);
  });

  it("copes with a Local State without profiles", () => {
    expect(parseLocalState("{}")).toEqual([]);
  });

  it("identifies an extension by the folder it was told, its account id or its email", () => {
    const dir = "/chrome";
    expect(identifyProfile(profiles, { directory: "Profile 2", userDataDir: dir }, dir)).toBe("Profile 2");
    // A folder learned for another Chrome (user data directory) does not count.
    expect(identifyProfile(profiles, { directory: "Profile 2", userDataDir: "/other" }, dir)).toBeUndefined();
    expect(identifyProfile(profiles, { gaiaId: "333" }, dir)).toBe("Profile 3");
    expect(identifyProfile(profiles, { email: "ME@example.com" }, dir)).toBe("Default");
    expect(identifyProfile(profiles, { email: "stranger@example.com" }, dir)).toBeUndefined();
    expect(identifyProfile(profiles, {}, dir)).toBeUndefined();
    expect(identifyProfile(profiles, undefined, dir)).toBeUndefined();
  });

  it("finds a profile by folder, name or email, and explains misses", () => {
    expect(findProfile(profiles, "profile 10").directory).toBe("Profile 10");
    expect(findProfile(profiles, "shop").directory).toBe("Profile 10");
    expect(findProfile(profiles, "me@example.com").directory).toBe("Default");
    expect(findProfile(profiles, "Mia Example").directory).toBe("Default");
    expect(() => findProfile(profiles, "nope")).toThrow(/No Chrome profile matches "nope". Profiles: Default \("Personal"\)/);
    const twins = parseLocalState(JSON.stringify({ profile: { info_cache: { A: { name: "Same" }, B: { name: "Same" } } } }));
    expect(() => findProfile(twins, "same")).toThrow(/Several Chrome profiles match "same": A, B/);
    expect(() => findProfile([], "x")).toThrow(/No Chrome profiles found/);
  });

  it("describes a profile without repeating an email used as its name", () => {
    expect(describeProfile(profiles[0])).toBe('Default ("Personal" · me@example.com)');
    expect(describeProfile(profiles[1])).toBe('Profile 3 ("work@example.com")');
  });

  it("knows where Google Chrome keeps its profiles", () => {
    expect(defaultUserDataDir("darwin", {}, "/Users/u")).toBe("/Users/u/Library/Application Support/Google/Chrome");
    expect(defaultUserDataDir("linux", {}, "/home/u")).toBe("/home/u/.config/google-chrome");
    expect(defaultUserDataDir("linux", { XDG_CONFIG_HOME: "/cfg" }, "/home/u")).toBe("/cfg/google-chrome");
    expect(defaultUserDataDir("win32", { LOCALAPPDATA: "C:/Users/u/AppData/Local" }, "C:/Users/u").replace(/\\/g, "/")).toBe(
      "C:/Users/u/AppData/Local/Google/Chrome/User Data",
    );
  });
});

describe("browser_profiles output", () => {
  it("marks connected profiles, the agent's own and unidentified extensions", () => {
    const text = formatProfiles({
      userDataDir: "/chrome",
      profiles,
      browsers: [
        { key: "b0", profile: "Default", ready: true },
        { key: "b1", profile: "Profile 3", ready: true },
        { key: "b2", ready: true },
      ],
      current: "Profile 3",
      chosen: true,
      foreign: [{ name: "tabrein", version: "1.2.2", profile: "Profile 10" }],
    });
    expect(text).toContain('- Default ("Personal" · me@example.com) — connected\n');
    expect(text).toContain('- Profile 3 ("work@example.com") — connected, last used in Chrome ← you work here\n');
    expect(text).toContain('- Profile 10 ("Shop") — not connected (closed, or the extension is not installed there)\n');
    expect(text).toContain("1 more connected extension in a profile not identified yet");
    expect(text).toContain('Warning: the "tabrein" 1.2.2 extension in Profile 10 tries to use the same port.');
  });

  it("says when nothing is connected or no profile was used yet", () => {
    expect(formatProfiles({ userDataDir: "/x", profiles: [], browsers: [], chosen: false, foreign: [] })).toContain(
      "not connected in any profile",
    );
    const text = formatProfiles({ userDataDir: "/x", profiles, browsers: [{ key: "b0", ready: true }], chosen: false, foreign: [] });
    expect(text).toContain("your next action uses the profile Chrome used last");
  });
});
