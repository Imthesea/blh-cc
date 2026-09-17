import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../core/config.js";
import { buildHarness } from "../cli/harness.js";
import { createWebServer } from "./http.js";
import { SSEBroadcaster } from "./bridge.js";
import { ApprovalCoordinator, loadUserRules, persistUserRule } from "./approval.js";
import { SessionManager } from "./session.js";

export interface WebServerOptions {
  workdir?: string;
  cli?: Record<string, unknown>;
  port?: number;
  dev?: boolean;
  skipPermissions?: boolean;
}

export interface RunningWebServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

function staticDir(dev: boolean): string | null {
  if (dev) return null;
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/server/index.js → ../../web = dist/web
  return path.resolve(here, "..", "web");
}

export async function startWebServer(options: WebServerOptions): Promise<RunningWebServer> {
  // 先解析一次 workdir，用于在 buildHarness 之前加载用户规则
  const config = loadConfig(options.workdir, options.cli);
  const workdir = config.workdir;

  const broadcaster = new SSEBroadcaster();
  const approvals = new ApprovalCoordinator((event) => broadcaster.broadcast(event));

  const userRules = loadUserRules(workdir);
  const harness = buildHarness(
    options.workdir,
    options.cli,
    (req) => approvals.ask(req),
    options.skipPermissions ?? false,
    {
      userRules,
      persistRule: (rule) => persistUserRule(workdir, rule),
    },
  );

  const session = new SessionManager(
    harness,
    harness.jobs!.agentLock,
    (event) => broadcaster.broadcast(event),
    approvals,
  );
  session.create(workdir);

  const server = createWebServer({
    session,
    broadcaster,
    workdir,
    staticDir: staticDir(options.dev ?? false),
  });

  const port = options.port !== undefined && Number.isInteger(options.port) ? options.port : 8123;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
