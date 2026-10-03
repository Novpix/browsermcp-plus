import { evaluate, fillForm, handleDialog, scroll, tabClose, tabList, tabNew, tabSelect, uploadFile } from "./plus";
import { click, drag, hover, pressKey, selectOption, type } from "./interaction";
import { goBack, goForward, navigate, reload } from "./navigation";
import { find, getConsoleLogs, screenshot, snapshot, wait, waitFor } from "./page";
import type { Tool } from "./tool";

export const tools: Tool[] = [
  navigate,
  goBack,
  goForward,
  reload,
  snapshot,
  find,
  click,
  hover,
  type,
  selectOption,
  drag,
  pressKey,
  wait,
  waitFor,
  getConsoleLogs,
  screenshot,
  // Browser MCP Plus extension only.
  fillForm,
  handleDialog,
  uploadFile,
  evaluate,
  scroll,
  tabList,
  tabNew,
  tabSelect,
  tabClose,
];
