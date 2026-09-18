import http from "node:http";

const clients = new Set();
const messages = [];
const history = [];

function sse(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(": connected\n\n");
  // 回放最近事件，避免连接建立前广播的事件因 SSE 无重放而丢失
  for (const ev of history) res.write(frame(ev.type, ev.data));
  clients.add(res);
  res.on("close", () => clients.delete(res));
}

function frame(type, data = {}) {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function broadcast(type, data) {
  history.push({ type, data });
  if (history.length > 100) history.shift();
  const f = frame(type, data);
  for (const c of clients) c.write(f);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const { pathname } = url;
  const method = req.method ?? "GET";

  if (method === "GET" && pathname === "/api/events") {
    sse(res);
    return;
  }
  if (method === "GET" && pathname === "/api/session") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ sessionId: "test", workdir: "/tmp", messages }));
    return;
  }
  if (method === "GET" && pathname === "/api/sessions") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ sessions: [] }));
    return;
  }
  if (method === "POST" && pathname === "/api/message") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const text = (JSON.parse(body || "{}").text ?? "").toString();
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ accepted: true }));
      messages.push({ role: "user", content: text });
      broadcast("turn_start");
      broadcast("assistant_text_delta", { text: "你好，世界" });
      messages.push({ role: "assistant", content: "你好，世界" });
      broadcast("turn_end");
    });
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(8123, "127.0.0.1");
