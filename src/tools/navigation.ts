import { z } from "zod";

import { actionResult } from "../snapshot";
import { defineTool, NAVIGATION, snapshotOption } from "./tool";

export const navigate = defineTool({
  name: "browser_navigate",
  description:
    "Navigate the connected tab to a URL. A missing scheme defaults to https:// (http:// for localhost).",
  inputSchema: z.object({
    url: z.string().min(1).describe("The URL to navigate to"),
    snapshot: snapshotOption("yes"),
  }),
  annotations: NAVIGATION,
  handle: async (context, { url, snapshot = true }) => {
    const target = normalizeUrl(url);
    const result = await context.send("browser_navigate", { url: target });
    return actionResult(context, `Navigated to ${target}`, result, { snapshot });
  },
});

export const goBack = defineTool({
  name: "browser_go_back",
  description: "Go back to the previous page",
  inputSchema: z.object({ snapshot: snapshotOption("yes") }),
  annotations: NAVIGATION,
  handle: async (context, { snapshot = true }) => {
    const result = await context.send("browser_go_back", {});
    return actionResult(context, "Navigated back", result, { snapshot });
  },
});

export const goForward = defineTool({
  name: "browser_go_forward",
  description: "Go forward to the next page",
  inputSchema: z.object({ snapshot: snapshotOption("yes") }),
  annotations: NAVIGATION,
  handle: async (context, { snapshot = true }) => {
    const result = await context.send("browser_go_forward", {});
    return actionResult(context, "Navigated forward", result, { snapshot });
  },
});

export const reload = defineTool({
  name: "browser_reload",
  description: "Reload the current page by navigating to its current URL",
  inputSchema: z.object({ snapshot: snapshotOption("yes") }),
  annotations: NAVIGATION,
  handle: async (context, { snapshot = true }) => {
    const url = await context.send("getUrl", undefined);
    const result = await context.send("browser_navigate", { url });
    return actionResult(context, `Reloaded ${url}`, result, { snapshot });
  },
});

const SCHEME = /^[a-z][a-z0-9+.-]*:(?!\d)/i;
const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?(\/|$)/i;

export function normalizeUrl(url: string): string {
  const trimmed = url.trim();
  if (SCHEME.test(trimmed)) return trimmed;
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  return `${LOCAL_HOST.test(trimmed) ? "http" : "https"}://${trimmed}`;
}
