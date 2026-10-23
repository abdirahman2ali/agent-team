import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { architect, architectPrompt } from "./agents/architect.js";
import { engineer, engineerPrompt } from "./agents/engineer.js";
import { reviewer, reviewerPrompt } from "./agents/reviewer.js";
import { formatFailures, type Check, type CheckResult } from "./checks.js";
import { collectDiff } from "./diff.js";
import { validateRepo } from "./guard.js";
import { runAgent as defaultRunAgent, type AgentResult, type AgentSpec, type RunAgentOptions } from "./runner.js";
import type { Design, EngineerReport, Review } from "./schemas.js";
import { createWorktree, makeRunName } from "./worktree.js";

export const MAX_GATE_ROUNDS = 3;
export const MAX_RUN_COST_USD = 4;

export type GateDecision = { approved: true } | { approved: false; feedback: string };

export interface Deps {
  runAgent: <T>(spec: AgentSpec<T>, opts: RunAgentOptions) => Promise<AgentResult<T>>;
  approve: (design: Design) => Promise<GateDecision>;
  log: (line: string) => void;
}

export interface PlanInput {
  codeRoot: string;
  runsDir: string;
  repo: string;
  request: string;
}

export interface PlanOutcome {
  runName: string;
  worktree: string;
  branch: string;
  design: Design | null;
  approved: boolean;
  costUsd: number;
}

function readReadme(worktree: string): string {
  const file = path.join(worktree, "README.md");
  return existsSync(file) ? readFileSync(file, "utf8") : "(no README.md)";
}

export interface PreparedRun {
  runName: string;
  worktree: string;
  branch: string;
  runDir: string;
}

/** Validate the repo and create the run's worktree. Shared by the full flow and quick mode. */
export function prepareRun(input: PlanInput, log: Deps["log"]): PreparedRun {
  const repoPath = validateRepo(input.codeRoot, input.repo);
  const runName = makeRunName(input.request);
  const wt = createWorktree(repoPath, runName);
  const runDir = path.join(input.runsDir, runName);
  mkdirSync(runDir, { recursive: true });
  log(`worktree ${wt.path} (${wt.branch})`);
  return { runName, worktree: wt.path, branch: wt.branch, runDir };
}

/** Create the worktree, then loop Architect and the human gate until approved or out of rounds. */
export async function planRun(input: PlanInput, deps: Deps): Promise<PlanOutcome> {
  const prepared = prepareRun(input, deps.log);
  const { runName, runDir } = prepared;
  const wt = { path: prepared.worktree, branch: prepared.branch };

  const readme = readReadme(wt.path);
  const onBlocked = (tool: string, reason: string) => deps.log(`blocked ${tool}: ${reason}`);
  let cost = 0;
  let feedback: string | undefined;
  let design: Design | null = null;

  for (let round = 1; round <= MAX_GATE_ROUNDS; round++) {
    if (cost >= MAX_RUN_COST_USD) {
      deps.log(`stopping, est. run cost $${cost.toFixed(2)} reached the cap`);
      break;
    }
    const result = await deps.runAgent(architect, {
      worktree: wt.path,
      prompt: architectPrompt(input.request, readme, feedback),
      onBlocked,
    });
    cost += result.costUsd;
    design = result.output;
    writeFileSync(path.join(runDir, `design-round-${round}.json`), JSON.stringify(design, null, 2));
    deps.log(`design round ${round} done, ${result.turns} turns, est. $${result.costUsd.toFixed(2)}`);

    const decision = await deps.approve(design);
    if (decision.approved) {
      writeFileSync(path.join(runDir, "design.json"), JSON.stringify(design, null, 2));
      return { runName, worktree: wt.path, branch: wt.branch, design, approved: true, costUsd: cost };
    }
    feedback = decision.feedback;
  }

  deps.log("design was not approved, stopping");
  return { runName, worktree: wt.path, branch: wt.branch, design, approved: false, costUsd: cost };
}

export const MAX_FIX_ATTEMPTS = 5;

export interface BuildDeps {
  runAgent: Deps["runAgent"];
  log: Deps["log"];
  detectChecks: (worktree: string) => Check[];
  runChecks: (worktree: string, checks: Check[]) => CheckResult[];
}

export interface BuildInput {
  worktree: string;
  request: string;
  /** Absent in quick mode, where the Engineer works straight from the request. */
  design?: Design;
  /** Cost already spent in this run, counted against MAX_RUN_COST_USD. */
  spentUsd?: number;
  /** Checks to gate on. Chosen once on the first build and reused on review rounds. */
  gateChecks?: Check[];
  /** Required fixes from the Reviewer. Turns this build into a targeted fix round. */
  reviewFixes?: string;
}

