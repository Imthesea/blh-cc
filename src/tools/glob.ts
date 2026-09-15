import fs from "node:fs/promises";
import path from "node:path";

/** Python fnmatch 语义：* 跨目录分隔符；? 匹配单字符；[seq] 字符类。 */
export function fnmatch(name: string, pattern: string): boolean {
  const regex = new RegExp(
    "^" +
      pattern
        .replace(/[.+^${}()|\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".")
        .replace(
          /\[(!|\^)?([^\]]*)\]/g,
          (_match, negation: string | undefined, charClass: string) =>
            `[${negation ? "^" : ""}${charClass.replace(/\\/g, "\\\\")}]`,
        ) +
      "$",
  );
  return regex.test(name);
}

async function* walk(root: string): AsyncGenerator<string> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walk(fullPath);
    } else {
      yield fullPath;
    }
  }
}

export async function glob(
  workdir: string,
  args: Record<string, unknown>,
): Promise<string> {
  if (typeof args.pattern !== "string") throw new TypeError("pattern must be a string");
  const pattern = args.pattern;
  const matches: string[] = [];
  const root = path.resolve(workdir);
  for await (const fullPath of walk(root)) {
    const relativePath = path.relative(root, fullPath);
    const normalized = relativePath.split(path.sep).join("/");
    if (fnmatch(normalized, pattern)) {
      matches.push(relativePath);
      if (matches.length >= 200) break;
    }
  }
  if (matches.length === 0) return "(no matches)";
  return matches.join("\n");
}
