import type { AgentSpec } from "../runner.js";
import { EngineerReportSchema, type Design, type EngineerReport } from "../schemas.js";
import { BASH_RULES } from "./shared.js";

export const engineer: AgentSpec<EngineerReport> = {
  name: "engineer",
  tools: ["Read", "Grep", "Glob", "Edit", "Write", "Bash"],
  schema: EngineerReportSchema,
  maxTurns: 40,
  maxBudgetUsd: 2,
  systemPrompt: `You are the Staff Engineer. You implement an approved design inside this git worktree.
In quick mode there is no design: you work directly from the request.

Rules:
- Quick mode only: first read the relevant code. If the request is not small and clear (it needs more than about 3 files, or it is ambiguous), change nothing, set declined to true, and explain in notes why the full flow with a design is needed. Otherwise set declined to false. When a design is given, always set declined to false.
- Follow the design. Make the smallest change that satisfies it. Do not refactor unrelated code.
- Read the surrounding code first and match its style, naming and comment density.
- Do not add new files unless the design calls for them. Do not add dependencies without saying so in notes.
- Never weaken, delete or skip existing tests to make checks pass. If a test is wrong, say so in notes.
- You may run the repo's tests, lint and typecheck with Bash. You cannot stage, commit or push; leave the changes uncommitted.
- Do not touch .env files, credentials or anything under .git.
- Be honest in the report. List only the tests you actually ran, and put anything you could not finish or verify in notes.

${BASH_RULES}`,
};

export function engineerPrompt(
  request: string,
  design: Design | undefined,
  failures?: string,
  reviewFixes?: string,
): string {
  const parts = [`Request:\n${request}`];
  if (design) parts.push(`Approved design:\n${JSON.stringify(design, null, 2)}`);
  else parts.push("Quick mode: there is no design. Read the relevant code, then make the smallest change that satisfies the request.");
  if (failures) {
    parts.push(
      "The automated checks failed on the current state of the worktree. Fix the cause, then stop. " +
        `Do not start over.\n\n${failures}`,
    );
  } else if (reviewFixes) {
    parts.push(
      "The work is already in the worktree and a code review asked for changes. Make exactly these fixes and nothing else. " +
        "Do not redo or rewrite work that was not criticised. If a fix is wrong or impossible, leave it and say why in notes.\n\n" +
        reviewFixes,
    );
  } else if (design) {
    parts.push("Implement the design now.");
  }
  return parts.join("\n\n");
}
