import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { ExtensionBridge, type BridgeOptions } from "./bridge";
import { APP_NAME } from "./config";
import { Context, type ContextOptions } from "./context";
import { log } from "./log";
import { tools } from "./tools";

export type ServerOptions = BridgeOptions & ContextOptions & { version: string };

export type BrowserMcpServer = {
  mcp: McpServer;
  bridge: ExtensionBridge;
  close: () => Promise<void>;
};

export async function createServer(options: ServerOptions): Promise<BrowserMcpServer> {
  const bridge = new ExtensionBridge(options);
  const context = new Context(bridge, options);
  const mcp = new McpServer({ name: APP_NAME, version: options.version });

  for (const tool of tools) {
    mcp.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      },
      async (args) => {
        try {
          return await tool.handle(context, args);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log.debug(`${tool.name} failed:`, message);
          return { content: [{ type: "text", text: message }], isError: true };
        }
      },
    );
  }

  await bridge.start();

  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      await bridge.close();
      await mcp.close();
    })());

  return { mcp, bridge, close };
}
