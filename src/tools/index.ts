import { evaluate, scroll, tabClose, tabList, tabNew, tabSelect, uploadFile } from "./companion";
import { click, drag, hover, pressKey, selectOption, type } from "./interaction";
import { goBack, goForward, navigate, reload } from "./navigation";
import { getConsoleLogs, screenshot, snapshot, wait, waitFor } from "./page";
import type { Tool } from "./tool";

export const tools: Tool[] = [
  navigate,
  goBack,
  goForward,
  reload,
  snapshot,
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
  // Companion extension only.
  uploadFile,
  evaluate,
  scroll,
  tabList,
  tabNew,
  tabSelect,
  tabClose,
];
