import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { Context } from "./context";

export type PageSnapshot = { url: string; title: string; snapshot: string };

export async function readPageSnapshot(context: Context): Promise<PageSnapshot> {
  // Sequential on purpose: the extension serves requests for one tab and the
  // snapshot should reflect the URL and title read just before it.
  const url = await context.send("getUrl", undefined);
  const title = await context.send("getTitle", undefined);
  const snapshot = await context.send("browser_snapshot", {});
  return { url, title, snapshot };
}

export function formatSnapshot(
  page: PageSnapshot,
  options: { status?: string; maxChars?: number } = {},
): string {
  const { status, maxChars = 0 } = options;
  let body = page.snapshot;
  let note = "";
  if (maxChars > 0 && body.length > maxChars) {
    note = `\n(Snapshot truncated to ${maxChars} of ${body.length} characters.)`;
    body = body.slice(0, maxChars);
  }
  return [
    ...(status ? [status, ""] : []),
    `- Page URL: ${page.url}`,
    `- Page Title: ${page.title}`,
    "- Page Snapshot",
    "```yaml",
    body,
    "```",
  ].join("\n") + note;
}

export async function snapshotResult(
  context: Context,
  status?: string,
): Promise<CallToolResult> {
  const page = await readPageSnapshot(context);
  return {
    content: [
      {
        type: "text",
        text: formatSnapshot(page, { status, maxChars: context.snapshotMaxChars }),
      },
    ],
  };
}

/** Result of a page action: the status line, plus a fresh snapshot unless disabled. */
export async function actionResult(
  context: Context,
  status: string,
): Promise<CallToolResult> {
  if (context.actionSnapshots) return snapshotResult(context, status);
  return { content: [{ type: "text", text: status }] };
}
