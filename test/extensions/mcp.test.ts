import { describe, expect, it } from "vitest";
import { MCPClient, MCPRegistry, normalizeMcpName } from "../../src/extensions/mcp.js";
import { ToolRegistry } from "../../src/tools/registry.js";

const SERVER_CODE = `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}
const TOOLS = [
  { name: "search", description: "Search docs.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
];
rl.on("line", (line) => {
  const req = JSON.parse(line);
  const method = req.method;
  if (method === "initialize") {
    reply(req.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1.0" } });
  } else if (method === "notifications/initialized") {
  } else if (method === "tools/list") {
    reply(req.id, { tools: TOOLS });
  } else if (method === "tools/call") {
    const params = req.params;
    if (params.name !== "search") {
      reply(req.id, { content: [{ type: "text", text: "unknown tool: " + params.name }], isError: true });
    } else {
      reply(req.id, { content: [{ type: "text", text: "searched " + (params.arguments.query ?? "") }], isError: false });
    }
  } else {
    reply(req.id, { content: [], isError: false });
  }
});
`;

function startClient(): MCPClient {
  return new MCPClient("fake", process.execPath, ["-e", SERVER_CODE]);
}

describe("MCPClient", () => {
  it("initialize_and_list_tools", async () => {
    const client = startClient();
    try {
      await client.start();
      const tools = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(["search"]);
    } finally {
      await client.close();
    }
  });

  it("call_tool", async () => {
    const client = startClient();
    try {
      await client.start();
      expect(await client.callTool("search", { query: "x" })).toBe("searched x");
    } finally {
      await client.close();
    }
  });

  it("call_unknown_tool", async () => {
    const client = startClient();
    try {
      await client.start();
      expect(await client.callTool("nope", {})).toContain("unknown tool");
    } finally {
      await client.close();
    }
  });

  it("start_rejects_when_command_does_not_exist", async () => {
    const client = new MCPClient("x", "definitely-not-a-real-cmd-xyz");
    await expect(client.start()).rejects.toThrow();
  });

  it("start_rejects_when_server_exits_immediately", async () => {
    const client = new MCPClient("x", process.execPath, ["-e", "process.exit(1)"], 2000);
    await expect(client.start()).rejects.toThrow();
  });
});

describe("normalizeMcpName", () => {
  it("normalize_mcp_name", () => {
    expect(normalizeMcpName("docs.one/get")).toBe("docs_one_get");
  });

  it("normalize_mcp_name_empty_raises", () => {
    expect(() => normalizeMcpName("")).toThrow();
  });
});

describe("MCPRegistry", () => {
  it("connect_registers_prefixed_tools", async () => {
    const registry = new ToolRegistry();
    const mcp = new MCPRegistry(registry, ".");
    const result = await mcp.connect("fake", process.execPath, ["-e", SERVER_CODE]);
    expect(result).toContain("fake");
    const names = registry.list().map((tool) => tool.name);
    expect(names).toContain("mcp__fake__search");
  });

  it("connect_duplicate_returns_message", async () => {
    const registry = new ToolRegistry();
    const mcp = new MCPRegistry(registry, ".");
    await mcp.connect("fake", process.execPath, ["-e", SERVER_CODE]);
    expect(await mcp.connect("fake", process.execPath, ["-e", SERVER_CODE])).toContain(
      "already connected",
    );
  });

  it("system_prompt_section", async () => {
    const registry = new ToolRegistry();
    const mcp = new MCPRegistry(registry, ".");
    expect(mcp.systemPromptSection()).toBe("");
    await mcp.connect("fake", process.execPath, ["-e", SERVER_CODE]);
    expect(mcp.systemPromptSection()).toContain("fake");
  });

  it("connect_rolls_back_on_tool_name_too_long", async () => {
    const longName = "x".repeat(60);
    const code = `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n"); }
const TOOLS = [
  { name: "search", description: "s", inputSchema: { type: "object", properties: {} } },
  { name: "${longName}", description: "long", inputSchema: { type: "object", properties: {} } },
];
rl.on("line", (line) => {
  const req = JSON.parse(line);
  if (req.method === "initialize") reply(req.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1.0" } });
  else if (req.method === "tools/list") reply(req.id, { tools: TOOLS });
  else reply(req.id, { content: [], isError: false });
});
`;
    const registry = new ToolRegistry();
    const mcp = new MCPRegistry(registry, ".");
    const result = await mcp.connect("fake", process.execPath, ["-e", code]);
    expect(result).toContain("tool name too long");
    expect(registry.list().filter((t) => t.name.startsWith("mcp__"))).toEqual([]);
  });
});
