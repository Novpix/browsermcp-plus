import type { ExtensionBridge } from "./bridge";
import { DEFAULT_CONNECT_WAIT_MS, DEFAULT_REQUEST_TIMEOUT_MS } from "./config";
import { COMPANION_MESSAGES, type MessageType, type Payload, type Result } from "./protocol";

export type ContextOptions = {
  /** Timeout for a single extension request. */
  requestTimeoutMs?: number;
  /** How long to wait for the extension to connect before failing a tool call. */
  connectWaitMs?: number;
  /** Truncate page snapshots longer than this many characters (0 = never). */
  snapshotMaxChars?: number;
  /** Append a page snapshot to the result of every page action. */
  actionSnapshots?: boolean;
};

/** Everything a tool handler needs to talk to the browser. */
export class Context {
  readonly requestTimeoutMs: number;
  readonly connectWaitMs: number;
  readonly snapshotMaxChars: number;
  readonly actionSnapshots: boolean;

  constructor(
    private readonly bridge: ExtensionBridge,
    options: ContextOptions = {},
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.connectWaitMs = options.connectWaitMs ?? DEFAULT_CONNECT_WAIT_MS;
    this.snapshotMaxChars = options.snapshotMaxChars ?? 0;
    this.actionSnapshots = options.actionSnapshots ?? true;
  }

  async send<T extends MessageType>(
    type: T,
    payload: Payload<T>,
    options: { timeoutMs?: number } = {},
  ): Promise<Result<T>> {
    const connection = await this.bridge.getConnection(this.connectWaitMs);
    if (COMPANION_MESSAGES.has(type)) {
      await connection.ready;
      if (!connection.supports(type)) {
        throw new Error(
          `This tool needs the open-source Browser MCP Companion extension (extension/ in the Browser MCP repository); the connected extension does not support "${type}".`,
        );
      }
    }
    return connection.request(type, payload, options.timeoutMs ?? this.requestTimeoutMs);
  }
}
