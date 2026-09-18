import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import type { ChatMessage, SessionStoreLike, SessionStoreModule } from "../src/types.js";

let seq = 0;

const sessionsDir = (workdir: string): string => path.join(workdir, ".sessions");

function makeStore(filePath: string): SessionStoreLike {
  return {
    path: filePath,
    append(message: ChatMessage): void {
      appendFileSync(filePath, JSON.stringify(message) + "\n", "utf8");
    },
  };
}

/** 测试用会话存储：行为对齐根 SessionStore，但独立于根包。 */
export function makeTestSessionStore(): SessionStoreModule {
  return {
    sessionsDir,
    create(workdir) {
      mkdirSync(sessionsDir(workdir), { recursive: true });
      const filePath = path.join(sessionsDir(workdir), `session_${Date.now()}_${seq++}.jsonl`);
      appendFileSync(filePath, "", "utf8");
      return makeStore(filePath);
    },
    open(filePath) {
      return makeStore(filePath);
    },
    load(filePath) {
      let raw: string;
      try {
        raw = readFileSync(filePath, "utf8");
      } catch {
        return [];
      }
      const messages: ChatMessage[] = [];
      for (const line of raw.split("\n")) {
        if (line.trim() === "") continue;
        try {
          messages.push(JSON.parse(line) as ChatMessage);
        } catch {
          // 跳过无法解析的行
        }
      }
      return messages;
    },
  };
}
