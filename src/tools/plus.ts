import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { z } from "zod";

import { isActionReport, type EvaluateResult, type TabInfo } from "../protocol";
import { actionResult, snapshotResult } from "../snapshot";
import { normalizeUrl } from "./navigation";
import { defineTool, NAVIGATION, PAGE_MUTATION, READ_ONLY, snapshotOption, text } from "./tool";

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
    snapshot: snapshotOption("no"),
  }),
  annotations: PAGE_MUTATION,
  handle: async (context, args) => {
    const paths = await resolveFiles(args.paths);
    const result = await context.send("browser_upload_file", { element: args.element, ref: args.ref, paths });
    const names = paths.map((p) => path.basename(p)).join(", ");
    return actionResult(context, `Uploaded ${names} via "${args.element}"`, result, { snapshot: args.snapshot });
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
    snapshot: snapshotOption("no"),
  }),
  annotations: NAVIGATION,
  handle: async (context, { snapshot, ...args }) => {
    if (!args.ref && !args.deltaX && !args.deltaY) {
      throw new Error("Provide `deltaY`/`deltaX`, or a `ref` to scroll into view");
    }
    const result = await context.send("browser_scroll", args);
    const status = args.ref
      ? `Scrolled "${args.element ?? args.ref}" into view`
      : `Scrolled by ${args.deltaX ?? 0}, ${args.deltaY ?? 0}`;
    return actionResult(context, status, result, { snapshot });
  },
});

/** The tab switch succeeded even if its page (e.g. about:blank) cannot be read. */
async function tabResult(context: Parameters<typeof snapshotResult>[0], status: string) {
  try {
    return await snapshotResult(context, status);
  } catch (error) {
    return text(`${status}. ${error instanceof Error ? error.message : String(error)}`);
  }
}

function formatTab(tab: TabInfo): string {
  const flags = [
    tab.connected && "connected",
    tab.agent && `used by agent ${JSON.stringify(tab.agent)}`,
    tab.active && "active",
  ].filter(Boolean);
  const suffix = flags.length ? ` (${flags.join(", ")})` : "";
  return `- [${tab.id}] ${tab.title || "(untitled)"} — ${tab.url}${suffix}`;
}

export const tabList = defineTool({
  name: "browser_tab_list",
  description:
    "List open browser tabs. Your tab is marked connected; tabs used by other agents are marked and cannot be selected.",
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
    return tabResult(context, `Opened tab ${tab.id}`);
  },
});

export const tabSelect = defineTool({
  name: "browser_tab_select",
  description: "Work in another tab (ids from browser_tab_list). Tabs used by other agents cannot be selected.",
  inputSchema: z.object({
    tabId: z.number().int().describe("Tab id from browser_tab_list"),
  }),
  annotations: NAVIGATION,
  handle: async (context, { tabId }) => {
    await context.send("browser_tab_select", { tabId });
    return tabResult(context, `Switched to tab ${tabId}`);
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
    return tabResult(context, `${closed}; now connected to tab ${next.id}`);
  },
});

export const handleDialog = defineTool({
  name: "browser_handle_dialog",
  description:
    "Accept or dismiss the JavaScript dialog (alert, confirm, prompt, beforeunload) that is blocking the page",
  inputSchema: z.object({
    accept: z.boolean().describe("true to press OK / accept, false to press Cancel / dismiss"),
    promptText: z.string().optional().describe("Text to enter into a prompt() dialog before accepting"),
    snapshot: snapshotOption("no"),
  }),
  annotations: PAGE_MUTATION,
  handle: async (context, { snapshot, ...args }) => {
    const result = await context.send("browser_handle_dialog", args);
    const status = isActionReport(result) && typeof result.value === "string" ? result.value : "Handled the dialog";
    return actionResult(context, status, result, { snapshot });
  },
});

export const fillForm = defineTool({
  name: "browser_fill_form",
  description:
    "Fill several form fields in one call: text fields, checkboxes, radio buttons, native dropdowns and sliders. Faster and more reliable than separate typing and clicking.",
  inputSchema: z.object({
    fields: z
      .array(
        z.object({
          name: z.string().describe("Human-readable field name"),
          type: z
            .enum(["textbox", "searchbox", "spinbutton", "checkbox", "radio", "switch", "combobox", "listbox", "slider"])
            .describe("The field's role from the snapshot"),
          ref: z.string().min(1).describe("Exact field reference from the page snapshot"),
          value: z
            .string()
            .describe('Text to enter; "true"/"false" for checkboxes, radios and switches; the option label for dropdowns'),
        }),
      )
      .min(1)
      .describe("Fields to fill, in order"),
    snapshot: snapshotOption("no"),
  }),
  annotations: PAGE_MUTATION,
  handle: async (context, { fields, snapshot }) => {
    const result = await context.send("browser_fill_form", { fields });
    const filled = isActionReport(result) && Array.isArray(result.value) ? result.value : [];
    const status = [`Filled ${fields.length} field${fields.length === 1 ? "" : "s"}:`, ...filled.map((f) => `  - ${f}`)].join("\n");
    return actionResult(context, status, result, { snapshot });
  },
});
