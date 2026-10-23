import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { defaultBranch } from "./worktree.js";

export const MAX_DIFF_CHARS = 60_000;
const MAX_NEW_FILE_CHARS = 8_000;
const MAX_NEW_FILES = 20;

const git = (cwd: string, args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });

/**
 * Everything the run changed, in one string: tracked changes against the base branch (committed or not),
 * plus new untracked files, which plain `git diff` leaves out. Read-only, and trusted orchestrator code.
 */
export function collectDiff(worktree: string, maxChars = MAX_DIFF_CHARS): string {
  const base = `origin/${defaultBranch(worktree)}`;
  const parts: string[] = [git(worktree, ["diff", "--no-color", base])];

  const untracked = git(worktree, ["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean);
  for (const file of untracked.slice(0, MAX_NEW_FILES)) {
    const full = path.join(worktree, file);
    if (statSync(full).size > 1_000_000) {
      parts.push(`=== new file: ${file} (too large to show) ===\n`);
      continue;
    }
    const text = readFileSync(full, "utf8");
    if (text.includes("\0")) {
      parts.push(`=== new file: ${file} (binary) ===\n`);
      continue;
    }
    const shown = text.length > MAX_NEW_FILE_CHARS ? `${text.slice(0, MAX_NEW_FILE_CHARS)}\n[file truncated]` : text;
    parts.push(`=== new file: ${file} ===\n${shown}\n`);
  }
  if (untracked.length > MAX_NEW_FILES) parts.push(`[${untracked.length - MAX_NEW_FILES} more new files not shown]`);

  const all = parts.join("\n").trim();
  if (all.length <= maxChars) return all;
  return `${all.slice(0, maxChars)}\n\n[diff truncated, ${all.length - maxChars} more characters. Use Read on the changed files for the rest.]`;
}
