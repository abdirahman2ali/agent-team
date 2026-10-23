import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";

const git = (repo: string, args: string[]): string =>
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30)
    .replace(/-+$/g, "");
  return slug || "run";
}

export function makeRunName(request: string, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return `${slugify(request)}-${stamp}`;
}

export function defaultBranch(repo: string): string {
  try {
    return git(repo, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).replace(/^origin\//, "");
  } catch {
    for (const name of ["main", "master"]) {
      try {
        git(repo, ["rev-parse", "--verify", `refs/remotes/origin/${name}`]);
        return name;
      } catch {
        // try next
      }
    }
    throw new Error("Could not find origin/main or origin/master");
  }
}

const RUN_NAME = /^[a-z0-9][a-z0-9-]*$/;

export interface CleanupResult {
  path: string;
  branch: string;
  forced: boolean;
}

/**
 * Remove a run's worktree and branch. Refuses if the worktree has uncommitted changes (even with force),
 * or if the branch has commits that are not on the base branch (unless force, e.g. after a squash merge).
 */
export function cleanupWorktree(repo: string, runName: string, force = false): CleanupResult {
  if (!RUN_NAME.test(runName)) throw new Error(`Invalid run name: ${runName}`);
  const worktreePath = path.join(repo, ".claude", "worktrees", runName);
  const branch = `agent/${runName}`;
  if (!existsSync(worktreePath)) throw new Error(`No worktree for run: ${runName}`);

  if (git(worktreePath, ["status", "--porcelain"]) !== "") {
    throw new Error(`Worktree has uncommitted changes, nothing removed: ${worktreePath}`);
  }

  git(repo, ["fetch", "origin"]);
  const base = defaultBranch(repo);
  const unique = Number(git(repo, ["rev-list", "--count", `origin/${base}..${branch}`]));
  if (unique > 0 && !force) {
    throw new Error(
      `Branch ${branch} has ${unique} commit(s) not on origin/${base}, nothing removed. ` +
        "If the PR is merged (a squash merge looks unmerged), rerun with --force.",
    );
  }

  git(repo, ["worktree", "remove", worktreePath]);
  git(repo, ["branch", "-D", branch]);
  return { path: worktreePath, branch, forced: force && unique > 0 };
}

export interface Worktree {
  path: string;
  branch: string;
}

/** Create .claude/worktrees/<runName> on a new branch cut from origin's default branch. */
export function createWorktree(repo: string, runName: string): Worktree {
  git(repo, ["fetch", "origin"]);
  const base = defaultBranch(repo);
  const worktreePath = path.join(repo, ".claude", "worktrees", runName);
  const branch = `agent/${runName}`;
  if (existsSync(worktreePath)) throw new Error(`Worktree already exists: ${worktreePath}`);
  git(repo, ["worktree", "add", "--no-track", worktreePath, "-b", branch, `origin/${base}`]);

  const exclude = path.join(git(repo, ["rev-parse", "--absolute-git-dir"]), "info", "exclude");
  const line = ".claude/worktrees/";
  const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  if (!current.split("\n").includes(line)) appendFileSync(exclude, `${current.endsWith("\n") || current === "" ? "" : "\n"}${line}\n`);

  return { path: worktreePath, branch };
}
