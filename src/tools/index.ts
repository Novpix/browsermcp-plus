import { download, downloads, getFile } from "./files";
import { evaluate, fillForm, handleDialog, scroll, tabClose, tabHandoff, tabList, tabNew, tabSelect, uploadFile } from "./plus";
import { click, drag, hover, pressKey, selectOption, type } from "./interaction";
import { goBack, goForward, navigate, reload } from "./navigation";
import { find, getConsoleLogs, getText, screenshot, snapshot, wait, waitFor } from "./page";
import { profileSelect, profiles } from "./profiles";
import type { Tool } from "./tool";

export const tools: Tool[] = [
  navigate,
  goBack,
  goForward,
  reload,
  snapshot,
  find,
  getText,
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
  tabHandoff,
  getFile,
  downloads,
  download,
  // Chrome profiles: work with another Google account.
  profiles,
  profileSelect,
];