/**
 * passed:     checks ran and pass
 * unverified: nothing to gate on (no checks, or they already failed before any change)
 * failed:     out of attempts with checks still failing
 * stuck:      the same failure came back twice in a row
 * budget:     the run cost cap was reached
 * declined:   the Engineer judged the request too big or unclear and changed nothing (quick mode)
 */
export type BuildStatus = "passed" | "unverified" | "failed" | "stuck" | "budget" | "declined";

export interface BuildOutcome {
  status: BuildStatus;
  attempts: number;
  report: EngineerReport | null;
  failures: string;
  costUsd: number;
  /** The checks this build gated on, for reuse on later review rounds. */
  gateChecks: Check[];
}

/**
 * Worktrees have no node_modules or venv, so some checks can fail before the Engineer touches anything.
 * Looping on a failure the Engineer did not cause would only burn attempts, so gate on the checks that pass at baseline.
 */
export function selectGateChecks(worktree: string, deps: Pick<BuildDeps, "detectChecks" | "runChecks" | "log">): Check[] {
  const detected = deps.detectChecks(worktree);
  if (detected.length === 0) return [];
  const baseline = deps.runChecks(worktree, detected);
  const passing = new Set(baseline.filter((r) => r.ok).map((r) => r.name));
  const dropped = detected.filter((c) => !passing.has(c.name)).map((c) => c.name);
  if (dropped.length > 0) deps.log(`not gating on checks that already fail before any change: ${dropped.join(", ")}`);
  return detected.filter((c) => passing.has(c.name));
}

/** Engineer, then the repo's own checks, looping on failures. The orchestrator runs the checks itself. */
export async function buildRun(input: BuildInput, deps: BuildDeps): Promise<BuildOutcome> {
  const { worktree, request, design } = input;
  const onBlocked = (tool: string, reason: string) => deps.log(`blocked ${tool}: ${reason}`);

  // On a review round the gate was already chosen. Re-measuring it on a modified tree would drop a check the Engineer broke.
  const checks = input.gateChecks ?? selectGateChecks(worktree, deps);
  const gated = checks.length > 0;
  if (!gated && !input.gateChecks) deps.log("no usable automated checks, running without the fix loop");

  let cost = input.spentUsd ?? 0;
  const spent = () => cost - (input.spentUsd ?? 0);
  let report: EngineerReport | null = null;
  let failures = "";
  let lastFailures: string | undefined;
  const maxAttempts = gated ? MAX_FIX_ATTEMPTS : 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (cost >= MAX_RUN_COST_USD) {
      deps.log(`stopping, est. run cost $${cost.toFixed(2)} reached the cap`);
      return { status: "budget", attempts: attempt - 1, report, failures, costUsd: spent(), gateChecks: checks };
    }

    const result = await deps.runAgent(engineer, {
      worktree,
      prompt: engineerPrompt(request, design, attempt > 1 ? failures : undefined, attempt === 1 ? input.reviewFixes : undefined),
      onBlocked,
    });
    cost += result.costUsd;
    report = result.output;
    deps.log(`engineer attempt ${attempt}, ${result.turns} turns, est. $${result.costUsd.toFixed(2)}`);

    if (report.declined) {
      deps.log("engineer declined the request");
      return { status: "declined", attempts: attempt, report, failures: "", costUsd: spent(), gateChecks: checks };
    }
    if (!gated) return { status: "unverified", attempts: attempt, report, failures, costUsd: spent(), gateChecks: checks };

    const results = deps.runChecks(worktree, checks);
    if (results.every((r) => r.ok)) {
      deps.log(`checks pass after attempt ${attempt}`);
      return { status: "passed", attempts: attempt, report, failures: "", costUsd: spent(), gateChecks: checks };
    }

    failures = formatFailures(results);
    deps.log(`checks failed after attempt ${attempt}: ${results.filter((r) => !r.ok).map((r) => r.name).join(", ")}`);
    if (failures === lastFailures) {
      deps.log("same failure twice in a row, stopping");
      return { status: "stuck", attempts: attempt, report, failures, costUsd: spent(), gateChecks: checks };
    }
    lastFailures = failures;
  }

  return { status: "failed", attempts: maxAttempts, report, failures, costUsd: spent(), gateChecks: checks };
}

/** Review whatever has changed in an existing run worktree. */
export async function reviewRun(
  worktree: string,
  design: Design | undefined,
  deps: Pick<Deps, "runAgent" | "log">,
  diff: string = collectDiff(worktree),
  request?: string,
): Promise<AgentResult<Review>> {
  return deps.runAgent(reviewer, {
    worktree,
    prompt: reviewerPrompt(diff, design, request),
    onBlocked: (tool, reason) => deps.log(`blocked ${tool}: ${reason}`),
  });
}

export const MAX_REVIEW_ROUNDS = 2;

