#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Command, InvalidArgumentError } from "commander";

import packageJSON from "../package.json";
import {
  DEFAULT_ALLOWED_ORIGINS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_SNAPSHOT_MAX_CHARS,
  DEFAULT_WS_PORT,
} from "./config";
import { log, setVerbose } from "./log";
import { createServer } from "./server";

function integer(min: number) {
  return (value: string) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < min) {
      throw new InvalidArgumentError(`Expected an integer >= ${min}.`);
    }
    return parsed;
  };
}

const program = new Command()
  .name("browsermcp-plus")
  .description("MCP server that lets AI apps automate your own browser through the Browser MCP Plus extension")
  .version(packageJSON.version)
  .option(
    "--port <number>",
    "WebSocket port the extension connects to (the original Browser MCP extension always uses 9009)",
    integer(1),
    DEFAULT_WS_PORT,
  )
  .option(
    "--allow-origin <origin...>",
    `additional origins allowed to connect as the extension (always allowed: ${DEFAULT_ALLOWED_ORIGINS.join(", ")})`,
    [],
  )
  .option("--no-takeover", "do not ask an already running server to hand over the port")
  .option(
    "--kill-existing",
    "terminate whatever listens on the port if it does not hand it over (pre-0.2 behaviour)",
    false,
  )
  .option(
    "--request-timeout <ms>",
    "timeout for a single browser action",
    integer(1),
    DEFAULT_REQUEST_TIMEOUT_MS,
  )
  .option(
    "--snapshot-max-chars <n>",
    "truncate page snapshots longer than this (0 = never)",
    integer(0),
    DEFAULT_SNAPSHOT_MAX_CHARS,
  )
  .option(
    "--action-snapshots",
    "append the page snapshot to every action result (default: only navigation does; actions return a short report)",
    false,
  )
  .option("--verbose", "log debug output to stderr", false);

type CliOptions = {
  port: number;
  allowOrigin: string[];
  takeover: boolean;
  killExisting: boolean;
  requestTimeout: number;
  snapshotMaxChars: number;
  actionSnapshots: boolean;
  verbose: boolean;
};

async function main() {
  program.parse();
  const options = program.opts<CliOptions>();
  setVerbose(options.verbose);

  const server = await createServer({
    version: packageJSON.version,
    port: options.port,
    allowedOrigins: [...DEFAULT_ALLOWED_ORIGINS, ...options.allowOrigin],
    takeover: options.takeover,
    killExisting: options.killExisting,
    requestTimeoutMs: options.requestTimeout,
    snapshotMaxChars: options.snapshotMaxChars,
    actionSnapshots: options.actionSnapshots,
  });

  let shuttingDown = false;
  const shutdown = async (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.debug(`Shutting down (${reason})`);
    setTimeout(() => process.exit(0), 5_000).unref();
    try {
      await server.close();
    } finally {
      process.exit(0);
    }
  };

  process.stdin.on("close", () => void shutdown("stdin closed"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await server.mcp.connect(new StdioServerTransport());
}

main().catch((error) => {
  log.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
