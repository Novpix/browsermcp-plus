import { z } from "zod";

import { findInSnapshot, formatSnapshot, readPageSnapshot, snapshotResult, snapshotSubtree } from "../snapshot";
import { defineTool, READ_ONLY, text } from "./tool";

export const snapshot = defineTool({
  name: "browser_snapshot",
  description:
    "Capture accessibility snapshot of the current page. Use this for getting references to elements to interact with. Pass a ref to see only that part of the page.",
  inputSchema: z.object({
    ref: z.string().min(1).optional().describe("Only return the subtree of this element"),
  }),
  annotations: READ_ONLY,
  handle: async (context, { ref }) => {
    if (!ref) return snapshotResult(context);
    const page = await readPageSnapshot(context);
    const subtree = snapshotSubtree(page.snapshot, ref);
    if (subtree === undefined) {
      throw new Error(`Element "${ref}" is not on the current page. Take a full snapshot first.`);
    }
    return text(formatSnapshot({ ...page, snapshot: subtree }, { maxChars: context.snapshotMaxChars }));
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
    const page = await readPageSnapshot(context);
    const { text: found, matches } = findInSnapshot(page.snapshot, args.text);
    const header = [`- Page URL: ${page.url}`, `- Page Title: ${page.title}`];
    if (!matches) return text([...header, `No elements match ${JSON.stringify(args.text)}.`].join("\n"));
    const shown = matches > 30 ? ` (showing the first 30 of ${matches})` : "";
    return text(
      [...header, `- ${matches} match${matches === 1 ? "" : "es"}${shown}`, "```yaml", found, "```"].join("\n"),
    );
  },
});

export const screenshot = defineTool({
  name: "browser_screenshot",
  description: "Take a screenshot of the visible part of the current page",
  inputSchema: z.object({}),
  annotations: READ_ONLY,
  handle: async (context) => {
    const data = await context.send("browser_screenshot", {});
    return { content: [{ type: "image", data, mimeType: "image/png" }] };
  },
});

export const getConsoleLogs = defineTool({
  name: "browser_get_console_logs",
  description: "Get the console logs from the browser",
  inputSchema: z.object({}),
  annotations: READ_ONLY,
  handle: async (context) => {
    const logs = await context.send("browser_get_console_logs", {});
    if (!Array.isArray(logs) || logs.length === 0) {
      return text("No console logs captured.");
    }
    return text(logs.map((entry) => JSON.stringify(entry)).join("\n"));
  },
});

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
  handle: async (context, { time }) => {
    // The request must outlive the wait itself.
    await context.send("browser_wait", { time }, {
      timeoutMs: time * 1000 + context.requestTimeoutMs,
    });
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
