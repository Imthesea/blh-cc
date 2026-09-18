import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolParameters } from "../core/types.js";

const PROTOCOL_VERSION = "2024-11-05";

export class MCPClient {
  private process: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();

  constructor(
    readonly name: string,
    readonly command: string,
    readonly args: string[] = [],
    readonly timeout = 30000,
  ) {}

  async start(): Promise<void> {
    this.process = spawn(this.command, this.args, { stdio: ["pipe", "pipe", "pipe"] });
    this.process.on("error", (err) =>
      this.failPending(err instanceof Error ? err : new Error(String(err))),
    );
    this.process.on("exit", (code) =>
      this.failPending(new Error(`MCP server '${this.name}' exited with code ${code}`)),
    );
    const rl = createInterface({ input: this.process.stdout });
    rl.on("line", (line) => {
      let msg: { id?: number; result?: unknown; error?: unknown };
      try {
        msg = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
      } catch {
        return;
      }
      if (typeof msg.id !== "number") return; // 无 id 的通知跳过
      const entry = this.pending.get(msg.id);
      if (entry) {
        this.pending.delete(msg.id);
        clearTimeout(entry.timer);
        entry.resolve(msg.error !== undefined ? { error: msg.error } : msg.result);
      }
    });
    const result = await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "blh", version: "0.1.0" },
    });
    if (result && typeof result === "object" && "error" in result) {
      throw new Error(`initialize failed: ${JSON.stringify(result.error)}`);
    }
    this.notify("notifications/initialized");
  }

  async listTools(): Promise<Record<string, unknown>[]> {
    const result = await this.request("tools/list", {});
    if (result && typeof result === "object" && "error" in result) {
      throw new Error(`tools/list failed: ${JSON.stringify(result.error)}`);
    }
    return (result as { tools?: Record<string, unknown>[] } | undefined)?.tools ?? [];
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<string> {
    const result = await this.request("tools/call", { name: toolName, arguments: args });
    if (result && typeof result === "object" && "error" in result) {
      return `MCP error: ${JSON.stringify(result.error)}`;
    }
    const content = (result as { content?: unknown[] } | undefined)?.content ?? [];
    const text = content
      .filter(
        (c): c is { type: string; text?: string } =>
          typeof c === "object" && c !== null && (c as { type?: string }).type === "text",
      )
      .map((c) => c.text ?? "")
      .join("\n");
    return text || "(empty result)";
  }

  async close(): Promise<void> {
    const p = this.process;
    if (p === null) return;
    p.stdin.end();
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      const timer = setTimeout(() => {
        p.kill();
        done();
      }, 5000);
      p.once("exit", () => {
        clearTimeout(timer);
        done();
      });
    });
    this.process = null;
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out after ${this.timeout}ms`));
      }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private failPending(error: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  private notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) });
  }

  private send(msg: unknown): void {
    const p = this.process;
    if (p === null) throw new Error(`MCP server '${this.name}' is not started`);
    p.stdin.write(JSON.stringify(msg) + "\n");
  }
}

const DISALLOWED = /[^a-zA-Z0-9_-]/g;

export function normalizeMcpName(name: string): string {
  const normalized = name.replace(DISALLOWED, "_");
  if (!normalized) throw new Error("MCP names cannot normalize to an empty string");
  return normalized;
}

export class MCPRegistry {
  private readonly clients = new Map<string, MCPClient>();
  private readonly origins = new Map<string, string>();

  constructor(
    readonly registry: ToolRegistry,
    readonly workdir: string,
  ) {}

  async connect(name: string, command: string, args?: string[]): Promise<string> {
    if (!name) return "Error: server name is required";
    if (this.clients.has(name)) return `MCP server '${name}' already connected`;
    const safeServer = normalizeMcpName(name);
    const client = new MCPClient(name, command, args);
    const registered: string[] = [];
    try {
      await client.start();
      const tools = await client.listTools();
      for (const toolDef of tools) {
        const rawName = String(toolDef.name ?? "");
        if (!rawName) continue;
        const safeTool = normalizeMcpName(rawName);
        const prefixed = `mcp__${safeServer}__${safeTool}`;
        if (prefixed.length > 64) {
          this.rollback(registered);
          await client.close();
          return `Error: MCP tool name too long: ${prefixed}`;
        }
        if (this.origins.has(prefixed)) {
          this.rollback(registered);
          await client.close();
          return `Error: MCP tool name collision: ${prefixed}`;
        }
        const schema = toolDef.inputSchema;
        const parameters: ToolParameters =
          schema && typeof schema === "object" && (schema as { type?: string }).type === "object"
            ? (schema as ToolParameters)
            : { type: "object", properties: {} };
        this.origins.set(prefixed, `MCP tool '${name}/${rawName}'`);
        this.registry.register({
          name: prefixed,
          description: String(toolDef.description ?? ""),
          parameters,
          handler: (callArgs) => client.callTool(rawName, callArgs),
        });
        registered.push(prefixed);
      }
      this.clients.set(name, client);
      return `Connected to MCP server '${name}'. Discovered ${registered.length} tools: ${registered.join(", ") || "none"}`;
    } catch (error) {
      this.rollback(registered);
      await client.close();
      const message = error instanceof Error ? error.message : String(error);
      return `Error: failed to connect MCP server '${name}': ${message}`;
    }
  }

  private rollback(registered: string[]): void {
    for (const name of registered) {
      this.registry.unregister(name);
      this.origins.delete(name);
    }
  }

  systemPromptSection(): string {
    if (this.clients.size === 0) return "";
    return "Connected MCP servers: " + [...this.clients.keys()].join(", ");
  }
}
