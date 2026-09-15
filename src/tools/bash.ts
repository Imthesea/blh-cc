import { execFile, type ChildProcess } from "node:child_process";

export function runBash(
  workdir: string,
  defaultTimeout: number,
  maxOutputChars: number,
  args: Record<string, unknown>,
): Promise<string> {
  if (typeof args.command !== "string") throw new TypeError("command must be a string");
  const command = args.command;
  const timeoutSec = typeof args.timeout === "number" ? args.timeout : defaultTimeout;

  return new Promise((resolve) => {
    const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
    const shellArgs =
      process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command];

    let stdout = "";
    let stderr = "";
    let settled = false;

    const child = execFile(
      shell,
      shellArgs,
      { cwd: workdir, maxBuffer: 64 * 1024 * 1024 },
      (error) => {
        if (settled) return;
        settled = true;
        const combinedOutput = stdout + (stderr ? `\n(stderr):\n${stderr}` : "");
        const exitCode =
          typeof child.exitCode === "number" ? child.exitCode : error ? 1 : 0;
        resolve(formatBashOutput(combinedOutput, exitCode, maxOutputChars));
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
      settled = true;
      void killTree(child).then(() =>
        resolve(`error: command timed out after ${timeoutSec}s`),
      );
    }, timeoutSec * 1000 + 50);
  });
}

function killTree(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.pid === undefined) return resolve();
    if (process.platform === "win32") {
      // cmd.exe 会派生子进程（如 node），仅杀 cmd.exe 会留下孤儿进程。
      // taskkill /T /F 会连同整个进程树一并强杀。
      execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => resolve());
    } else {
      child.kill("SIGKILL");
      resolve();
    }
  });
}

function formatBashOutput(
  output: string,
  exitCode: number,
  maxOutputChars: number,
): string {
  const total = output.length;
  let text = output;
  if (total > maxOutputChars) {
    text = output.slice(0, maxOutputChars) + `\n... [truncated, ${total} chars total]`;
  }
  if (!text.trim()) return `(exit code ${exitCode})`;
  return exitCode === 0 ? text.trimEnd() : `${text.trimEnd()}\n(exit code ${exitCode})`;
}
