/** 内置工作流注册表:host 硬编码 trusted 编排函数。 */
import { WorkflowInputError, type JsonSchema } from "./schema.js";
import type { WorkflowFn, WorkflowMeta, WorkflowRegistry } from "./runtime.js";

const FINDINGS_SCHEMA: JsonSchema = {
  type: "object",
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["title", "severity"],
        properties: {
          title: { type: "string" },
          severity: { type: "string", enum: ["high", "medium", "low"] },
        },
      },
    },
  },
};

const VERDICT_SCHEMA: JsonSchema = {
  type: "object",
  required: ["isReal", "reason"],
  properties: { isReal: { type: "boolean" }, reason: { type: "string" } },
};

const SAMPLE_META: WorkflowMeta = {
  name: "review-changes",
  description: "Review changed files across dimensions, verify each finding",
  phases: ["Review", "Verify"],
};

const DIMENSIONS = ["correctness", "security", "performance", "style"];

export const sampleWorkflow: WorkflowFn = async (ctx, args) => {
  ctx.phase("Review");
  const changes = args.changes;
  if (typeof changes !== "string") {
    throw new WorkflowInputError("args.changes must be a string");
  }
  const reviewInput = changes.trim() || "No change context was supplied.";

  const audit = async (_value: unknown, dimension: unknown, _idx: number) => {
    const dim = String(dimension);
    const out = (await ctx.agent(
      `Review this change context for ${dim} issues. Report only issues supported by the supplied text.\n\n${reviewInput}`,
      FINDINGS_SCHEMA,
      `audit:${dim}`,
      "Review",
    )) as { findings: Array<{ title: string; severity: string }> };
    return { dimension: dim, findings: out.findings };
  };

  const verify = async (auditedValue: unknown, dimension: unknown, _idx: number) => {
    ctx.phase("Verify");
    const dim = String(dimension);
    const audited = auditedValue as { dimension: string; findings: Array<{ title: string; severity: string }> };
    const verdicts = await ctx.parallel(
      audited.findings.map((f) => () =>
        ctx.agent(
          `Adversarially verify this ${dim} finding against the supplied change context.\n\n` +
            `Change context:\n${reviewInput}\n\nFinding:\n${JSON.stringify(f)}`,
          VERDICT_SCHEMA,
          `verify:${dim}:${f.title}`,
          "Verify",
        ),
      ),
    );
    const confirmed = audited.findings.filter((f, i) => {
      const v = verdicts[i] as { isReal?: boolean } | undefined;
      return v && v.isReal;
    });
    return { dimension: dim, confirmed };
  };

  const results = (await ctx.pipeline(DIMENSIONS, audit, verify)) as Array<{
    dimension: string;
    confirmed: Array<{ title: string; severity: string }>;
  }>;
  const confirmed = results.flatMap((r) =>
    r.confirmed.map((f) => ({ dimension: r.dimension, ...f })),
  );
  confirmed.sort((a, b) => {
    const order: Record<string, number> = { high: 0, medium: 1, low: 2 };
    return (order[a.severity] ?? 3) - (order[b.severity] ?? 3);
  });
  ctx.log(`confirmed ${confirmed.length} real finding(s)`);
  return { confirmed };
};

export const WORKFLOWS: WorkflowRegistry = new Map([[SAMPLE_META.name, [SAMPLE_META, sampleWorkflow]]]);
