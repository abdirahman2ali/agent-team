import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupWorktree, createWorktree, makeRunName, slugify } from "../src/worktree.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

let sandbox: string;
let repo: string;

beforeAll(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), "wt-"));
  const origin = path.join(sandbox, "origin.git");
  repo = path.join(sandbox, "repo");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  writeFileSync(path.join(repo, "README.md"), "hi");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-q", "origin", "main");
});

afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

describe("names", () => {
  it("slugifies requests", () => {
    expect(slugify("Add a CSV export!!")).toBe("add-a-csv-export");
    expect(slugify("   ")).toBe("run");
  });

  it("builds a unique run name with a timestamp", () => {
    const name = makeRunName("Add CSV export", new Date("2026-10-22T20:58:11Z"));
    expect(name).toBe("add-csv-export-20261022205811");
  });
});

describe("cleanupWorktree", () => {
  const commitIn = (wt: string, file: string) => {
    writeFileSync(path.join(wt, file), "x");
    git(wt, "add", ".");
    git(wt, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", file);
  };

  it("removes a clean worktree and its branch", () => {
    const wt = createWorktree(repo, "clean-run");
    const result = cleanupWorktree(repo, "clean-run");
    expect(result.forced).toBe(false);
    expect(existsSync(wt.path)).toBe(false);
    expect(git(repo, "branch", "--list", "agent/clean-run")).toBe("");
  });

  it("refuses when there are uncommitted changes, even with force", () => {
    const wt = createWorktree(repo, "dirty-run");
    writeFileSync(path.join(wt.path, "new.txt"), "work in progress");
    expect(() => cleanupWorktree(repo, "dirty-run")).toThrow(/uncommitted/);
    expect(() => cleanupWorktree(repo, "dirty-run", true)).toThrow(/uncommitted/);
    expect(existsSync(wt.path)).toBe(true);
  });

  it("refuses unmerged commits unless forced", () => {
    const wt = createWorktree(repo, "ahead-run");
    commitIn(wt.path, "a.txt");
    expect(() => cleanupWorktree(repo, "ahead-run")).toThrow(/not on origin\/main.*--force/);
    expect(existsSync(wt.path)).toBe(true);

    const result = cleanupWorktree(repo, "ahead-run", true);
    expect(result.forced).toBe(true);
    expect(existsSync(wt.path)).toBe(false);
  });

  it("rejects bad names and unknown runs", () => {
    expect(() => cleanupWorktree(repo, "../escape")).toThrow(/Invalid run name/);
    expect(() => cleanupWorktree(repo, "nope-run")).toThrow(/No worktree/);
  });
});

describe("createWorktree", () => {
  it("creates a worktree on a new agent/ branch from origin/main", () => {
    const wt = createWorktree(repo, "demo-run");
    expect(wt.path).toBe(path.join(repo, ".claude", "worktrees", "demo-run"));
    expect(wt.branch).toBe("agent/demo-run");
    expect(existsSync(path.join(wt.path, "README.md"))).toBe(true);
    expect(git(wt.path, "branch", "--show-current")).toBe("agent/demo-run");
  });

  it("keeps the worktrees folder out of git via info/exclude", () => {
    const exclude = readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain(".claude/worktrees/");
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  it("refuses to reuse a worktree name", () => {
    expect(() => createWorktree(repo, "demo-run")).toThrow(/already exists/);
  });
});
