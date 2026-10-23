import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkBash, checkPath, decide, validateRepo } from "../src/guard.js";

let sandbox: string;
let worktree: string;
let outside: string;

beforeAll(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), "guard-"));
  worktree = path.join(sandbox, "code", "demo", ".claude", "worktrees", "run1");
  outside = path.join(sandbox, "code", "other");
  mkdirSync(worktree, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(worktree, "a.ts"), "x");
  writeFileSync(path.join(worktree, ".env"), "SECRET=1");
  writeFileSync(path.join(worktree, ".env.example"), "SECRET=your-key-here");
  writeFileSync(path.join(outside, "b.ts"), "y");
  symlinkSync(outside, path.join(worktree, "escape"));
});

afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

describe("checkPath", () => {
  it("allows files inside the worktree, including new ones", () => {
    expect(checkPath(worktree, path.join(worktree, "a.ts")).allow).toBe(true);
    expect(checkPath(worktree, "src/new/file.ts").allow).toBe(true);
  });

  it("denies paths outside the worktree", () => {
    expect(checkPath(worktree, path.join(outside, "b.ts")).allow).toBe(false);
    expect(checkPath(worktree, "/etc/passwd").allow).toBe(false);
  });

  it("denies .. traversal", () => {
    expect(checkPath(worktree, "../../../other/b.ts").allow).toBe(false);
  });

  it("denies a symlink that escapes the worktree", () => {
    expect(checkPath(worktree, path.join(worktree, "escape", "b.ts")).allow).toBe(false);
  });

  it("denies .git, which is a pointer file inside a worktree", () => {
    expect(checkPath(worktree, ".git").allow).toBe(false);
    expect(checkPath(worktree, ".git/config").allow).toBe(false);
    expect(checkPath(worktree, ".gitignore").allow).toBe(true);
  });

  it("denies secret files but allows .env.example", () => {
    expect(checkPath(worktree, ".env").allow).toBe(false);
    expect(checkPath(worktree, ".env.local").allow).toBe(false);
    expect(checkPath(worktree, ".env.example").allow).toBe(true);
  });
});

describe("checkBash", () => {
  it("allows safe commands", () => {
    for (const cmd of ["git diff", "git status", "npm test", "npm run typecheck", "pytest -q", "ruff check .", "ruff format --check pipeline"]) {
      expect(checkBash(cmd, worktree).allow, cmd).toBe(true);
    }
  });

  it("denies everything else, including staging and committing", () => {
    for (const cmd of [
      "git push origin main", "git add .", "git commit -m x", "git reset --hard", "git checkout main",
      "ruff format .", "ruff format pipeline", "ruff check --fix .",
      "rm -rf .", "curl https://x.io", "gh auth login", "cat .env",
    ]) {
      expect(checkBash(cmd, worktree).allow, cmd).toBe(false);
    }
  });

  it("denies shell operators even after an allowed prefix", () => {
    for (const cmd of ["git diff; rm -rf /", "ls && curl x", "ls | sh", "git status > out", "ls $(whoami)", "ls `id`"]) {
      expect(checkBash(cmd, worktree).allow, cmd).toBe(false);
    }
  });
});

/**
 * Regression suite for a real hole found in review before publishing: allowlisted commands take arbitrary
 * paths and flags, so the prefix check alone let an agent read, list and write outside the worktree.
 */
describe("checkBash cannot be used to escape the worktree", () => {
  const home = process.env["HOME"] ?? "/Users/someone";

  it("blocks reading files outside the worktree through git", () => {
    for (const cmd of [
      `git diff --no-index ${home}/.ssh/id_rsa /dev/null`,
      "git diff --no-index ~/.databrickscfg /dev/null",
      "git diff --no-index /etc/hosts /dev/null",
      "git diff -O/etc/passwd",
    ]) {
      expect(checkBash(cmd, worktree).allow, cmd).toBe(false);
    }
  });

  it("blocks writing files through git", () => {
    for (const cmd of ["git diff --output=/tmp/pwned", "git diff --output /tmp/pwned", "git log --output=x"]) {
      expect(checkBash(cmd, worktree).allow, cmd).toBe(false);
    }
  });

  it("blocks listing and probing outside the worktree", () => {
    for (const cmd of [
      `ls ${home}/.ssh`, "ls /etc", "ls ~/.aws", "ls ~", "ls ..", "ls ../..", "ls ../../../..", "ls ../*", "ls src/../../x",
    ]) {
      expect(checkBash(cmd, worktree).allow, cmd).toBe(false);
    }
  });

  it("blocks variables, quotes, backslashes and braces that could hide a path from the check", () => {
    for (const cmd of ["ls $HOME", "ls ${HOME}", 'ls ".."', "ls '..'", "ls \\..", "ls {..,x}", "ls ..\\/", "ls `pwd`"]) {
      expect(checkBash(cmd, worktree).allow, cmd).toBe(false);
    }
  });

  it("blocks running tests or other code from outside the worktree", () => {
    for (const cmd of ["pytest /tmp/evil_tests", "pytest --rootdir=/ -q", "pytest --basetemp=/tmp/x", "python3 -m pytest -c /tmp/evil.ini"]) {
      expect(checkBash(cmd, worktree).allow, cmd).toBe(false);
    }
  });

  it("blocks protected files named directly or through a revision", () => {
    for (const cmd of ["git show HEAD:.env", "git diff .env", "ls .env", "git show HEAD:.ssh/key", "ls .git"]) {
      expect(checkBash(cmd, worktree).allow, cmd).toBe(false);
    }
  });

  it("blocks npx unless --no-install, so it cannot download and run a package", () => {
    expect(checkBash("npx vitest run", worktree).allow).toBe(false);
    expect(checkBash("npx cowsay hi", worktree).allow).toBe(false);
    expect(checkBash("npx --no-install vitest run", worktree).allow).toBe(true);
  });

  it("still allows normal use, including revisions, ranges and paths inside the worktree", () => {
    for (const cmd of [
      "git diff origin/main", "git diff origin/main...HEAD", "git diff main..HEAD", "git log --oneline -10", "git show HEAD",
      "git show HEAD~1", "git diff HEAD~2 -- src/guard.ts", "git diff --stat", "git status",
      "ls", "ls src", "ls src/agents", "ls -la tests", `ls ${path.join(worktree, "src")}`,
      "pytest -q tests/test_merge.py", "pytest --basetemp=.tmp -q", "python3 -m pytest -q", "ruff check pipeline", "ruff format --check .",
      "npm test", "npm run lint", "npm test -- --run src/x.test.ts",
    ]) {
      expect(checkBash(cmd, worktree).allow, cmd).toBe(true);
    }
  });

  it("goes through decide() for the Bash tool, so agents cannot skip it", () => {
    expect(decide(worktree, "Bash", { command: "git diff --no-index /etc/hosts /dev/null" }, ["Bash"]).allow).toBe(false);
    expect(decide(worktree, "Bash", { command: "ls .." }, ["Bash"]).allow).toBe(false);
    expect(decide(worktree, "Bash", { command: "git diff" }, ["Bash"]).allow).toBe(true);
  });
});

