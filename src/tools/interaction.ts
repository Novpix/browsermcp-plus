import { z } from "zod";

import { isActionReport } from "../protocol";
import { actionResult } from "../snapshot";
import { defineTool, NAVIGATION, PAGE_MUTATION, preview, snapshotOption } from "./tool";

const element = z
  .string()
  .describe(
    "Human-readable element description used to obtain permission to interact with the element",
  );
const ref = z.string().min(1).describe("Exact target element reference from the page snapshot");

export const click = defineTool({
  name: "browser_click",
  description:
    "Click an element. Fails with an explanation if the element is disabled or covered by another element (e.g. a cookie banner).",
  inputSchema: z.object({ element, ref, snapshot: snapshotOption("no") }),
  annotations: PAGE_MUTATION,
  handle: async (context, { snapshot, ...args }) => {
    const result = await context.send("browser_click", args);
    return actionResult(context, `Clicked "${args.element}"`, result, { snapshot });
  },
});

export const hover = defineTool({
  name: "browser_hover",
  description: "Hover over element on page",
  inputSchema: z.object({ element, ref, snapshot: snapshotOption("no") }),
  annotations: NAVIGATION,
  handle: async (context, { snapshot, ...args }) => {
    const result = await context.send("browser_hover", args);
    return actionResult(context, `Hovered over "${args.element}"`, result, { snapshot });
  },
});

export const type = defineTool({
  name: "browser_type",
  description:
    "Type text into an editable element, replacing its content. To fill several fields at once, prefer browser_fill_form.",
  inputSchema: z.object({
    element,
    ref,
    text: z.string().describe("Text to type into the element"),
    submit: z
      .boolean()
      .default(false)
      .describe("Whether to submit entered text (press Enter after)"),
    slowly: z
      .boolean()
      .optional()
      .describe(
        "Type one key at a time, for inputs that format as you type (phone, card or date masks). Slower.",
      ),
    snapshot: snapshotOption("no"),
  }),
  annotations: PAGE_MUTATION,
  handle: async (context, { snapshot, ...args }) => {
    const result = await context.send("browser_type", args);
    const submitted = args.submit ? " and submitted" : "";
    let status = `Typed "${preview(args.text)}" into "${args.element}"${submitted}`;
    // Report what the field actually holds: masks and max lengths change input.
    const value = isActionReport(result) ? result.value : undefined;
    if (typeof value === "string" && value !== args.text && !/^•+$/.test(value)) {
      status += `; the field now contains ${JSON.stringify(preview(value))}`;
    }
    return actionResult(context, status, result, { snapshot });
  },
});

export const selectOption = defineTool({
  name: "browser_select_option",
  description: "Select an option in a dropdown",
  inputSchema: z.object({
    element,
    ref,
    values: z
      .array(z.string())
      .min(1)
      .describe(
        "Array of values to select in the dropdown. This can be a single value or multiple values.",
      ),
    snapshot: snapshotOption("no"),
  }),
  annotations: PAGE_MUTATION,
  handle: async (context, { snapshot, ...args }) => {
    const result = await context.send("browser_select_option", args);
    return actionResult(
      context,
      `Selected ${args.values.map((v) => `"${v}"`).join(", ")} in "${args.element}"`,
      result,
      { snapshot },
    );
  },
});

export const drag = defineTool({
  name: "browser_drag",
  description: "Perform drag and drop between two elements",
  inputSchema: z.object({
    startElement: z
      .string()
      .describe(
        "Human-readable source element description used to obtain the permission to interact with the element",
      ),
    startRef: z.string().min(1).describe("Exact source element reference from the page snapshot"),
    endElement: z
      .string()
      .describe(
        "Human-readable target element description used to obtain the permission to interact with the element",
      ),
    endRef: z.string().min(1).describe("Exact target element reference from the page snapshot"),
    snapshot: snapshotOption("no"),
  }),
  annotations: PAGE_MUTATION,
  handle: async (context, { snapshot, ...args }) => {
    const result = await context.send("browser_drag", args);
    return actionResult(
      context,
      `Dragged "${args.startElement}" to "${args.endElement}"`,
      result,
      { snapshot },
    );
  },
});

export const pressKey = defineTool({
  name: "browser_press_key",
  description:
    "Press a key or shortcut, e.g. `Enter`, `Escape`, `Tab`, `ArrowDown`, `PageDown` (scrolls), `Control+a` or a single character",
  inputSchema: z.object({
    key: z
      .string()
      .min(1)
      .describe("Name of the key to press or a character to generate, such as `ArrowLeft` or `a`"),
    snapshot: snapshotOption("no"),
  }),
  annotations: PAGE_MUTATION,
  handle: async (context, { key, snapshot }) => {
    const result = await context.send("browser_press_key", { key });
    return actionResult(context, `Pressed key ${key}`, result, { snapshot });
  },
});
