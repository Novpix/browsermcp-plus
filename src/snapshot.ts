import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { Context } from "./context";
import { isActionReport, type ActionReport } from "./protocol";

export type PageSnapshot = { url: string; title: string; snapshot: string };

export async function readPageSnapshot(context: Context): Promise<PageSnapshot> {
  // Sequential on purpose: the extension serves requests for one tab and the
  // snapshot should reflect the URL and title read just before it.
  const url = await context.send("getUrl", undefined);
  const title = await context.send("getTitle", undefined);
  const snapshot = await context.send("browser_snapshot", {});
  return { url, title, snapshot };
}

function truncate(body: string, maxChars: number): string {
  if (maxChars <= 0 || body.length <= maxChars) return body;
  // Cut at a line boundary so no half element line is shown.
  const cut = body.lastIndexOf("\n", maxChars);
  return (
    body.slice(0, cut > 0 ? cut : maxChars) +
    `\n# … truncated (${body.length} characters). Use browser_find to locate elements, or browser_snapshot with a ref to see one part of the page.`
  );
}

function yamlBlock(body: string, maxChars: number): string[] {
  return ["- Page Snapshot", "```yaml", truncate(body, maxChars), "```"];
}

export function formatSnapshot(
  page: PageSnapshot,
  options: { status?: string; maxChars?: number } = {},
): string {
  const { status, maxChars = 0 } = options;
  return [
    ...(status ? [status, ""] : []),
    `- Page URL: ${page.url}`,
    `- Page Title: ${page.title}`,
    ...yamlBlock(page.snapshot, maxChars),
  ].join("\n");
}

export async function snapshotResult(
  context: Context,
  status?: string,
): Promise<CallToolResult> {
  const page = await readPageSnapshot(context);
  return {
    content: [
      { type: "text", text: formatSnapshot(page, { status, maxChars: context.snapshotMaxChars }) },
    ],
  };
}

/**
 * Result of a page action: what happened (navigation, dialog, new tabs) and,
 * when asked for, the page snapshot. Works with the Plus extension's report
 * and with the original extension, which reports nothing.
 */
export async function actionResult(
  context: Context,
  status: string,
  result: unknown,
  options: { snapshot?: boolean } = {},
): Promise<CallToolResult> {
  const wantSnapshot = options.snapshot ?? context.actionSnapshots;
  const report: ActionReport = isActionReport(result)
    ? result
    : {
        url: await context.send("getUrl", undefined),
        title: await context.send("getTitle", undefined),
        navigated: false,
      };

  const lines = [status, ""];
  lines.push(`- Page URL: ${report.url}`, `- Page Title: ${report.title}`);
  if (report.navigated) lines.push("- The action loaded a new page.");
  for (const tab of report.newTabs ?? []) {
    lines.push(
      `- New tab opened: [${tab.id}] ${tab.title || tab.url} — ${tab.url}. Use browser_tab_select to work in it.`,
    );
  }
  if (report.dialog) {
    const { type, message } = report.dialog;
    lines.push(
      `- A JavaScript ${type} dialog is open: ${JSON.stringify(message)}. The page is blocked until you call browser_handle_dialog.`,
    );
  } else if (wantSnapshot) {
    const snapshot = await context.send("browser_snapshot", {});
    lines.push(...yamlBlock(snapshot, context.snapshotMaxChars));
  } else if (report.navigated) {
    lines.push("- Use browser_snapshot or browser_find to see the new page.");
  }
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

/** The part of a snapshot rooted at `ref`, or undefined if the ref is not in it. */
export function snapshotSubtree(snapshot: string, ref: string): string | undefined {
  const lines = snapshot.split("\n");
  const start = lines.findIndex((line) => line.includes(`[ref=${ref}]`));
  if (start < 0) return undefined;
  const indent = indentOf(lines[start]);
  let end = start + 1;
  while (end < lines.length && indentOf(lines[end]) > indent) end++;
  return lines
    .slice(start, end)
    .map((line) => line.slice(indent))
    .join("\n");
}

/**
 * Lines of a snapshot that contain `query` (case-insensitive), each shown with
 * its ancestors so the agent sees where it is, plus its direct children.
 */
export function findInSnapshot(
  snapshot: string,
  query: string,
  maxMatches = 30,
): { text: string; matches: number } {
  const lines = snapshot.split("\n");
  const needle = query.toLowerCase();
  const keep = new Set<number>();
  let matches = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].toLowerCase().includes(needle)) continue;
    matches++;
    if (matches > maxMatches) continue;
    keep.add(i);
    // Ancestors: the nearest preceding line at each smaller indentation.
    let indent = indentOf(lines[i]);
    for (let j = i - 1; j >= 0 && indent > 0; j--) {
      const own = indentOf(lines[j]);
      if (own < indent) {
        keep.add(j);
        indent = own;
      }
    }
    // Direct children (e.g. a link's /url, an option list).
    const childIndent = indentOf(lines[i]) + 2;
    for (let j = i + 1; j < lines.length && indentOf(lines[j]) >= childIndent; j++) {
      if (indentOf(lines[j]) === childIndent) keep.add(j);
    }
  }
  const text = [...keep]
    .sort((a, b) => a - b)
    .map((i) => lines[i])
    .join("\n");
  return { text, matches };
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}
