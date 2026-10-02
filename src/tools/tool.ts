import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";

import type { Context } from "../context";

export type Tool<Schema extends z.ZodObject = z.ZodObject> = {
  name: string;
  description: string;
  inputSchema: Schema;
  annotations: ToolAnnotations;
  handle: (context: Context, args: z.infer<Schema>) => Promise<CallToolResult>;
};

/** Identity helper that infers handler argument types from the schema. */
export function defineTool<Schema extends z.ZodObject>(tool: Tool<Schema>): Tool {
  return tool as unknown as Tool;
}

/** Shared annotation presets (hints for clients deciding on confirmation prompts). */
export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  openWorldHint: true,
};

export const NAVIGATION: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: true,
};

/** Actions that can submit forms or otherwise change state on a website. */
export const PAGE_MUTATION: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: true,
};

export function text(value: string): CallToolResult {
  return { content: [{ type: "text", text: value }] };
}

/** Shortens user-provided text echoed back in results. */
export function preview(value: string, max = 80): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