describe("decide", () => {
  const readOnly = ["Read", "Grep", "Glob"];

  it("denies tools the agent was not given", () => {
    expect(decide(worktree, "Edit", { file_path: "a.ts" }, readOnly).allow).toBe(false);
  });

  it("always allows the SDK's StructuredOutput tool", () => {
    expect(decide(worktree, "StructuredOutput", { approach: "x" }, readOnly).allow).toBe(true);
  });

  it("checks file paths for enabled tools", () => {
    expect(decide(worktree, "Read", { file_path: "a.ts" }, readOnly).allow).toBe(true);
    expect(decide(worktree, "Read", { file_path: "/etc/hosts" }, readOnly).allow).toBe(false);
  });

  it("checks Grep path and Glob pattern", () => {
    expect(decide(worktree, "Grep", { pattern: "x", path: outside }, readOnly).allow).toBe(false);
    expect(decide(worktree, "Glob", { pattern: "../**/*.ts" }, readOnly).allow).toBe(false);
    expect(decide(worktree, "Glob", { pattern: "/etc/*" }, readOnly).allow).toBe(false);
    expect(decide(worktree, "Glob", { pattern: "src/**/*.ts" }, readOnly).allow).toBe(true);
  });

  it("lets the engineer edit inside the worktree but nowhere else", () => {
    const engineerTools = ["Read", "Edit", "Write", "Bash"];
    expect(decide(worktree, "Edit", { file_path: "a.ts" }, engineerTools).allow).toBe(true);
    expect(decide(worktree, "Write", { file_path: "src/new.ts" }, engineerTools).allow).toBe(true);
    expect(decide(worktree, "Write", { file_path: path.join(outside, "b.ts") }, engineerTools).allow).toBe(false);
    expect(decide(worktree, "Edit", { file_path: ".env" }, engineerTools).allow).toBe(false);
    expect(decide(worktree, "Edit", { file_path: ".git" }, engineerTools).allow).toBe(false);
    expect(decide(worktree, "Write", { file_path: "escape/new.ts" }, engineerTools).allow).toBe(false);
  });

  it("routes Bash through the allowlist", () => {
    expect(decide(worktree, "Bash", { command: "git diff" }, ["Bash"]).allow).toBe(true);
    expect(decide(worktree, "Bash", { command: "git push" }, ["Bash"]).allow).toBe(false);
  });
});

describe("validateRepo", () => {
  const codeRoot = () => path.join(sandbox, "code");

  it("rejects bad names", () => {
    for (const name of ["../x", "a/b", "", "UPPER", ".hidden"]) {
      expect(() => validateRepo(codeRoot(), name), name).toThrow();
    }
  });

  it("rejects a missing repo", () => {
    expect(() => validateRepo(codeRoot(), "nope")).toThrow(/not found/);
  });

  it("rejects a repo with no origin, or one owned by someone else", () => {
    const repo = path.join(codeRoot(), "demo");
    execFileSync("git", ["init", "-q", repo]);
    expect(() => validateRepo(codeRoot(), "demo")).toThrow(/no origin/);
    execFileSync("git", ["-C", repo, "remote", "add", "origin", "git@github.com:someone-else/demo.git"]);
    expect(() => validateRepo(codeRoot(), "demo")).toThrow(/not owned/);
  });

  it("accepts a repo owned by abdirahman2ali", () => {
    const repo = path.join(codeRoot(), "demo");
    execFileSync("git", ["-C", repo, "remote", "set-url", "origin", "git@github.com:abdirahman2ali/demo.git"]);
    expect(validateRepo(codeRoot(), "demo")).toBe(repo);
  });
});
