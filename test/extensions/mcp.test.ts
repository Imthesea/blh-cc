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
});
