import { z } from "zod";

import { findInSnapshot, formatSnapshot, pageOf, readPageSnapshot, snapshotSubtree } from "../snapshot";
import { defineTool, READ_ONLY, text } from "./tool";

export const snapshot = defineTool({
  name: "browser_snapshot",
  description:
    "Capture the accessibility snapshot of the current page, frames from other sites included. Use it to get refs for elements to interact with. Pass a ref to see only that part, or an offset to continue a long snapshot. To read long text (an email, an article), browser_get_text is better.",
  inputSchema: z.object({
    ref: z.string().min(1).optional().describe("Only return the subtree of this element"),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Continue a truncated snapshot from this character (given at its end)"),
  }),
  annotations: READ_ONLY,
  handle: async (context, { ref, offset }) => {
    const page = await readPageSnapshot(context);
    if (!ref) return text(formatSnapshot(page, { maxChars: context.snapshotMaxChars, offset }));
    const subtree = snapshotSubtree(page.snapshot, ref);
    if (subtree === undefined) {
      throw new Error(`Element "${ref}" is not on the current page. Take a full snapshot first.`);
    }
    return text(formatSnapshot({ ...page, snapshot: subtree }, { maxChars: context.snapshotMaxChars, offset }));
  },
});

const DEFAULT_TEXT_CHARS = 30_000;

export const getText = defineTool({
  name: "browser_get_text",
  description:
    "Read the page's text the way a person reads it — headings, paragraphs, lists, tables, links — in full (nothing clipped), frames from other sites included. Pass a ref (e.g. an email body or article from the snapshot) or a CSS selector to read only that part. Long text comes in pages: continue with the offset given at the end.",
  inputSchema: z.object({
    ref: z.string().min(1).optional().describe("Read only this element (a ref from the snapshot)"),
    selector: z.string().min(1).optional().describe("Read only the first element matching this CSS selector"),
    offset: z.number().int().min(0).optional().describe("Continue from this character (given at the end of a page)"),
    maxChars: z
      .number()
      .int()
      .min(1_000)
      .max(200_000)
      .optional()
      .describe(`Characters per page (default ${DEFAULT_TEXT_CHARS})`),
    links: z.boolean().optional().describe("Include link addresses as [text](url) (default true)"),
  }),
  annotations: READ_ONLY,
  handle: async (context, { ref, selector, offset = 0, maxChars = DEFAULT_TEXT_CHARS, links }) => {
    const result = await context.send("browser_get_text", { ref, selector, links });
    const total = result.text.length;
    const body = pageOf(
      result.text,
      maxChars,
      offset,
      (next, left) => `[… ${left} more characters: call browser_get_text with offset: ${next}${ref ? ` and ref: "${ref}"` : ""}${selector ? " and the same selector" : ""} to continue]`,
    );
    const scope = ref ? ` of ${ref}` : selector ? ` of ${selector}` : "";
    return text(
      [`- Page URL: ${result.url}`, `- Page Title: ${result.title}`, `- Text${scope} (${total} characters):`, "", body || "(no text)"].join(
        "\n",
      ),
    );
  },
});

export const find = defineTool({
  name: "browser_find",
  description:
    "Search the page snapshot for text (case-insensitive) and return only the matching elements with their refs and position in the page. Much smaller than a full snapshot.",
  inputSchema: z.object({
    text: z.string().min(1).describe("Text to look for in element names, values, text and URLs"),
  }),
  annotations: READ_ONLY,
  handle: async (context, args) => {
    // The extension gives a page that is still loading a moment to show the text.
    const page = await readPageSnapshot(context, args.text);
    const { text: found, matches } = findInSnapshot(page.snapshot, args.text);
    const header = [`- Page URL: ${page.url}`, `- Page Title: ${page.title}`];
    if (!matches) {
      return text(
        [
          ...header,
          `No elements match ${JSON.stringify(args.text)}. If the page is still loading content, browser_wait_for waits for text to appear; browser_get_text searches the full text.`,
        ].join("\n"),
      );
    }
    const shown = matches > 30 ? ` (showing the first 30 of ${matches})` : "";
    return text(
      [...header, `- ${matches} match${matches === 1 ? "" : "es"}${shown}`, "```yaml", found, "```"].join("\n"),
    );
  },
});

