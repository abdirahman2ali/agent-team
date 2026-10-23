import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentResult, AgentSpec } from "../src/runner.js";
import type { Design, Review } from "../src/schemas.js";

// The real check needs a github.com remote; the rest of the guard stays real.
vi.mock("../src/guard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/guard.js")>();
  return { ...actual, validateRepo: (root: string, name: string) => path.join(root, name) };
});

const { planRun, prepareRun, buildRun, buildReviewLoop, MAX_GATE_ROUNDS, MAX_FIX_ATTEMPTS, MAX_REVIEW_ROUNDS, MAX_RUN_COST_USD } =
  await import("../src/orchestrator.js");

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

const design = (approach: string): Design => ({
  approach,
  filesToChange: [{ path: "a.ts", change: "edit" }],
  risks: [],
  tradeoffs: [],
  testPlan: ["run tests"],
});

let sandbox: string;
let codeRoot: string;
let runsDir: string;

beforeAll(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), "orch-"));
  codeRoot = path.join(sandbox, "code");
  runsDir = path.join(sandbox, "runs");
  const origin = path.join(sandbox, "origin.git");
  const repo = path.join(codeRoot, "demo");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  writeFileSync(path.join(repo, "README.md"), "demo readme");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-q", "origin", "main");
});

afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

function makeDeps(approvals: Array<{ approved: true } | { approved: false; feedback: string }>) {
  const prompts: string[] = [];
  const logs: string[] = [];
  let i = 0;
  return {
    prompts,
    logs,
    deps: {
      runAgent: async <T>(_spec: AgentSpec<T>, opts: { prompt: string }): Promise<AgentResult<T>> => {
        prompts.push(opts.prompt);
        return { output: design(`round ${prompts.length}`) as T, costUsd: 0.5, turns: 3 };
      },
      approve: async () => approvals[i++] ?? { approved: false as const, feedback: "no more" },
      log: (line: string) => logs.push(line),
    },
  };
}

