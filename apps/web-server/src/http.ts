import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import type { ApprovalDecision } from "./types.js";
import type { SessionManager } from "./session.js";
import type { SSEBroadcaster } from "./bridge.js";
import type { SessionStoreModule } from "./types.js";
import { appendRawEntry, createLogger, type LogLevel } from "@blh/logger";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

/** 自定义请求头：阻止跨站（CSRF）简单请求触发状态变更。 */
const CSRF_HEADER = "x-blh-web";

const log = createLogger("web-server.http");

function isLogLevel(value: unknown): value is LogLevel {
  return value === "debug" || value === "info" || value === "warn" || value === "error";
}

export interface WebContext {
  session: SessionManager;
  broadcaster: SSEBroadcaster;
  workdir: string;
  /** 前端静态目录；dev 模式为 null（页面由 Vite dev server 提供）。 */
  staticDir: string | null;
  sessionStore: SessionStoreModule;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.trim() === "") {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, "invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function listSessions(
  workdir: string,
  sessionStore: SessionStoreModule,
): Array<{ file: string; mtime: number; preview: string }> {
  const dir = sessionStore.sessionsDir(workdir);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const result: Array<{ file: string; mtime: number; preview: string }> = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const file = path.join(dir, name);
    try {
      if (!statSync(file).isFile()) continue;
      const messages = sessionStore.load(file);
      const firstUser = messages.find((m) => m.role === "user");
      result.push({
        file: name,
        mtime: statSync(file).mtimeMs,
        preview: (firstUser?.content ?? "").slice(0, 80),
      });
    } catch {
      // 跳过无法读取的文件
    }
  }
  result.sort((a, b) => b.mtime - a.mtime);
  return result;
}

function serveStatic(res: ServerResponse, root: string, pathname: string): void {
  const rel = pathname === "/" ? "index.html" : pathname.slice(1);
  const resolvedRoot = path.resolve(root);
  const file = path.normalize(path.join(resolvedRoot, rel));
  if (!file.startsWith(resolvedRoot + path.sep) || !existsSync(file) || !statSync(file).isFile()) {
    json(res, 404, { error: "not found" });
    return;
  }
  const ext = path.extname(file);
  res.writeHead(200, { "Content-Type": CONTENT_TYPES[ext] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
}

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: WebContext,
  method: string,
  pathname: string,
): Promise<void> {
  if (method !== "GET" && method !== "HEAD" && req.headers[CSRF_HEADER] !== "1") {
    json(res, 403, { error: "forbidden" });
    return;
  }
  log.debug("request", { method, pathname });
  if (method === "GET" && pathname === "/api/session") {
    const handle = ctx.session.list()[0];
    if (handle === undefined) {
      json(res, 200, { sessionId: null, messages: [], workdir: ctx.workdir });
      return;
    }
    json(res, 200, { sessionId: handle.id, workdir: ctx.workdir, messages: handle.messages });
    return;
  }

  if (method === "GET" && pathname === "/api/sessions") {
    json(res, 200, { sessions: listSessions(ctx.workdir, ctx.sessionStore) });
    return;
  }

  const sessionMatch = /^\/api\/sessions\/(.+)$/.exec(pathname);
  if (method === "GET" && sessionMatch !== null) {
    let file: string;
    try {
      file = decodeURIComponent(sessionMatch[1] ?? "");
    } catch {
      json(res, 400, { error: "invalid session file" });
      return;
    }
    if (path.basename(file) !== file || file === "." || file === "..") {
      json(res, 400, { error: "invalid session file" });
      return;
    }
    const messages = ctx.sessionStore.load(
      path.join(ctx.sessionStore.sessionsDir(ctx.workdir), file),
    );
    json(res, 200, { file, messages });
    return;
  }

  if (method === "POST" && pathname === "/api/message") {
    const body = (await readBody(req)) as Record<string, unknown>;
    const text = typeof body.text === "string" ? body.text : "";
    if (text.trim() === "") {
      json(res, 400, { error: "text is required" });
      return;
    }
    const handle = ctx.session.list()[0];
    if (handle === undefined) {
      json(res, 400, { error: "no active session" });
      return;
    }
    ctx.session.runTurn(handle.id, text).catch((error: unknown) => {
      log.error("run turn failed", { id: handle.id }, error);
      ctx.broadcaster.broadcast({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    });
    json(res, 202, { accepted: true });
    return;
  }

  if (method === "POST" && pathname === "/api/log") {
    const rawBody = await readBody(req);
    if (typeof rawBody !== "object" || rawBody === null) {
      json(res, 400, { error: "entries is required" });
      return;
    }
    const entries = (rawBody as Record<string, unknown>).entries;
    if (!Array.isArray(entries)) {
      json(res, 400, { error: "entries is required" });
      return;
    }
    const bounded = entries.slice(0, 1000);
    for (const raw of bounded) {
      const e = raw as Record<string, unknown>;
      const level = e.level;
      if (!isLogLevel(level)) continue;
      const message = typeof e.message === "string" ? e.message : "";
      const module = typeof e.module === "string" ? e.module : "web";
      const parsed = new Date(typeof e.time === "string" ? e.time : Date.now());
      const time = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
      const fields =
        typeof e.fields === "object" && e.fields !== null
          ? (e.fields as Record<string, unknown>)
          : {};
      appendRawEntry({ time, level, module, message, fields });
    }
    log.debug("frontend logs received", { count: bounded.length });
    json(res, 202, { accepted: true });
    return;
  }

  if (method === "POST" && pathname === "/api/approval") {
    const body = (await readBody(req)) as Record<string, unknown>;
    const requestId = typeof body.requestId === "string" ? body.requestId : "";
    const decision = body.decision;
    if (decision !== "allow" && decision !== "deny" && decision !== "always_allow") {
      json(res, 400, { error: "invalid decision" });
      return;
    }
    const ok = ctx.session.approve(requestId, decision as ApprovalDecision);
    json(res, ok ? 200 : 404, ok ? { ok: true } : { error: "unknown requestId" });
    return;
  }

  if (method === "POST" && pathname === "/api/session/new") {
    const handle = ctx.session.create(ctx.workdir);
    json(res, 200, { sessionId: handle.id });
    return;
  }

  if (method === "POST" && pathname === "/api/session/resume") {
    const body = (await readBody(req)) as Record<string, unknown>;
    const file = typeof body.file === "string" ? body.file : "";
    if (file === "") {
      json(res, 400, { error: "file is required" });
      return;
    }
    if (path.basename(file) !== file || file === "." || file === "..") {
      json(res, 400, { error: "invalid session file" });
      return;
    }
    const handle = ctx.session.resume(ctx.workdir, file);
    json(res, 200, { sessionId: handle.id });
    return;
  }

  json(res, 404, { error: "not found" });
}

export function createWebServer(ctx: WebContext): Server {
  return createHttpServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const method = req.method ?? "GET";
      const pathname = url.pathname;

      if (method === "GET" && pathname === "/api/events") {
        const off = ctx.broadcaster.subscribe(res);
        res.on("close", off);
        return;
      }
      if (pathname.startsWith("/api/")) {
        await handleApi(req, res, ctx, method, pathname);
        return;
      }
      if (ctx.staticDir === null) {
        json(res, 404, { error: "not found (dev mode: use Vite dev server)" });
        return;
      }
      serveStatic(res, ctx.staticDir, pathname);
    })().catch((error: unknown) => {
      if (error instanceof HttpError) {
        json(res, error.status, { error: error.message });
        return;
      }
      json(res, 500, { error: "internal error" });
    });
  });
}
