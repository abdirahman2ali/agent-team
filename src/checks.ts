import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export interface Check {
  name: string;
  command: string;
  args: string[];
}

export interface CheckResult {
  name: string;
  ok: boolean;
  output: string;
}

const OUTPUT_TAIL_CHARS = 3000;
const CHECK_TIMEOUT_MS = 5 * 60 * 1000;

function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function npmScripts(worktree: string): Record<string, unknown> {
  const scripts = readJson(path.join(worktree, "package.json"))?.["scripts"];
  return typeof scripts === "object" && scripts !== null ? (scripts as Record<string, unknown>) : {};
}

/** Work out which automated checks a repo has. Returns [] for static sites and anything unrecognised. */
export function detectChecks(worktree: string): Check[] {
  const checks: Check[] = [];

  const scripts = npmScripts(worktree);
  const test = scripts["test"];
  // `npm init` leaves a placeholder test script that always fails.
  if (typeof test === "string" && !test.includes("no test specified")) {
    checks.push({ name: "npm test", command: "npm", args: ["test"] });
  }
  for (const name of ["typecheck", "lint"]) {
    if (typeof scripts[name] === "string") checks.push({ name: `npm run ${name}`, command: "npm", args: ["run", name] });
  }

  const pyproject = path.join(worktree, "pyproject.toml");
  const pyprojectText = existsSync(pyproject) ? readFileSync(pyproject, "utf8") : "";
  const hasPytest =
    existsSync(path.join(worktree, "pytest.ini")) ||
    existsSync(path.join(worktree, "tests")) ||
    pyprojectText.includes("[tool.pytest");
  if (hasPytest) checks.push({ name: "pytest", command: "python3", args: ["-m", "pytest", "-q"] });

  const hasRuff =
    existsSync(path.join(worktree, "ruff.toml")) ||
    existsSync(path.join(worktree, ".ruff.toml")) ||
    pyprojectText.includes("[tool.ruff");
  if (hasRuff) checks.push({ name: "ruff check", command: "ruff", args: ["check", "."] });

  return checks;
}

function tail(text: string): string {
  return text.length > OUTPUT_TAIL_CHARS ? `...${text.slice(-OUTPUT_TAIL_CHARS)}` : text;
}

/** Run each check in the worktree. This is trusted orchestrator code, so it does not go through the agent guard. */
export function runChecks(worktree: string, checks: Check[]): CheckResult[] {
  return checks.map((check) => {
    const result = spawnSync(check.command, check.args, {
      cwd: worktree,
      encoding: "utf8",
      timeout: CHECK_TIMEOUT_MS,
      env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", CI: "true" },
    });
    const output = tail(`${result.stdout ?? ""}${result.stderr ?? ""}`.trim());
    if (result.error) return { name: check.name, ok: false, output: `${result.error.message}\n${output}`.trim() };
    return { name: check.name, ok: result.status === 0, output };
  });
}

export function formatFailures(results: CheckResult[]): string {
  return results
    .filter((r) => !r.ok)
    .map((r) => `### ${r.name} FAILED\n${r.output}`)
    .join("\n\n");
}
