/**
 * Minimal stderr logger. stdout is reserved for the MCP stdio transport, so
 * nothing may ever be written there.
 */

let verbose = false;

export function setVerbose(value: boolean) {
  verbose = value;
}

export const log = {
  debug(...args: unknown[]) {
    if (verbose) console.error("[browsermcp]", ...args);
  },
  info(...args: unknown[]) {
    console.error("[browsermcp]", ...args);
  },
  error(...args: unknown[]) {
    console.error("[browsermcp] error:", ...args);
  },
};
