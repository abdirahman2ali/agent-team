import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { config as loadEnv } from "dotenv";
import { checkAuth } from "./auth.js";
import { detectChecks, runChecks } from "./checks.js";
import { collectDiff } from "./diff.js";
import { validateRepo } from "./guard.js";
import { Recorder } from "./metrics.js";
import {
  buildReviewLoop, defaultRunAgent, planRun, prepareRun, reviewRun, type GateDecision, type LoopStatus,
} from "./orchestrator.js";
import { DesignSchema, type Design } from "./schemas.js";
import { cleanupWorktree } from "./worktree.js";

const projectRoot = path.resolve(import.meta.dirname, "..");
const codeRoot = path.resolve(projectRoot, "..");
const runsDir = path.join(projectRoot, "runs");

const log = (line: string) => console.error(`[agent-team] ${line}`);

// Shared secrets first, then an optional project-local .env that overrides them. Values are never printed.
loadEnv({ path: path.resolve(codeRoot, "..", ".claude", "credentials", ".env"), quiet: true });
loadEnv({ path: path.join(projectRoot, ".env"), override: true, quiet: true });

const USAGE = [
  'run.ts --repo <name> "request"                 plan, approve, build, review',
  'run.ts --repo <name> --quick "request"         skip the design: build, review (small, clear requests)',
  'run.ts --repo <name> --plan-only "request"     stop after the approved design',
  "run.ts --repo <name> --review <run-name>       review an existing run worktree",
  "run.ts --repo <name> --cleanup <run-name> [--force]   remove a run's worktree and branch",
].join("\n  ");

async function askApproval(design: Design): Promise<GateDecision> {
  console.log("\n=== DESIGN ===\n" + JSON.stringify(design, null, 2) + "\n");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question("Approve? Type y, or type feedback to revise: ")).trim();
    if (answer.toLowerCase() === "y" || answer.toLowerCase() === "yes") return { approved: true };
    return { approved: false, feedback: answer || "Please reconsider and simplify." };
  } finally {
    rl.close();
  }
}

/** What to tell the user when the review loop ends without approval. Every one of these is a handoff to a human. */
const LOOP_ADVICE: Record<Exclude<LoopStatus, "approved">, string> = {
  changes_requested: "the Reviewer still has open fixes. Read the review above and decide whether to fix by hand or rerun.",
  stuck: "the loop is going in circles (repeated fixes, no change, or the Engineer disagreed). Read the review and the Engineer's notes, then decide.",
  budget: "stopped at the run cost cap. The work so far is in the worktree.",
  build_failed: "the automated checks are failing, so more review rounds would not help. See the last failing output above.",
  declined: "the Engineer declined the request.",
};

