import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";

import { NO_CONNECTION_MESSAGE } from "../src/config";
import { ExtensionConnection } from "../src/protocol";
import { freePort } from "./helpers";

/** Server side holds the ExtensionConnection; the client plays the extension. */
async function pair() {
  const port = await freePort();
  const wss = new WebSocketServer({ port, host: "127.0.0.1" });
  const serverSide = new Promise<WebSocket>((resolve) => wss.once("connection", resolve));
  const extension = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((resolve) => extension.once("open", resolve));
  const connection = new ExtensionConnection(await serverSide);
  cleanups.push(() => {
    extension.terminate();
    wss.close();
  });
  return { connection, extension };
}

function respond(extension: WebSocket, answer: (msg: any) => object | undefined) {
  extension.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    const payload = answer(msg);
    if (payload) {
      extension.send(
        JSON.stringify({ type: "messageResponse", payload: { requestId: msg.id, ...payload } }),
      );
    }
  });
}

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((fn) => fn()));

describe("ExtensionConnection", () => {
  it("sends {id,type,payload} and resolves with the matching result", async () => {
    const { connection, extension } = await pair();
    const seen: any[] = [];
    respond(extension, (msg) => {
      seen.push(msg);
      return { result: `title-of-${msg.id}` };
    });
    const [a, b] = await Promise.all([
      connection.request("getTitle", undefined, 1_000),
      connection.request("getUrl", undefined, 1_000),
    ]);
    expect(seen.map((m) => m.type)).toEqual(["getTitle", "getUrl"]);
    expect(a).toBe(`title-of-${seen[0].id}`);
    expect(b).toBe(`title-of-${seen[1].id}`);
  });

  it("maps the extension's 'No tab is connected' error to an actionable message", async () => {
    const { connection, extension } = await pair();
    respond(extension, () => ({ error: "No tab is connected" }));
    await expect(connection.request("getUrl", undefined, 1_000)).rejects.toThrow(
      NO_CONNECTION_MESSAGE,
    );
  });

  it("passes other extension errors through", async () => {
    const { connection, extension } = await pair();
    respond(extension, () => ({ error: "Element not found" }));
    await expect(
      connection.request("browser_click", { element: "x", ref: "r" }, 1_000),
    ).rejects.toThrow("Element not found");
  });

  it("rejects pending requests immediately when the socket closes", async () => {
    const { connection, extension } = await pair();
    respond(extension, () => {
      extension.close();
      return undefined;
    });
    const started = Date.now();
    await expect(connection.request("browser_snapshot", {}, 10_000)).rejects.toThrow(
      /disconnected/,
    );
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(connection.isOpen).toBe(false);
  });

  it("times out when the extension never answers", async () => {
    const { connection } = await pair();
    await expect(connection.request("browser_snapshot", {}, 100)).rejects.toThrow(
      /within 100 ms/,
    );
  });

  it("ignores malformed and unrelated messages", async () => {
    const { connection, extension } = await pair();
    extension.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      extension.send("not json");
      extension.send(JSON.stringify({ type: "somethingElse", payload: {} }));
      extension.send(JSON.stringify({ type: "messageResponse", payload: { requestId: "other" } }));
      extension.send(
        JSON.stringify({ type: "messageResponse", payload: { requestId: msg.id, result: "ok" } }),
      );
    });
    await expect(connection.request("getUrl", undefined, 1_000)).resolves.toBe("ok");
  });
});
