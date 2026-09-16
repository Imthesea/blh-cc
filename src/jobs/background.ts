/** 后台任务:慢 bash 命令异步执行,后续轮次收集完成通知。 */
import { execFile, type ChildProcess } from "node:child_process";

export interface BackgroundTask {
  command: string;
  status: string;
}

/** 独立实现(蓝本决策:不复用 runBash,它丢弃 exit code)。输出格式与 bash.ts 不同:stdout+stderr 直接拼接。 */
function runBashProcess(
  command: string,
  workdir: string,
  timeout: number,
  maxOutput: number,
): Promise<{ output: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
    const shellArgs =
      process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command];

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (output: string, exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      let text = output;
      if (text.length > maxOutput) {
        text = text.slice(0, maxOutput) + `\n... [truncated, ${output.length} chars total]`;
      }
      resolve({ output: text || "(no output)", exitCode });
    };

    const child = execFile(
      shell,
      shellArgs,
      { cwd: workdir, maxBuffer: 64 * 1024 * 1024 },
      (error) => {
        const exitCode =
          typeof child.exitCode === "number" ? child.exitCode : error ? 1 : 0;
        finish(stdout + stderr, exitCode);
      },
    );

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    setTimeout(() => {
      if (settled) return;
      void killTree(child).then(() =>
        finish(`error: command timed out after ${timeout}s`, null),
      );
    }, timeout * 1000 + 50);
  });
}

/** 与 bash.ts 相同的进程树强杀:cmd.exe 会派生子进程,仅杀壳进程会留孤儿 */
function killTree(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.pid === undefined) return resolve();
    if (process.platform === "win32") {
      execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => resolve());
    } else {
      child.kill("SIGKILL");
      resolve();
    }
  });
}

export class BackgroundManager {
  readonly tasks: Record<string, BackgroundTask> = {};
  private readonly results: Record<string, string> = {};
  private readonly ready: string[] = [];
  private counter = 0;

  constructor(
    readonly workdir: string,
    readonly timeout = 120,
    readonly maxOutput = 30000,
  ) {}

  start(command: string): string {
    const trimmed = String(command).trim();
    if (!trimmed) throw new Error("Bash command cannot be empty");
    this.counter += 1;
    const taskId = `bg_${String(this.counter).padStart(4, "0")}`;
    this.tasks[taskId] = { command: trimmed, status: "running" };
    void this.run(taskId, trimmed);
    return taskId;
  }

  private async run(taskId: string, command: string): Promise<void> {
    let output: string;
    let status: string;
    try {
      const result = await runBashProcess(command, this.workdir, this.timeout, this.maxOutput);
      output = result.output;
      status = result.exitCode === 0 ? "completed" : "failed";
    } catch (error) {
      // worker 崩溃也要记录为 failed
      output = error instanceof Error ? `Error: ${error.name}: ${error.message}` : String(error);
      status = "failed";
    }
    const task = this.tasks[taskId];
    if (task === undefined) return;
    task.status = status;
    this.results[taskId] = output;
    this.ready.push(taskId);
  }

  hasRunning(): boolean {
    return Object.values(this.tasks).some((task) => task.status === "running");
  }

  collect(): string[] {
    const ready: Array<[string, BackgroundTask, string]> = [];
    for (const taskId of this.ready) {
      const task = this.tasks[taskId];
      const result = this.results[taskId] ?? "";
      delete this.tasks[taskId];
      delete this.results[taskId];
      if (task !== undefined) ready.push([taskId, task, result]);
    }
    this.ready.length = 0;
    return ready.map(
      ([taskId, task, result]) =>
        `<task_notification>\n` +
        `  <task_id>${taskId}</task_id>\n` +
        `  <status>${task.status}</status>\n` +
        `  <command>${task.command}</command>\n` +
        `  <summary>${result.slice(0, 500)}</summary>\n` +
        `</task_notification>`,
    );
  }
}