export interface LoopDeps extends BuildDeps {
  collectDiff: (worktree: string) => string;
}

/**
 * approved:           Reviewer approved and the checks pass (or there are none)
 * changes_requested:  fix rounds used up, or the Reviewer asked for changes without listing any
 * stuck:              the same fixes came back twice, or the Engineer made no change in response
 * budget:             the run cost cap was reached
 * build_failed:       the checks are failing, which needs a human before more reviewing helps
 * declined:           the Engineer declined the request (quick mode)
 */
export type LoopStatus = "approved" | "changes_requested" | "stuck" | "budget" | "build_failed" | "declined";

export interface ReviewRound {
  round: number;
  verdict: Review["verdict"];
  requiredFixes: number;
}

export interface LoopOutcome {
  status: LoopStatus;
  /** The most recent build. */
  build: BuildOutcome;
  /** The most recent review, or null when the Engineer declined before any review. */
  review: Review | null;
  /** Fix rounds run after the first review. */
  rounds: number;
  history: ReviewRound[];
  /** Everything spent inside this loop, not counting input.spentUsd. */
  costUsd: number;
}

const buildOk = (status: BuildStatus) => status === "passed" || status === "unverified";

export function formatFixes(review: Review): string {
  const list = review.requiredFixes.map((f, i) => `${i + 1}. ${f.file}: ${f.issue}\n   Fix: ${f.fix}`).join("\n");
  return `Reviewer summary: ${review.summary}\n\nRequired fixes:\n${list}`;
}

/** A rough identity for a set of fixes, so a Reviewer repeating itself is noticed. Wording varies, so it only compares the start of each issue. */
function fixKey(review: Review): string {
  return review.requiredFixes
    .map((f) => `${f.file}|${f.issue.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 60)}`)
    .sort()
    .join("\n");
}

/** Build, review, and send the Reviewer's required fixes back to the Engineer, up to MAX_REVIEW_ROUNDS times. */
export async function buildReviewLoop(input: BuildInput, deps: LoopDeps): Promise<LoopOutcome> {
  const base = input.spentUsd ?? 0;
  const reviewDeps = { runAgent: deps.runAgent, log: deps.log };
  const history: ReviewRound[] = [];
  let cost = 0;
  let fixRounds = 0;
  let lastKey: string | undefined;

  let build = await buildRun(input, deps);
  cost += build.costUsd;
  if (build.status === "declined") return { status: "declined", build, review: null, rounds: 0, history, costUsd: cost };
  const gateChecks = build.gateChecks;

  let diff = deps.collectDiff(input.worktree);
  let review = await reviewRun(input.worktree, input.design, reviewDeps, diff, input.request);
  cost += review.costUsd;
  history.push({ round: 0, verdict: review.output.verdict, requiredFixes: review.output.requiredFixes.length });

  const result = (status: LoopStatus): LoopOutcome => ({ status, build, review: review.output, rounds: fixRounds, history, costUsd: cost });

  for (;;) {
    if (!buildOk(build.status)) return result("build_failed");
    if (review.output.verdict === "approve") return result("approved");

    const fixes = review.output.requiredFixes;
    if (fixes.length === 0) {
      deps.log("reviewer asked for changes but listed no fixes, stopping");
      return result("changes_requested");
    }
    if (fixRounds >= MAX_REVIEW_ROUNDS) {
      deps.log(`reviewer still wants changes after ${fixRounds} fix round(s), stopping`);
      return result("changes_requested");
    }
    if (base + cost >= MAX_RUN_COST_USD) {
      deps.log(`stopping, est. run cost $${(base + cost).toFixed(2)} reached the cap`);
      return result("budget");
    }
    const key = fixKey(review.output);
    if (key === lastKey) {
      deps.log("reviewer asked for the same fixes twice, stopping");
      return result("stuck");
    }
    lastKey = key;

    fixRounds++;
    deps.log(`review round ${fixRounds}: ${fixes.length} fix(es) requested`);
    const before = diff;
    build = await buildRun({ ...input, spentUsd: base + cost, gateChecks, reviewFixes: formatFixes(review.output) }, deps);
    cost += build.costUsd;
    if (build.status === "declined") {
      deps.log("engineer declined to apply the review fixes, stopping");
      return result("stuck");
    }
    if (!buildOk(build.status)) return result("build_failed");

    diff = deps.collectDiff(input.worktree);
    if (diff === before) {
      deps.log("engineer made no change in response to the review, stopping");
      return result("stuck");
    }
    review = await reviewRun(input.worktree, input.design, reviewDeps, diff, input.request);
    cost += review.costUsd;
    history.push({ round: fixRounds, verdict: review.output.verdict, requiredFixes: review.output.requiredFixes.length });
  }
}

export { defaultRunAgent };
