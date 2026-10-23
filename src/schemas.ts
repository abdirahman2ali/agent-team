import { z } from "zod";

export const SpecSchema = z.object({
  problem: z.string().min(1),
  scope: z.array(z.string()).min(1),
  outOfScope: z.array(z.string()),
  successCriteria: z.array(z.string()).min(1),
});
export type Spec = z.infer<typeof SpecSchema>;

export const DesignSchema = z.object({
  approach: z.string().min(1),
  filesToChange: z.array(z.object({ path: z.string(), change: z.string() })).min(1),
  risks: z.array(z.string()),
  tradeoffs: z.array(z.string()),
  testPlan: z.array(z.string()).min(1),
});
export type Design = z.infer<typeof DesignSchema>;

export const EngineerReportSchema = z.object({
  /** Quick mode only: true when the request was too big or unclear, and nothing was changed. */
  declined: z.boolean(),
  summary: z.string().min(1),
  filesChanged: z.array(z.string()),
  testsRun: z.array(z.string()),
  notes: z.array(z.string()),
});
export type EngineerReport = z.infer<typeof EngineerReportSchema>;

export const ReviewSchema = z.object({
  verdict: z.enum(["approve", "changes_requested"]),
  summary: z.string().min(1),
  requiredFixes: z.array(
    z.object({
      file: z.string(),
      issue: z.string(),
      fix: z.string(),
    }),
  ),
});
export type Review = z.infer<typeof ReviewSchema>;