export const screenshot = defineTool({
  name: "browser_screenshot",
  description:
    "Take a screenshot of the visible part of the page, of one element (ref), or of the whole page (fullPage)",
  inputSchema: z.object({
    element: z.string().optional().describe("Human-readable description of the element"),
    ref: z.string().min(1).optional().describe("Only this element (a ref from the snapshot)"),
    fullPage: z.boolean().optional().describe("The whole page, not just what is visible"),
  }),
  annotations: READ_ONLY,
  handle: async (context, { ref, fullPage }) => {
    const data = await context.send("browser_screenshot", ref || fullPage ? { ref, fullPage } : {});
    return { content: [{ type: "image", data, mimeType: "image/png" }] };
  },
});

export const getConsoleLogs = defineTool({
  name: "browser_get_console_logs",
  description:
    "Get the page's console messages (logs, warnings, errors, uncaught exceptions) and its failed network requests (HTTP 4xx/5xx, network errors) since it loaded",
  inputSchema: z.object({}),
  annotations: READ_ONLY,
  handle: async (context) => {
    const logs = await context.send("browser_get_console_logs", {});
    if (!Array.isArray(logs) || logs.length === 0) {
      return text("No console messages or failed requests.");
    }
    return text(logs.map(formatConsoleEntry).join("\n"));
  },
});

export function formatConsoleEntry(entry: unknown): string {
  if (entry && typeof entry === "object" && typeof (entry as { message?: unknown }).message === "string") {
    const { type, message } = entry as { type?: string; message: string };
    return `[${type ?? "log"}] ${message}`;
  }
  return JSON.stringify(entry);
}

const MAX_WAIT_SECONDS = 300;

export const wait = defineTool({
  name: "browser_wait",
  description: "Wait for a specified time in seconds",
  inputSchema: z.object({
    time: z
      .number()
      .min(0)
      .max(MAX_WAIT_SECONDS)
      .describe(`The time to wait in seconds (max ${MAX_WAIT_SECONDS})`),
  }),
  annotations: READ_ONLY,
  handle: async (_context, { time }) => {
    // Waits here rather than in the extension: the extension runs requests one
    // at a time, so a wait there would block every tool called meanwhile.
    await new Promise((resolve) => setTimeout(resolve, time * 1000));
    return text(`Waited for ${time} seconds`);
  },
});

const POLL_INTERVAL_MS = 500;

export const waitFor = defineTool({
  name: "browser_wait_for",
  description:
    "Wait until text appears on (or disappears from) the page's accessibility snapshot, then return the snapshot",
  inputSchema: z.object({
    text: z.string().min(1).optional().describe("Text to wait for"),
    textGone: z.string().min(1).optional().describe("Text to wait to disappear"),
    timeout: z
      .number()
      .min(1)
      .max(120)
      .default(10)
      .describe("Maximum time to wait in seconds (default 10)"),
  }),
  annotations: READ_ONLY,
  handle: async (context, args) => {
    if (!args.text && !args.textGone) {
      throw new Error("Provide `text`, `textGone`, or both");
    }
    const matches = (snapshot: string) =>
      (!args.text || snapshot.includes(args.text)) &&
      (!args.textGone || !snapshot.includes(args.textGone));

    const startedAt = Date.now();
    const deadline = startedAt + args.timeout * 1000;
    for (;;) {
      const page = await readPageSnapshot(context);
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      if (matches(page.snapshot)) {
        return text(
          formatSnapshot(page, {
            status: `Condition met after ${elapsed}s`,
            maxChars: context.snapshotMaxChars,
          }),
        );
      }
      if (Date.now() + POLL_INTERVAL_MS > deadline) {
        return {
          ...text(
            formatSnapshot(page, {
              status: `Timed out after ${elapsed}s waiting for ${describe(args)}`,
              maxChars: context.snapshotMaxChars,
            }),
          ),
          isError: true,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  },
});

function describe(args: { text?: string; textGone?: string }) {
  return [
    args.text && `"${args.text}" to appear`,
    args.textGone && `"${args.textGone}" to disappear`,
  ]
    .filter(Boolean)
    .join(" and ");
}
