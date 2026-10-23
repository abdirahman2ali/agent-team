import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectDiff } from "../src/diff.js";
import type { AgentResult, AgentSpec } from "../src/runner.js";

// Same fake-github trick as the orchestrator tests: only validateRepo is replaced.
import { vi } from "vitest";
vi.mock("../src/guard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/guard.js")>();
  return { ...actual, validateRepo: (root: string, name: string) => path.join(root, name) };
});
const { reviewRun } = await import("../src/orchestrator.js");
const { createWorktree } = await import("../src/worktree.js");

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

let sandbox: string;
let repo: string;
let n = 0;

beforeAll(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), "diff-"));
  const origin = path.join(sandbox, "origin.git");
  repo = path.join(sandbox, "repo");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  writeFileSync(path.join(repo, "a.txt"), "one\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-q", "origin", "main");
});

afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

const freshWorktree = () => createWorktree(repo, `diff-run-${++n}`).path;

describe("collectDiff", () => {
  it("is empty when nothing changed", () => {
    expect(collectDiff(freshWorktree())).toBe("");
  });

  it("includes uncommitted edits to tracked files", () => {
    const wt = freshWorktree();
    writeFileSync(path.join(wt, "a.txt"), "one\ntwo\n");
    const diff = collectDiff(wt);
    expect(diff).toContain("diff --git a/a.txt b/a.txt");
    expect(diff).toContain("+two");
  });

  it("includes new untracked files, which plain git diff leaves out", () => {
    const wt = freshWorktree();
    writeFileSync(path.join(wt, "brand-new.ts"), "export const x = 1;\n");
    expect(git(wt, "diff", "origin/main")).toBe("");
    const diff = collectDiff(wt);
    expect(diff).toContain("=== new file: brand-new.ts ===");
    expect(diff).toContain("export const x = 1;");
  });

  it("includes committed changes on the branch, not just uncommitted ones", () => {
    const wt = freshWorktree();
    writeFileSync(path.join(wt, "a.txt"), "one\ncommitted\n");
    git(wt, "add", ".");
    git(wt, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "c");
    expect(collectDiff(wt)).toContain("+committed");
  });

  it("does not stage anything while collecting", () => {
    const wt = freshWorktree();
    writeFileSync(path.join(wt, "new.txt"), "x");
    collectDiff(wt);
    expect(git(wt, "diff", "--cached", "--name-only")).toBe("");
    expect(git(wt, "status", "--porcelain")).toBe("?? new.txt");
  });

  it("marks binary files instead of dumping them", () => {
    const wt = freshWorktree();
    writeFileSync(path.join(wt, "img.bin"), Buffer.from([0, 1, 2, 0, 255]));
    expect(collectDiff(wt)).toContain("img.bin (binary)");
  });

  it("truncates a very large diff and says so", () => {
    const wt = freshWorktree();
    writeFileSync(path.join(wt, "a.txt"), "one\n" + "line\n".repeat(5000));
    const diff = collectDiff(wt, 1000);
    expect(diff.length).toBeLessThan(1300);
    expect(diff).toContain("[diff truncated");
  });
});

describe("reviewRun", () => {
  it("hands the reviewer the diff in the prompt", async () => {
    const wt = freshWorktree();
    writeFileSync(path.join(wt, "a.txt"), "one\nreview-me\n");
    const prompts: string[] = [];
    const deps = {
      log: () => {},
      runAgent: async <T>(_s: AgentSpec<T>, opts: { prompt: string }): Promise<AgentResult<T>> => {
        prompts.push(opts.prompt);
        return { output: { verdict: "approve", summary: "ok", requiredFixes: [] } as T, costUsd: 0, turns: 1 };
      },
    };
    await reviewRun(wt, undefined, deps);
    expect(prompts[0]).toContain("+review-me");
  });
});
