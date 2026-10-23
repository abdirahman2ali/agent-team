import { describe, expect, it } from "vitest";
import { architect } from "../src/agents/architect.js";
import { engineer, engineerPrompt } from "../src/agents/engineer.js";
import { reviewer, reviewerPrompt } from "../src/agents/reviewer.js";
import { BASH_EXAMPLES, BASH_RULES } from "../src/agents/shared.js";
import { checkBash, decide } from "../src/guard.js";

describe("Bash rules shown to agents", () => {
  it("every example command passes the guard, so the prompt cannot drift from the allowlist", () => {
    for (const cmd of BASH_EXAMPLES) {
      expect(checkBash(cmd, "/wt").allow, cmd).toBe(true);
    }
  });

  it("every example command works for the agents that have Bash", () => {
    for (const agent of [engineer, reviewer]) {
      for (const cmd of BASH_EXAMPLES) {
        expect(decide("/wt", "Bash", { command: cmd }, agent.tools).allow, `${agent.name}: ${cmd}`).toBe(true);
      }
    }
  });

  it("the things the prompt forbids really are blocked", () => {
    for (const cmd of ["cat README.md", "grep -r x .", "git add .", "ruff format .", "ruff check --fix .", "ls | head", "ls && ls"]) {
      expect(checkBash(cmd, "/wt").allow, cmd).toBe(false);
    }
  });

  it("is in the prompts of the agents that have Bash, and not the one that does not", () => {
    expect(engineer.systemPrompt).toContain(BASH_RULES);
    expect(reviewer.systemPrompt).toContain(BASH_RULES);
    expect(architect.tools).not.toContain("Bash");
    expect(architect.systemPrompt).not.toContain("Bash accepts");
  });
});

describe("reviewerPrompt", () => {
  it("includes the diff and the design", () => {
    const prompt = reviewerPrompt("diff --git a/x b/x\n+hello", {
      approach: "a", filesToChange: [{ path: "x", change: "c" }], risks: [], tradeoffs: [], testPlan: ["t"],
    });
    expect(prompt).toContain("+hello");
    expect(prompt).toContain('"approach": "a"');
  });

  it("says so when there are no changes", () => {
    expect(reviewerPrompt("")).toContain("no changes");
  });

  it("judges against the request when there is no design (quick mode)", () => {
    const prompt = reviewerPrompt("+x", undefined, "add a docstring");
    expect(prompt).toContain("no design");
    expect(prompt).toContain("add a docstring");
  });

  it("prefers the design over the request when both exist", () => {
    const design = { approach: "a", filesToChange: [{ path: "x", change: "c" }], risks: [], tradeoffs: [], testPlan: ["t"] };
    expect(reviewerPrompt("+x", design, "add a docstring")).not.toContain("add a docstring");
  });
});

describe("engineerPrompt", () => {
  const design = { approach: "do it", filesToChange: [{ path: "x", change: "c" }], risks: [], tradeoffs: [], testPlan: ["t"] };

  it("includes the approved design when there is one", () => {
    const prompt = engineerPrompt("req", design);
    expect(prompt).toContain("Approved design");
    expect(prompt).toContain("Implement the design now");
    expect(prompt).not.toContain("Quick mode");
  });

  it("falls back to the request alone in quick mode", () => {
    const prompt = engineerPrompt("req", undefined);
    expect(prompt).toContain("Quick mode");
    expect(prompt).not.toContain("Approved design");
  });

  it("on a review round, asks for exactly the listed fixes and not a rewrite", () => {
    const prompt = engineerPrompt("req", design, undefined, "1. a.ts: bug\n   Fix: do x");
    expect(prompt).toContain("1. a.ts: bug");
    expect(prompt).toContain("exactly these fixes");
    expect(prompt).not.toContain("Implement the design now");
  });

  it("puts failing checks ahead of review fixes", () => {
    const prompt = engineerPrompt("req", design, "### npm test FAILED\nboom", "1. a.ts: bug");
    expect(prompt).toContain("boom");
    expect(prompt).not.toContain("1. a.ts: bug");
  });

  it("adds failing output on retries in both modes", () => {
    expect(engineerPrompt("req", design, "### npm test FAILED\nboom")).toContain("boom");
    expect(engineerPrompt("req", undefined, "### npm test FAILED\nboom")).toContain("boom");
  });
});
