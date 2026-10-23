import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

export const ALLOWED_GITHUB_OWNER = "abdirahman2ali";

export type Decision = { allow: true } | { allow: false; reason: string };

const deny = (reason: string): Decision => ({ allow: false, reason });
const allow: Decision = { allow: true };

/** Resolve symlinks on the deepest existing ancestor, so new files and symlink escapes are both handled. */
export function realResolve(p: string): string {
  const abs = path.resolve(p);
  let current = abs;
  const rest: string[] = [];
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    rest.unshift(path.basename(current));
    current = parent;
  }
  return path.join(realpathSync(current), ...rest);
}

export function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(realResolve(root), realResolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// ".git" is a pointer file inside a worktree. An agent that edits it can corrupt the repo.
const SECRET_SEGMENTS = [".ssh", "credentials", ".aws", ".gnupg", ".git"];
const SECRET_FILES = [".databrickscfg", ".netrc", ".npmrc", "id_rsa", "id_ed25519"];

export function isSecretPath(p: string): boolean {
  const parts = realResolve(p).split(path.sep);
  const base = parts[parts.length - 1] ?? "";
  if (base === ".env.example") return false;
  if (base === ".env" || base.startsWith(".env.")) return true;
  if (SECRET_FILES.includes(base)) return true;
  return parts.some((part) => SECRET_SEGMENTS.includes(part));
}

export function checkPath(worktree: string, candidate: string): Decision {
  const abs = path.isAbsolute(candidate) ? candidate : path.join(worktree, candidate);
  if (!isInside(worktree, abs)) return deny(`Path is outside the run worktree: ${candidate}`);
  if (isSecretPath(abs)) return deny(`Path is protected (secrets or .git): ${candidate}`);
  return allow;
}

const PATH_KEYS = ["file_path", "path", "notebook_path"] as const;
const STRUCTURED_OUTPUT_TOOL = "StructuredOutput";

function checkGlobPattern(pattern: string): Decision {
  if (path.isAbsolute(pattern) || pattern.split(/[\\/]/).includes("..")) {
    return deny(`Pattern escapes the worktree: ${pattern}`);
  }
  return allow;
}

// Operators, any $ (variables), quotes and backslashes (which hide a ".." from the token check once the shell strips them),
// and braces (brace expansion can produce ".." tokens).
const SHELL_META = /[;&|<>`\n\r$"'\\{}]/;
// ~ expands to the home directory at the start of a word or after = or :. HEAD~1 is fine.
const TILDE_EXPANSION = /(^|[\s=:])~/;

/** Command prefixes a run may execute. Read-only git: agents never stage, commit or push. No network tools, no deletes. */
export const BASH_ALLOWLIST: readonly RegExp[] = [
  /^git (status|diff|log|show)( |$)/,
  /^git branch --show-current$/,
  /^npm (test|run (typecheck|lint|test))( |$)/,
  // --no-install: without it npx downloads and runs an arbitrary package from the registry.
  /^npx --no-install (tsc|vitest|eslint)( |$)/,
  /^(python3?|python3? -m) (pytest|ruff)( |$)/,
  /^(pytest|ruff check|ruff format --check)( |$)/,
  /^ls( |$)/,
];

// Linters can rewrite files with the fix flags. These git flags read or write files anywhere, or run configured programs.
const DENIED_FLAGS =
  /(^|\s)(--(fix|fix-only|unsafe-fixes|add-noqa)\b|--no-index\b|--output(=|\s|$)|--ext-diff\b|--textconv\b|-O\S*)/;

/** A token that points outside the worktree or at a protected file, or null. Covers `--flag=value` and `rev:path`. */
function escapingToken(worktree: string, raw: string): string | null {
  const isFlag = raw.startsWith("-");
  if (isFlag && !raw.includes("=")) return null;
  const value = isFlag ? raw.slice(raw.indexOf("=") + 1) : raw;
  for (const part of value.split(":")) {
    if (!part) continue;
    const leavesByPath = part.startsWith("/") || part.split("/").includes("..");
    if (leavesByPath ? !checkPath(worktree, part).allow : isSecretPath(path.join(worktree, part))) return part;
  }
  return null;
}

/**
 * Bash is where the path guard is easiest to bypass, since an allowed command takes arbitrary paths and flags.
 * Every argument is therefore checked against the worktree here, not just the command prefix.
 */
export function checkBash(command: string, worktree: string): Decision {
  const trimmed = command.trim();
  if (SHELL_META.test(trimmed)) return deny("Shell operators, variables, quotes and braces are not allowed");
  if (TILDE_EXPANSION.test(trimmed)) return deny("Home directory paths are not allowed");
  if (DENIED_FLAGS.test(trimmed)) return deny("This flag can modify files or read outside the worktree");
  if (!BASH_ALLOWLIST.some((re) => re.test(trimmed))) {
    return deny(`Command is not on the allowlist: ${trimmed}`);
  }
  for (const token of trimmed.split(/\s+/).slice(1)) {
    const bad = escapingToken(worktree, token);
    if (bad) return deny(`Path is outside the worktree or protected: ${bad}`);
  }
  return allow;
}

/** Decide whether a tool call is permitted. Pure, so it is easy to test. */
export function decide(
  worktree: string,
  toolName: string,
  input: Record<string, unknown>,
  allowedTools: readonly string[],
): Decision {
  // The SDK returns structured output through this tool. It reads and writes nothing on disk.
  if (toolName === STRUCTURED_OUTPUT_TOOL) return allow;
  if (!allowedTools.includes(toolName)) return deny(`Tool not enabled for this agent: ${toolName}`);

  if (toolName === "Bash") {
    const command = input["command"];
    return typeof command === "string" ? checkBash(command, worktree) : deny("Bash call has no command");
  }

  for (const key of PATH_KEYS) {
    const value = input[key];
    if (value === undefined) continue;
    if (typeof value !== "string") return deny(`Invalid ${key}`);
    const result = checkPath(worktree, value);
    if (!result.allow) return result;
  }

  const pattern = input["pattern"];
  if (toolName === "Glob" && typeof pattern === "string") return checkGlobPattern(pattern);

  return allow;
}

const REPO_NAME = /^[a-z0-9][a-z0-9._-]*$/;

/** Confirm the named repo is a git repo directly under codeRoot and belongs to the allowed owner. */
export function validateRepo(codeRoot: string, name: string): string {
  if (!REPO_NAME.test(name)) throw new Error(`Invalid repo name: ${name}`);
  const repoPath = path.join(codeRoot, name);
  if (!existsSync(repoPath) || !statSync(repoPath).isDirectory()) {
    throw new Error(`Repo not found under code/: ${name}`);
  }
  if (!isInside(codeRoot, repoPath) || path.dirname(realResolve(repoPath)) !== realResolve(codeRoot)) {
    throw new Error(`Repo must be a direct child of code/: ${name}`);
  }
  let remote: string;
  try {
    remote = execFileSync("git", ["-C", repoPath, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    throw new Error(`Repo has no origin remote: ${name}`);
  }
  const owned = new RegExp(`github\\.com[:/]${ALLOWED_GITHUB_OWNER}/`, "i").test(remote);
  if (!owned) throw new Error(`Remote is not owned by ${ALLOWED_GITHUB_OWNER}: ${name}`);
  return repoPath;
}