describe("buildRun", () => {
  const report = { declined: false, summary: "done", filesChanged: ["a.ts"], testsRun: [], notes: [] };
  const check = { name: "npm test", command: "npm", args: ["test"] };
  const pass = [{ name: "npm test", ok: true, output: "" }];
  const fail = (msg: string) => [{ name: "npm test", ok: false, output: msg }];

  /** Fake deps. `outcomes` is the sequence of check results: the first is the baseline run. */
  function buildDeps(outcomes: Array<ReturnType<typeof fail>>, checks = [check]) {
    const prompts: string[] = [];
    const logs: string[] = [];
    let run = 0;
    return {
      prompts,
      logs,
      deps: {
        runAgent: async <T>(_s: AgentSpec<T>, opts: { prompt: string }): Promise<AgentResult<T>> => {
          prompts.push(opts.prompt);
          return { output: report as T, costUsd: 0.4, turns: 5 };
        },
        log: (line: string) => logs.push(line),
        detectChecks: () => checks,
        runChecks: () => outcomes[Math.min(run++, outcomes.length - 1)] ?? pass,
      },
    };
  }

  const input = { worktree: "/wt", request: "do it", design: design("d") };

  it("passes on the first attempt", async () => {
    const { deps } = buildDeps([pass, pass]);
    const out = await buildRun(input, deps);
    expect(out).toMatchObject({ status: "passed", attempts: 1, costUsd: 0.4 });
  });

  it("feeds failing output back and passes on a later attempt", async () => {
    const { deps, prompts } = buildDeps([pass, fail("expected 1 got 2"), pass]);
    const out = await buildRun(input, deps);
    expect(out).toMatchObject({ status: "passed", attempts: 2 });
    expect(prompts[0]).not.toContain("expected 1 got 2");
    expect(prompts[1]).toContain("expected 1 got 2");
  });

  it("stops when the same failure comes back twice", async () => {
    const { deps, prompts } = buildDeps([pass, fail("same"), fail("same")]);
    const out = await buildRun(input, deps);
    expect(out.status).toBe("stuck");
    expect(prompts).toHaveLength(2);
  });

  it("gives up after the maximum attempts when failures keep changing", async () => {
    const outcomes = [pass, ...Array.from({ length: 10 }, (_, i) => fail(`failure ${i}`))];
    const { deps, prompts } = buildDeps(outcomes);
    const out = await buildRun(input, deps);
    expect(out.status).toBe("failed");
    expect(prompts).toHaveLength(MAX_FIX_ATTEMPTS);
    expect(out.failures).toContain("failure 4");
  });

  it("runs the engineer once, unverified, when every check already fails at baseline", async () => {
    const { deps, prompts, logs } = buildDeps([fail("Cannot find module vitest")]);
    const out = await buildRun(input, deps);
    expect(out).toMatchObject({ status: "unverified", attempts: 1 });
    expect(prompts).toHaveLength(1);
    expect(logs.join("\n")).toContain("already fail");
  });

  it("gates only on the checks that pass at baseline", async () => {
    const lint = { name: "ruff check", command: "ruff", args: ["check", "."] };
    const calls: string[][] = [];
    const prompts: string[] = [];
    let n = 0;
    const deps = {
      runAgent: async <T>(_s: AgentSpec<T>, opts: { prompt: string }): Promise<AgentResult<T>> => {
        prompts.push(opts.prompt);
        return { output: report as T, costUsd: 0.1, turns: 1 };
      },
      log: () => {},
      detectChecks: () => [check, lint],
      runChecks: (_wt: string, cs: Array<{ name: string }>) => {
        calls.push(cs.map((c) => c.name));
        n++;
        if (n === 1) return [{ name: "npm test", ok: false, output: "no deps" }, { name: "ruff check", ok: true, output: "" }];
        if (n === 2) return [{ name: "ruff check", ok: false, output: "E501 line too long" }];
        return [{ name: "ruff check", ok: true, output: "" }];
      },
    };
    const out = await buildRun(input, deps);
    expect(out).toMatchObject({ status: "passed", attempts: 2 });
    expect(calls[0]).toEqual(["npm test", "ruff check"]);
    expect(calls[1]).toEqual(["ruff check"]);
    expect(prompts[1]).toContain("E501 line too long");
  });

  it("runs the engineer once, unverified, when the repo has no checks", async () => {
    const { deps, prompts } = buildDeps([], []);
    const out = await buildRun(input, deps);
    expect(out).toMatchObject({ status: "unverified", attempts: 1 });
    expect(prompts).toHaveLength(1);
  });

  it("stops before the engineer runs when the run budget is already spent", async () => {
    const { deps, prompts } = buildDeps([pass]);
    const out = await buildRun({ ...input, spentUsd: MAX_RUN_COST_USD }, deps);
    expect(out).toMatchObject({ status: "budget", attempts: 0 });
    expect(prompts).toHaveLength(0);
  });

  it("quick mode: builds from the request alone, with no design in the prompt", async () => {
    const { deps, prompts } = buildDeps([pass, pass]);
    const out = await buildRun({ worktree: "/wt", request: "fix the typo" }, deps);
    expect(out.status).toBe("passed");
    expect(prompts[0]).toContain("fix the typo");
    expect(prompts[0]).toContain("Quick mode");
    expect(prompts[0]).not.toContain("Approved design");
  });

  it("quick mode: a declined request changes nothing, skips the fix loop, and stops after one engineer call", async () => {
    const declined = { ...report, declined: true, filesChanged: [], notes: ["touches 12 files"] };
    const prompts: string[] = [];
    let checkRuns = 0;
    const deps = {
      runAgent: async <T>(_s: AgentSpec<T>, opts: { prompt: string }): Promise<AgentResult<T>> => {
        prompts.push(opts.prompt);
        return { output: declined as T, costUsd: 0.2, turns: 4 };
      },
      log: () => {},
      detectChecks: () => [check],
      runChecks: () => {
        checkRuns++;
        return pass;
      },
    };
    const out = await buildRun({ worktree: "/wt", request: "rewrite everything" }, deps);
    expect(out).toMatchObject({ status: "declined", attempts: 1 });
    expect(out.report?.notes).toEqual(["touches 12 files"]);
    expect(prompts).toHaveLength(1);
    expect(checkRuns).toBe(1); // the baseline only, never re-run after the engineer
  });

  it("only counts this build's own spend in costUsd", async () => {
    const { deps } = buildDeps([pass, pass]);
    const out = await buildRun({ ...input, spentUsd: 1 }, deps);
    expect(out.costUsd).toBeCloseTo(0.4);
  });
});

