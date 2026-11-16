import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { DownloadInfo, FileResult } from "../protocol";
import { defineTool, NAVIGATION, READ_ONLY, text } from "./tool";

// Files the browser can see: fetched with its logins, or downloaded.

/** Images up to this size come back inline as well, so the model sees them. */
const MAX_INLINE_IMAGE_BYTES = 4 * 1024 * 1024;
/** Text files up to this many characters are shown inline too. */
const MAX_INLINE_TEXT = 20_000;
const INLINE_IMAGES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const EXTENSIONS: Record<string, string> = {
  "application/pdf": ".pdf",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "text/plain": ".txt",
  "text/csv": ".csv",
  "text/html": ".html",
  "application/json": ".json",
  "application/zip": ".zip",
};

/** Where fetched files go; `BROWSERMCP_FILES_DIR` overrides it. */
export function filesDir(): string {
  return process.env.BROWSERMCP_FILES_DIR || path.join(os.tmpdir(), "browsermcp-plus", "files");
}

/** A safe file name from Content-Disposition, the URL, or the type. */
export function fileNameFor(file: Pick<FileResult, "url" | "mimeType" | "disposition">): string {
  const mime = file.mimeType.split(";")[0].trim().toLowerCase();
  let name = "";
  const disposition = file.disposition ?? "";
  const star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(disposition);
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(disposition);
  try {
    name = star ? decodeURIComponent(star[1].trim()) : plain ? plain[1].trim() : "";
  } catch {
    name = plain?.[1].trim() ?? "";
  }
  if (!name) {
    try {
      const url = new URL(file.url);
      if (url.protocol !== "data:" && url.protocol !== "blob:") name = decodeURIComponent(path.posix.basename(url.pathname));
    } catch {
      // not a URL
    }
  }
  name = name.replace(/[/\\?%*:|"<>\x00-\x1f]/g, "_").replace(/^\.+/, "").slice(0, 120) || "file";
  if (!path.extname(name) && EXTENSIONS[mime]) name += EXTENSIONS[mime];
  return name;
}

export const getFile = defineTool({
  name: "browser_get_file",
  description:
    "Get a file the browser can reach, with its logins: a PDF or image on the page, a link's target, or any URL. Images come back so you can see them; every file is saved locally and its path returned (open PDFs from there). With no arguments: the file the tab shows (e.g. a PDF).",
  inputSchema: z.object({
    url: z.string().min(1).optional().describe("Address of the file"),
    element: z.string().optional().describe("Human-readable description of the element"),
    ref: z.string().min(1).optional().describe("An image, link, embed or video from the snapshot"),
  }),
  annotations: READ_ONLY,
  handle: async (context, { url, ref }) => {
    const file = await context.send("browser_get_file", { url, ref }, { timeoutMs: 60_000 });
    const data = Buffer.from(file.base64, "base64");
    const dir = filesDir();
    await mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
    const saved = path.join(dir, `${stamp}-${fileNameFor(file)}`);
    await writeFile(saved, data);
    const mime = file.mimeType.split(";")[0].trim().toLowerCase();
    const lines = [`Saved ${file.url} (${mime || "unknown type"}, ${formatBytes(data.length)}) to ${saved}`];
    const content: CallToolResult["content"] = [];
    if (mime === "application/pdf") {
      lines.push("Open the PDF from that path with your file reader to read its pages.");
    } else if (mime.startsWith("text/") || mime === "application/json") {
      const body = data.toString("utf8");
      lines.push("", body.length > MAX_INLINE_TEXT ? `${body.slice(0, MAX_INLINE_TEXT)}\n[… ${body.length - MAX_INLINE_TEXT} more characters in the file]` : body);
    }
    content.push({ type: "text", text: lines.join("\n") });
    if (INLINE_IMAGES.has(mime) && data.length <= MAX_INLINE_IMAGE_BYTES) {
      content.push({ type: "image", data: file.base64, mimeType: mime });
    }
    return { content };
  },
});

export const downloads = defineTool({
  name: "browser_downloads",
  description:
    "List the browser's recent downloads with where each file is saved. Pass wait to wait (up to that many seconds) for running downloads to finish.",
  inputSchema: z.object({
    wait: z.number().min(0).max(300).optional().describe("Seconds to wait for running downloads (default 0)"),
    limit: z.number().int().min(1).max(50).optional().describe("How many downloads to list (default 10)"),
  }),
  annotations: READ_ONLY,
  handle: async (context, { wait = 0, limit = 10 }) => {
    const deadline = Date.now() + wait * 1000;
    let items = await context.send("browser_downloads", { limit });
    while (items.some((d) => d.state === "in_progress") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      items = await context.send("browser_downloads", { limit });
    }
    if (!items.length) return text("No downloads.");
    return text(items.map(formatDownload).join("\n"));
  },
});

export const download = defineTool({
  name: "browser_download",
  description:
    "Download a file with the browser (its logins and cookies apply) into the user's download folder, and return where it was saved",
  inputSchema: z.object({
    url: z.string().min(1).describe("Address of the file to download"),
  }),
  annotations: NAVIGATION,
  handle: async (context, { url }) => {
    const item = await context.send("browser_download", { url });
    const status =
      item.state === "in_progress"
        ? "Still downloading; browser_downloads with wait reports when it is done."
        : item.state === "complete"
          ? "Downloaded."
          : "The download failed.";
    return text(`${status}\n${formatDownload(item)}`);
  },
});

export function formatDownload(item: DownloadInfo): string {
  const size = item.totalBytes > 0 ? formatBytes(item.totalBytes) : formatBytes(item.bytes);
  const progress =
    item.state === "in_progress" && item.totalBytes > 0
      ? ` ${Math.round((item.bytes / item.totalBytes) * 100)}%`
      : "";
  const problems = [item.error && `error: ${item.error}`, item.danger && `flagged by Chrome: ${item.danger}`].filter(Boolean);
  return `- [${item.state}${progress}] ${item.path || "(name not decided yet)"} — ${size}, from ${item.url}${problems.length ? ` (${problems.join("; ")})` : ""}`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} kB`;
  return `${bytes} bytes`;
}
