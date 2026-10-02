import { z } from "zod";

import { actionResult } from "../snapshot";
import { defineTool, NAVIGATION, PAGE_MUTATION, preview } from "./tool";

const element = z
  .string()
  .describe(
    "Human-readable element description used to obtain permission to interact with the element",
  );
const ref = z.string().min(1).describe("Exact target element reference from the page snapshot");

export const click = defineTool({
  name: "browser_click",
  description: "Perform click on a web page",
  inputSchema: z.object({ element, ref }),
  annotations: PAGE_MUTATION,
  handle: async (context, args) => {
    await context.send("browser_click", args);
    return actionResult(context, `Clicked "${args.element}"`);
  },
});

export const hover = defineTool({
  name: "browser_hover",
  description: "Hover over element on page",
  inputSchema: z.object({ element, ref }),
  annotations: NAVIGATION,
  handle: async (context, args) => {
    await context.send("browser_hover", args);
    return actionResult(context, `Hovered over "${args.element}"`);
  },
});

export const type = defineTool({
  name: "browser_type",
  description: "Type text into editable element",
  inputSchema: z.object({
    element,
    ref,
    text: z.string().describe("Text to type into the element"),
    submit: z
      .boolean()
      .default(false)
      .describe("Whether to submit entered text (press Enter after)"),
  }),
  annotations: PAGE_MUTATION,
  handle: async (context, args) => {
    await context.send("browser_type", args);
    const submitted = args.submit ? " and submitted" : "";
    return actionResult(
      context,
      `Typed "${preview(args.text)}" into "${args.element}"${submitted}`,
    );
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
  }),
  annotations: PAGE_MUTATION,
  handle: async (context, args) => {
    await context.send("browser_select_option", args);
    return actionResult(
      context,
      `Selected ${args.values.map((v) => `"${v}"`).join(", ")} in "${args.element}"`,
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
  }),
  annotations: PAGE_MUTATION,
  handle: async (context, args) => {
    await context.send("browser_drag", args);
    return actionResult(
      context,
      `Dragged "${args.startElement}" to "${args.endElement}"`,
    );
  },
});

export const pressKey = defineTool({
  name: "browser_press_key",
  description:
    "Press a key on the keyboard, e.g. `Enter`, `Escape`, `Tab`, `ArrowDown`, `PageDown` (scrolls), `End` or a single character",
  inputSchema: z.object({
    key: z
      .string()
      .min(1)
      .describe("Name of the key to press or a character to generate, such as `ArrowLeft` or `a`"),
  }),
  annotations: PAGE_MUTATION,
  handle: async (context, { key }) => {
    await context.send("browser_press_key", { key });
    return actionResult(context, `Pressed key ${key}`);
  },
});
