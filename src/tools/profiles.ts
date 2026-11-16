import { z } from "zod";

import type { ProfileView } from "../bridge";
import { describeProfile } from "../profiles";
import { defineTool, NAVIGATION, READ_ONLY, text } from "./tool";

export const profiles = defineTool({
  name: "browser_profiles",
  description:
    "List the Chrome profiles on this computer (folder, name, Google account) and the ones the Browser MCP Plus extension is connected in. Shows which profile you work in.",
  inputSchema: z.object({}),
  annotations: READ_ONLY,
  handle: async (context) => text(formatProfiles(await context.bridge.profileView())),
});

export const profileSelect = defineTool({
  name: "browser_profile_select",
  description:
    "Work in another Chrome profile, e.g. to use a different Google account. Opens a Chrome window for the profile if it has none. Your tabs in the previous profile stay yours until your session ends.",
  inputSchema: z.object({
    profile: z
      .string()
      .min(1)
      .describe('Profile folder (e.g. "Profile 3"), profile name or Google account email, as listed by browser_profiles'),
  }),
  annotations: NAVIGATION,
  handle: async (context, { profile }) => {
    const { profile: selected, opened } = await context.bridge.selectProfile(profile);
    const label = describeProfile(selected);
    return text(
      opened
        ? `Opened Chrome profile ${label}; you have a blank tab of your own there. Use browser_navigate to continue.`
        : `Now working in Chrome profile ${label}. Your next actions run there, in a tab of your own.`,
    );
  },
});

export function formatProfiles(view: ProfileView): string {
  const connected = new Set(view.browsers.map((b) => b.profile).filter(Boolean));
  const lines: string[] = [];
  if (!view.profiles.length) {
    lines.push(`No Chrome profiles found in ${view.userDataDir}.`);
  } else {
    lines.push(`Chrome profiles (${view.userDataDir}):`);
    for (const profile of view.profiles) {
      const flags = [
        connected.has(profile.directory) ? "connected" : "not connected (closed, or the extension is not installed there)",
        profile.lastUsed && "last used in Chrome",
      ].filter(Boolean);
      const here = profile.directory === view.current ? " ← you work here" : "";
      lines.push(`- ${describeProfile(profile)} — ${flags.join(", ")}${here}`);
    }
  }
  const unknown = view.browsers.filter((b) => !b.profile).length;
  if (unknown) {
    lines.push(
      `${unknown} more connected extension${unknown === 1 ? "" : "s"} in a profile not identified yet (no Google account to match); browser_profile_select identifies it.`,
    );
  }
  if (!view.browsers.length) lines.push("The Browser MCP Plus extension is not connected in any profile right now.");
  if (view.current === undefined && view.browsers.length) {
    lines.push("You have not worked in a profile yet: your next action uses the profile Chrome used last.");
  } else if (view.current !== undefined && !connected.has(view.current)) {
    lines.push(`Your profile (${view.current}) is not connected; browser_profile_select opens it again.`);
  }
  for (const other of view.foreign) {
    lines.push(
      `Warning: the "${other.name}" ${other.version} extension${other.profile ? ` in ${other.profile}` : ""} tries to use the same port. Turn it off there and use Browser MCP Plus instead.`,
    );
  }
  lines.push("Switch with browser_profile_select (folder, name or account email).");
  return lines.join("\n");
}