describe("buildReviewLoop", () => {
  const check = { name: "npm test", command: "npm", args: ["test"] };
  const ok = [{ name: "npm test", ok: true, output: "" }];
  const bad = (msg: string) => [{ name: "npm test", ok: false, output: msg }];
  const approve: Review = { verdict: "approve", summary: "looks good", requiredFixes: [] };
  const changes = (...issues: string[]): Review => ({
    verdict: "changes_requested",
    summary: "needs work",
    requiredFixes: issues.map((issue) => ({ file: "a.ts", issue, fix: `do: ${issue}` })),
  });

  interface Setup {
    reviews: Review[];
    checkRuns?: Array<ReturnType<typeof bad>>;
    /** Sequence returned by collectDiff. Default: a new value every call, so a change is always seen. */
    diffs?: string[];
    /** 1-based engineer call numbers on which the engineer declines. */
    declineOn?: number[];
    cost?: number;
  }

  function setup(opts: Setup) {
    const engineerPrompts: string[] = [];
    const reviewerPrompts: string[] = [];
    const logs: string[] = [];
    let engineerCalls = 0;
    let reviewerCalls = 0;
    let checkCalls = 0;
    let diffCalls = 0;
    const deps = {
      runAgent: async <T>(spec: AgentSpec<T>, o: { prompt: string }): Promise<AgentResult<T>> => {
        const costUsd = opts.cost ?? 0.1;
        if (spec.name === "engineer") {
          engineerCalls++;
          engineerPrompts.push(o.prompt);
          const declined = opts.declineOn?.includes(engineerCalls) ?? false;
          return { output: { declined, summary: "s", filesChanged: [], testsRun: [], notes: [] } as T, costUsd, turns: 1 };
        }
        reviewerPrompts.push(o.prompt);
        const review = opts.reviews[Math.min(reviewerCalls, opts.reviews.length - 1)];
        reviewerCalls++;
        return { output: review as T, costUsd, turns: 1 };
      },
      log: (line: string) => logs.push(line),
      detectChecks: () => [check],
      runChecks: () => {
        const run = opts.checkRuns?.[Math.min(checkCalls, opts.checkRuns.length - 1)] ?? ok;
        checkCalls++;
        return run;
      },
      collectDiff: () => (opts.diffs ? (opts.diffs[Math.min(diffCalls++, opts.diffs.length - 1)] ?? "") : `diff-${++diffCalls}`),
    };
    return { deps, engineerPrompts, reviewerPrompts, logs, counts: () => ({ engineerCalls, reviewerCalls, checkCalls }) };
  }

  const input = { worktree: "/wt", request: "do it", design: design("d") };

  it("approves on the first review without any fix round", async () => {
    const s = setup({ reviews: [approve] });
    const out = await buildReviewLoop(input, s.deps);
    expect(out).toMatchObject({ status: "approved", rounds: 0 });
    expect(s.counts()).toMatchObject({ engineerCalls: 1, reviewerCalls: 1 });
  });

  it("sends required fixes back to the engineer, then re-reviews the new diff", async () => {
    const s = setup({ reviews: [changes("missing null check"), approve] });
    const out = await buildReviewLoop(input, s.deps);

    expect(out).toMatchObject({ status: "approved", rounds: 1 });
    expect(out.history).toEqual([
      { round: 0, verdict: "changes_requested", requiredFixes: 1 },
      { round: 1, verdict: "approve", requiredFixes: 0 },
    ]);
    expect(s.counts()).toMatchObject({ engineerCalls: 2, reviewerCalls: 2 });
    expect(s.engineerPrompts[1]).toContain("missing null check");
    expect(s.engineerPrompts[1]).toContain("a code review asked for changes");
    expect(s.reviewerPrompts[0]).toContain("diff-1");
    expect(s.reviewerPrompts[1]).toContain("diff-2");
  });

  it("does not re-measure the check baseline on a modified tree", async () => {
    const s = setup({ reviews: [changes("x"), approve] });
    await buildReviewLoop(input, s.deps);
    // baseline once, then once after each engineer call. A re-measured baseline would make it 4.
    expect(s.counts().checkCalls).toBe(3);
  });

  it("stops after the maximum number of fix rounds when each review finds something new", async () => {
    const s = setup({ reviews: [changes("first"), changes("second"), changes("third")] });
    const out = await buildReviewLoop(input, s.deps);

    expect(out.status).toBe("changes_requested");
    expect(out.rounds).toBe(MAX_REVIEW_ROUNDS);
    expect(s.counts()).toMatchObject({ engineerCalls: 1 + MAX_REVIEW_ROUNDS, reviewerCalls: 1 + MAX_REVIEW_ROUNDS });
    expect(out.review?.verdict).toBe("changes_requested");
  });

  it("stops as stuck when the reviewer asks for the same fixes twice", async () => {
    const s = setup({ reviews: [changes("Missing   null CHECK"), changes("missing null check")] });
    const out = await buildReviewLoop(input, s.deps);
    expect(out.status).toBe("stuck");
    expect(out.rounds).toBe(1);
    expect(s.counts().engineerCalls).toBe(2);
  });

  it("stops as stuck when the engineer changes nothing in response", async () => {
    const s = setup({ reviews: [changes("a"), approve], diffs: ["same"] });
    const out = await buildReviewLoop(input, s.deps);
    expect(out.status).toBe("stuck");
    expect(s.counts().reviewerCalls).toBe(1); // no point re-reviewing an unchanged diff
  });

  it("hands over as build_failed when the checks fail during a fix round, without more reviewing", async () => {
    const s = setup({ reviews: [changes("a"), approve], checkRuns: [ok, ok, bad("a"), bad("a")] });
    const out = await buildReviewLoop(input, s.deps);
    expect(out.status).toBe("build_failed");
    expect(s.counts().reviewerCalls).toBe(1);
  });

  it("stops without a fix round when the reviewer asks for changes but lists none", async () => {
    const s = setup({ reviews: [{ verdict: "changes_requested", summary: "meh", requiredFixes: [] }] });
    const out = await buildReviewLoop(input, s.deps);
    expect(out).toMatchObject({ status: "changes_requested", rounds: 0 });
    expect(s.counts().engineerCalls).toBe(1);
  });

  it("stops at the run cost cap instead of starting another fix round", async () => {
    const s = setup({ reviews: [changes("a"), approve], cost: 0.4 });
    const out = await buildReviewLoop({ ...input, spentUsd: MAX_RUN_COST_USD - 0.5 }, s.deps);
    expect(out.status).toBe("budget");
    expect(s.counts().engineerCalls).toBe(1);
  });

  it("returns declined with no review when the engineer declines the request", async () => {
    const s = setup({ reviews: [approve], declineOn: [1] });
    const out = await buildReviewLoop(input, s.deps);
    expect(out).toMatchObject({ status: "declined", review: null, rounds: 0 });
    expect(s.counts().reviewerCalls).toBe(0);
  });

  it("treats a decline during a fix round as stuck, not as a declined request", async () => {
    const s = setup({ reviews: [changes("a"), approve], declineOn: [2] });
    const out = await buildReviewLoop(input, s.deps);
    expect(out.status).toBe("stuck");
    expect(s.counts().reviewerCalls).toBe(1);
  });

  it("reports only its own spend, not the cost already spent", async () => {
    const s = setup({ reviews: [approve], cost: 0.25 });
    const out = await buildReviewLoop({ ...input, spentUsd: 1 }, s.deps);
    expect(out.costUsd).toBeCloseTo(0.5); // one engineer call and one review
  });
});

