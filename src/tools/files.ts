import fs from "node:fs/promises";
import path from "node:path";

export class PathEscapeError extends Error {}

export function safePath(workdir: string, inputPath: string): string {
  const resolved = path.resolve(workdir, inputPath);
  const root = path.resolve(workdir);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new PathEscapeError(`path escapes workdir: ${inputPath}`);
  }
  return resolved;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  return value;
}

function optionalNumber(value: unknown, name: string, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number") throw new TypeError(`${name} must be a number`);
  return value;
}

export async function readFile(
  workdir: string,
  args: Record<string, unknown>,
): Promise<string> {
  const filePath = safePath(workdir, requireString(args.path, "path"));
  const start = optionalNumber(args.start, "start", 0);
  const limit = optionalNumber(args.limit, "limit", 2000);
  const text = await fs.readFile(filePath, "utf8");
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const slice = lines.slice(start, start + limit);
  if (slice.length === 0) return "(no more lines)";
  return slice.map((line, i) => `${i + start + 1}\t${line}`).join("\n");
}

export async function writeFile(
  workdir: string,
  args: Record<string, unknown>,
): Promise<string> {
  const filePath = safePath(workdir, requireString(args.path, "path"));
  const content = requireString(args.content, "content");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
  return `wrote ${content.length} chars to ${filePath}`;
}

export async function editFile(
  workdir: string,
  args: Record<string, unknown>,
): Promise<string> {
  const filePath = safePath(workdir, requireString(args.path, "path"));
  const oldText = requireString(args.old_text, "old_text");
  const newText = requireString(args.new_text, "new_text");
  const text = await fs.readFile(filePath, "utf8");
  const count = text.split(oldText).length - 1;
  if (count !== 1) {
    return `error: old_text occurs ${count} times (must be exactly 1)`;
  }
  await fs.writeFile(filePath, text.replace(oldText, newText), "utf8");
  return `edited ${filePath}`;
}
