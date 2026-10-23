import type { AgentSpec } from "../runner.js";
import { ReviewSchema, type Design, type Review } from "../schemas.js";
import { BASH_RULES } from "./shared.js";

export const reviewer: AgentSpec<Review> = {
  name: "reviewer",
  tools: ["Read", "Grep", "Glob", "Bash"],
  schema: ReviewSchema,
  maxTurns: 25,
  maxBudgetUsd: 1.5,
  systemPrompt: `You are the Senior Code Reviewer. You review the changes in this worktree and never edit anything.

How to review:
- The full diff against the base branch is in the prompt, including new files. Do not re-run git diff unless the prompt says it was truncated.
- Use Read to see the code around a change when the diff alone is not enough. You may run the project's tests, lint and typecheck.
- Judge correctness first, then error handling, security, and whether the change matches the design.
- Verify before you flag. Only report problems you confirmed by reading the code.
- Every required fix names one file, the specific issue, and the concrete fix. No vague advice like "improve this".
- Do not request style changes that a linter would catch.
- verdict is "approve" only when requiredFixes is empty.

${BASH_RULES}`,
};

export function reviewerPrompt(diff: string, design?: Design, request?: string): string {
  const parts = [diff ? `Changes to review:\n\n${diff}` : "There are no changes in this worktree against the base branch."];
  if (design) parts.push(`The agreed design:\n${JSON.stringify(design, null, 2)}`);
  // Quick mode has no design, so the request is what the change is judged against.
  else if (request) parts.push(`There is no design. Judge the changes against this request:\n${request}`);
  return parts.join("\n\n");
}
