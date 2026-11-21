import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

/** One tool call as the MCP script forwards it. */
export type ChannelCall = { callId: unknown; arguments: unknown };
export type ChannelAnswer = { ok: boolean; text: string };
export type ChannelHandler = (call: ChannelCall) => Promise<ChannelAnswer>;

const UNAUTHORIZED: ChannelAnswer = {
  ok: false,
  text: "This workflow step channel rejected the call.",
};

function sameToken(expected: string, received: unknown): boolean {
  if (typeof received !== "string") return false;
  const hash = (value: string) => crypto.createHash("sha256").update(value).digest();
  return crypto.timingSafeEqual(hash(expected), hash(received));
}

/**
 * The private line between an acpx step's MCP script and its executor: a unix socket inside a
 * temp folder only this process can enter, plus a per-step token the script must present. A call
 * without the token never reaches the handler. Calls are answered one at a time, in arrival order.
 */
export class SubmissionChannel {
  readonly token = crypto.randomBytes(24).toString("hex");
  private readonly sockets = new Set<net.Socket>();
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly dir: string,
    readonly socketPath: string,
    private readonly server: net.Server,
  ) {}

  static async open(handler: ChannelHandler): Promise<SubmissionChannel> {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pwx-"));
    const socketPath = path.join(dir, "s");
    const server = net.createServer();
    const channel = new SubmissionChannel(dir, socketPath, server);
    server.on("connection", (socket) => channel.serve(socket, handler));
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });
    } catch (error) {
      await fs.promises.rm(dir, { recursive: true, force: true });
      throw error;
    }
    return channel;
  }

  /** Environment for the MCP script: where to connect, the token, and the tool schema. */
  env(schema: unknown): Record<string, string> {
    return {
      PI_WORKFLOWS_ACPX_SOCKET: this.socketPath,
      PI_WORKFLOWS_ACPX_TOKEN: this.token,
      PI_WORKFLOWS_ACPX_SCHEMA: JSON.stringify(schema),
    };
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await fs.promises.rm(this.dir, { recursive: true, force: true });
  }

  private serve(socket: net.Socket, handler: ChannelHandler): void {
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    // The script drops the connection when it exits; nothing is left to answer.
    socket.on("error", () => undefined);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end === -1) return;
      const line = buffer.slice(0, end);
      buffer = "";
      void this.answer(line, handler).then((answer) => socket.end(`${JSON.stringify(answer)}\n`));
    });
  }

  private answer(line: string, handler: ChannelHandler): Promise<ChannelAnswer> {
    const next = this.queue.then(async () => {
      try {
        const parsed = JSON.parse(line) as { token?: unknown } & ChannelCall;
        if (!sameToken(this.token, parsed.token)) return UNAUTHORIZED;
        return await handler({ callId: parsed.callId, arguments: parsed.arguments });
      } catch (error) {
        return { ok: false, text: error instanceof Error ? error.message : String(error) };
      }
    });
    this.queue = next;
    return next;
  }
}
