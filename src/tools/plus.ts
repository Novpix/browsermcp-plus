import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { z } from "zod";

import type { EvaluateResult, TabInfo } from "../protocol";
import { actionResult } from "../snapshot";
import { normalizeUrl } from "./navigation";
import { defineTool, NAVIGATION, PAGE_MUTATION, READ_ONLY, text } from "./tool";

// Tools in this file need the Browser MCP Plus extension (extension/).

const element = z
  .string()
  .describe(
    "Human-readable element description used to obtain permission to interact with the element",
  );

export const uploadFile = defineTool({
  name: "browser_file_upload",
  description:
    "Upload local files through a file input. `ref` may be the file input itself or the button that opens the file chooser; no dialog is shown.",
  inputSchema: z.object({
    element,
    ref: z.string().min(1).describe("Exact target element reference from the page snapshot"),
    paths: z
      .array(z.string().min(1))
      .min(1)
      .describe("Absolute paths of the files to upload (`~` is expanded)"),
  }),
  annotations: PAGE_MUTATION,
  handle: async (context, args) => {
    const paths = await resolveFiles(args.paths);
    await context.send("browser_upload_file", { element: args.element, ref: args.ref, paths });
    const names = paths.map((p) => path.basename(p)).join(", ");
    return actionResult(context, `Uploaded ${names} via "${args.element}"`);
  },
});

export async function resolveFiles(paths: string[]): Promise<string[]> {
  const resolved = paths.map((p) =>
    path.resolve(p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p),
  );
  const problems: string[] = [];
  for (const file of resolved) {
    const info = await stat(file).catch(() => undefined);
    if (!info) problems.push(`${file} does not exist`);
    else if (!info.isFile()) problems.push(`${file} is not a file`);
  }
  if (problems.length) throw new Error(`Cannot upload: ${problems.join("; ")}`);
  return resolved;
}

export const evaluate = defineTool({
  name: "browser_evaluate",
  description:
    "Run JavaScript in the page and return the JSON-serialisable result. Pass a function: `() => document.title`, or `(element) => element.value` together with a `ref`. Promises are awaited.",
  inputSchema: z.object({
    function: z.string().min(1).describe("JavaScript function source, e.g. `() => location.href`"),
    element: element.optional(),
    ref: z.string().min(1).optional().describe("Element passed as the function's first argument"),
  }),
  annotations: PAGE_MUTATION,
  handle: async (context, args) => {
    const result = await context.send("browser_evaluate", args);
    return text(formatEvaluateResult(result));
  },
});

export function formatEvaluateResult(result: EvaluateResult): string {
  if (result.type === "undefined") return "undefined";
  if (result.unserializableValue) return result.unserializableValue;
  if (result.value !== undefined) {
    return typeof result.value === "string" ? result.value : JSON.stringify(result.value, null, 2);
  }
  return result.description ?? result.type;
}

export const scroll = defineTool({
  name: "browser_scroll",
  description:
    "Scroll the page with the mouse wheel by a number of pixels, or scroll an element from the snapshot into view",
  inputSchema: z.object({
    deltaY: z.number().optional().describe("Vertical pixels; positive scrolls down"),
    deltaX: z.number().optional().describe("Horizontal pixels; positive scrolls right"),
    element: element.optional(),
    ref: z.string().min(1).optional().describe("Element to scroll into view instead"),
  }),
  annotations: NAVIGATION,
  handle: async (context, args) => {
    if (!args.ref && !args.deltaX && !args.deltaY) {
      throw new Error("Provide `deltaY`/`deltaX`, or a `ref` to scroll into view");
    }
    await context.send("browser_scroll", args);
    const status = args.ref
      ? `Scrolled "${args.element ?? args.ref}" into view`
      : `Scrolled by ${args.deltaX ?? 0}, ${args.deltaY ?? 0}`;
    return actionResult(context, status);
  },
});

function formatTab(tab: TabInfo): string {
  const flags = [tab.connected && "connected", tab.active && "active"].filter(Boolean);
  const suffix = flags.length ? ` (${flags.join(", ")})` : "";
  return `- [${tab.id}] ${tab.title || "(untitled)"} — ${tab.url}${suffix}`;
}

export const tabList = defineTool({
  name: "browser_tab_list",
  description: "List open browser tabs. The connected tab is the one other tools act on.",
  inputSchema: z.object({}),
  annotations: READ_ONLY,
  handle: async (context) => {
    const tabs = await context.send("browser_tab_list", {});
    return text(tabs.map(formatTab).join("\n") || "No tabs open.");
  },
});

export const tabNew = defineTool({
  name: "browser_tab_new",
  description: "Open a new tab, optionally at a URL, and make it the connected tab",
  inputSchema: z.object({
    url: z.string().min(1).optional().describe("URL to open (default about:blank)"),
  }),
  annotations: NAVIGATION,
  handle: async (context, { url }) => {
    const tab = await context.send("browser_tab_new", { url: url && normalizeUrl(url) });
    return actionResult(context, `Opened tab ${tab.id}`);
  },
});

export const tabSelect = defineTool({
  name: "browser_tab_select",
  description: "Switch the connected tab (use ids from browser_tab_list)",
  inputSchema: z.object({
    tabId: z.number().int().describe("Tab id from browser_tab_list"),
  }),
  annotations: NAVIGATION,
  handle: async (context, { tabId }) => {
    await context.send("browser_tab_select", { tabId });
    return actionResult(context, `Switched to tab ${tabId}`);
  },
});

export const tabClose = defineTool({
  name: "browser_tab_close",
  description:
    "Close a tab (default: the connected one). Closing the connected tab connects the tab that becomes active.",
  inputSchema: z.object({
    tabId: z.number().int().optional().describe("Tab id from browser_tab_list"),
  }),
  annotations: PAGE_MUTATION,
  handle: async (context, { tabId }) => {
    const next = await context.send("browser_tab_close", { tabId });
    const closed = `Closed tab${tabId === undefined ? "" : ` ${tabId}`}`;
    if (!next) return text(closed);
    return actionResult(context, `${closed}; now connected to tab ${next.id}`);
  },
});
