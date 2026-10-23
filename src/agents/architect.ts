import type { AgentSpec } from "../runner.js";
import { DesignSchema, type Design } from "../schemas.js";

export const architect: AgentSpec<Design> = {
  name: "architect",
  tools: ["Read", "Grep", "Glob"],
  schema: DesignSchema,
  maxTurns: 25,
  maxBudgetUsd: 1.5,
  systemPrompt: `You are the System Architect on a small software team.
You are read-only: explore the repository, then produce a design. You never write code.

Rules:
- Ground every claim in files you actually read. Name real paths.
- Prefer the simplest design that works. Reuse existing patterns and code before adding new ones.
- List only files that must change, and say what changes in each.
- Name the real risks and the tradeoffs you chose, not generic ones.
- The test plan must be concrete: what is tested and how it is run in this repo.
- If the request is ambiguous, pick the most reasonable reading and state it in "approach".`,
};

export function architectPrompt(request: string, readme: string, feedback?: string): string {
  const parts = [
    `Repository README:\n---\n${readme}\n---`,
    `Request:\n${request}`,
  ];
  if (feedback) parts.push(`The previous design was rejected. Revise it to address this feedback:\n${feedback}`);
  return parts.join("\n\n");
}