describe("prepareRun", () => {
  it("creates the worktree and run folder without calling any agent", () => {
    const logs: string[] = [];
    const prepared = prepareRun({ codeRoot, runsDir, repo: "demo", request: "quick change" }, (l) => logs.push(l));

    expect(existsSync(prepared.worktree)).toBe(true);
    expect(existsSync(prepared.runDir)).toBe(true);
    expect(prepared.branch).toBe(`agent/${prepared.runName}`);
    expect(prepared.worktree).toContain(path.join("demo", ".claude", "worktrees", prepared.runName));
    expect(logs[0]).toContain("worktree");
  });
});

describe("planRun", () => {
  it("creates a worktree, runs the architect, and saves the approved design", async () => {
    const { deps, prompts } = makeDeps([{ approved: true }]);
    const out = await planRun({ codeRoot, runsDir, repo: "demo", request: "add a thing" }, deps);

    expect(out.approved).toBe(true);
    expect(out.costUsd).toBe(0.5);
    expect(existsSync(out.worktree)).toBe(true);
    expect(existsSync(path.join(runsDir, out.runName, "design.json"))).toBe(true);
    expect(prompts[0]).toContain("demo readme");
    expect(prompts[0]).toContain("add a thing");
  });

  it("feeds human feedback back to the architect and revises", async () => {
    const { deps, prompts } = makeDeps([{ approved: false, feedback: "too big, cut scope" }, { approved: true }]);
    const out = await planRun({ codeRoot, runsDir, repo: "demo", request: "revise me" }, deps);

    expect(out.approved).toBe(true);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("too big, cut scope");
    expect(out.design?.approach).toBe("round 2");
  });

  it("stops after the maximum number of gate rounds", async () => {
    const { deps, prompts } = makeDeps(Array.from({ length: 10 }, () => ({ approved: false as const, feedback: "no" })));
    const out = await planRun({ codeRoot, runsDir, repo: "demo", request: "never good" }, deps);

    expect(out.approved).toBe(false);
    expect(prompts).toHaveLength(MAX_GATE_ROUNDS);
    expect(existsSync(path.join(runsDir, out.runName, "design.json"))).toBe(false);
  });
});
