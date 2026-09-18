import * as path from "node:path";
import type {
  ApprovalDecision,
  ChatMessage,
  SessionStoreLike,
  SessionStoreModule,
  TurnLock,
  WebTurnRunner,
} from "./types.js";
import type { WebEvent } from "./bridge.js";
import type { ApprovalCoordinator } from "./approval.js";
import { EventBus } from "./events.js";

export interface SessionHandle {
  id: string;
  file: string;
  messages: ChatMessage[];
  store: SessionStoreLike;
}

/** 会话管理：当前单会话实现；接口按多会话可扩展（未来换成 Map<id, handle>）。 */
export class SessionManager {
  private current: SessionHandle | undefined;

  constructor(
    private readonly runner: WebTurnRunner,
    private readonly lock: TurnLock,
    private readonly broadcast: (event: WebEvent) => void,
    private readonly approvals: ApprovalCoordinator,
    private readonly sessionStore: SessionStoreModule,
  ) {}

  create(workdir: string): SessionHandle {
    const store = this.sessionStore.create(workdir);
    this.runner.sessionStore = store;
    const handle: SessionHandle = {
      id: path.basename(store.path),
      file: store.path,
      messages: this.runner.newSession(),
      store,
    };
    this.current = handle;
    return handle;
  }

  resume(workdir: string, file: string): SessionHandle {
    if (path.basename(file) !== file || file === "." || file === "..") {
      throw new Error(`invalid session file: ${file}`);
    }
    const fullPath = path.join(this.sessionStore.sessionsDir(workdir), file);
    const store = this.sessionStore.open(fullPath);
    this.runner.sessionStore = store;
    const messages = this.runner.newSession();
    messages.push(...this.sessionStore.load(fullPath));
    const handle: SessionHandle = { id: file, file: fullPath, messages, store };
    this.current = handle;
    return handle;
  }

  get(id: string): SessionHandle | undefined {
    return this.current !== undefined && this.current.id === id ? this.current : undefined;
  }

  list(): SessionHandle[] {
    return this.current !== undefined ? [this.current] : [];
  }

  runTurn(id: string, text: string): Promise<void> {
    const handle = this.get(id);
    if (handle === undefined) return Promise.reject(new Error(`no such session: ${id}`));
    const events = new EventBus();
    const off = events.subscribe((event) => this.broadcast(event));
    const run = () => this.runner.runTurn(handle.messages, text, events);
    return this.lock.withLock(run).finally(() => off());
  }

  approve(requestId: string, decision: ApprovalDecision): boolean {
    return this.approvals.resolve(requestId, decision);
  }

  dispose(id: string): Promise<void> {
    if (this.current !== undefined && this.current.id === id) this.current = undefined;
    return Promise.resolve();
  }
}