function checkRunName(runName: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(runName)) throw new Error(`Invalid run name: ${runName}`);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      repo: { type: "string" },
      review: { type: "string" },
      cleanup: { type: "string" },
      force: { type: "boolean", default: false },
      quick: { type: "boolean", default: false },
      "plan-only": { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  if (!values.repo) throw new Error(`Usage:\n  ${USAGE}`);
  if (values.quick && values["plan-only"]) throw new Error("--quick skips the design, so it cannot be combined with --plan-only");

  // Cleanup is local git work only, so it needs no auth.
  if (values.cleanup) {
    checkRunName(values.cleanup);
    const repoPath = validateRepo(codeRoot, values.repo);
    const result = cleanupWorktree(repoPath, values.cleanup, values.force);
    log(`removed ${result.path} and branch ${result.branch}${result.forced ? " (forced, branch had unmerged commits)" : ""}`);
    return;
  }

  // Fail before any worktree is created.
  const auth = checkAuth();
  if (!auth.ok) throw new Error(auth.detail);
  log(`auth: ${auth.detail}`);

  const metrics = new Recorder();
  const runAgent = metrics.instrument(defaultRunAgent);
  const deps = { runAgent, approve: askApproval, log };
  let metricsFile: string | undefined;

  try {
    if (values.review) {
      const runName = values.review;
      checkRunName(runName);
      const worktree = path.join(codeRoot, values.repo, ".claude", "worktrees", runName);
      if (!existsSync(worktree)) throw new Error(`No worktree for run: ${runName}`);
      metricsFile = path.join(runsDir, runName, "review-metrics.json");
      const designFile = path.join(runsDir, runName, "design.json");
      const design = existsSync(designFile)
        ? DesignSchema.parse(JSON.parse(readFileSync(designFile, "utf8")))
        : undefined;
      const result = await reviewRun(worktree, design, deps);
      console.log(JSON.stringify(result.output, null, 2));
      return;
    }

    const request = positionals.join(" ").trim();
    if (!request) throw new Error(`A request is required.\n  ${USAGE}`);

    let runName: string;
    let worktree: string;
    let design: Design | undefined;
    let spentUsd = 0;

    if (values.quick) {
      const prepared = prepareRun({ codeRoot, runsDir, repo: values.repo, request }, log);
      ({ runName, worktree } = prepared);
      metrics.notes["mode"] = "quick";
      log("quick mode: no design and no approval gate. The Engineer may decline a request that is not small and clear.");
    } else {
      const plan = await planRun({ codeRoot, runsDir, repo: values.repo, request }, deps);
      ({ runName, worktree } = plan);
      metrics.notes["mode"] = "full";
      spentUsd = plan.costUsd;
      log(`worktree: ${worktree}`);
      if (!plan.approved || !plan.design) {
        metricsFile = path.join(runsDir, runName, "metrics.json");
        log("design not approved");
        process.exitCode = 1;
        return;
      }
      if (values["plan-only"]) {
        metricsFile = path.join(runsDir, runName, "metrics.json");
        log("design approved");
        return;
      }
      design = plan.design;
    }
    metricsFile = path.join(runsDir, runName, "metrics.json");

    const loop = await buildReviewLoop(
      { worktree, request, ...(design ? { design } : {}), spentUsd },
      { runAgent, log, detectChecks, runChecks, collectDiff },
    );
    const { build } = loop;
    metrics.notes["build"] = { status: build.status, attempts: build.attempts };
    metrics.notes["reviewLoop"] = { status: loop.status, fixRounds: loop.rounds, history: loop.history };

    if (loop.status === "declined") {
      log("the Engineer declined: this request is not small and clear enough for --quick. Rerun without --quick to get a design first.");
      if (build.report?.notes.length) console.log("Engineer notes:\n- " + build.report.notes.join("\n- "));
      if (collectDiff(worktree)) log("warning: the worktree has changes even though the Engineer declined. Check them before using.");
      log(`when done: npm run run -- --repo ${values.repo} --cleanup ${runName}`);
      process.exitCode = 1;
      return;
    }

    console.log("\n=== BUILD ===\n" + JSON.stringify({ status: build.status, attempts: build.attempts, report: build.report }, null, 2));
    if (build.failures) console.log("\nLast failing output:\n" + build.failures);

    console.log("\n=== REVIEW ===\n" + JSON.stringify(loop.review, null, 2));
    if (loop.history.length > 1) {
      console.log("\nReview history: " + loop.history.map((h) => `round ${h.round} ${h.verdict} (${h.requiredFixes} fixes)`).join(" -> "));
    }

    log(`build ${build.status}, review loop ${loop.status} after ${loop.rounds} fix round(s)`);
    if (loop.status !== "approved") log(LOOP_ADVICE[loop.status]);
    log(`changes are uncommitted in ${worktree}`);
    log(`when done: npm run run -- --repo ${values.repo} --cleanup ${runName}`);
    process.exitCode = loop.status === "approved" ? 0 : 1;
  } finally {
    if (metrics.calls.length > 0) {
      console.error(`\n${metrics.format()}\n(est. = SDK estimate at API prices. On a subscription this is usage against your plan limits, not a bill.)`);
      if (metricsFile) {
        metrics.write(metricsFile);
        log(`metrics: ${metricsFile}`);
      }
    }
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
