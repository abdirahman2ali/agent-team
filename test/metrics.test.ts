import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { Recorder } from "../src/metrics.js";
import type { AgentResult, AgentSpec, RunAgentOptions } from "../src/runner.js";

const spec = (name: string): AgentSpec<{ ok: boolean }> => ({
  name, systemPrompt: "", tools: [], schema: z.object({ ok: z.boolean() }), maxTurns: 1, maxBudgetUsd: 1,
});

const tmp = mkdtempSync(path.join(tmpdir(), "metrics-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** A fake runAgent that reports `blocked` blocked tool calls through onBlocked. */
const fake = (turns: number, cost: number, blocked = 0, fail = false) =>
  async <T>(_s: AgentSpec<T>, opts: RunAgentOptions): Promise<AgentResult<T>> => {
    for (let i = 0; i < blocked; i++) opts.onBlocked?.("Bash", "nope");
    if (fail) throw new Error("agent exploded");
    return { output: { ok: true } as T, costUsd: cost, turns };
  };

const opts = { worktree: "/wt", prompt: "p" };

describe("Recorder", () => {
  it("records turns, estimated cost and blocked calls per agent call", async () => {
    const rec = new Recorder();
    await rec.instrument(fake(10, 0.7, 2))(spec("architect"), opts);
    await rec.instrument(fake(20, 0.9, 3))(spec("engineer"), opts);

    expect(rec.calls).toHaveLength(2);
    expect(rec.calls[0]).toMatchObject({ agent: "architect", call: 1, ok: true, turns: 10, estCostUsd: 0.7, blocked: 2 });
    expect(rec.calls[1]).toMatchObject({ agent: "engineer", blocked: 3 });
    expect(rec.totals()).toMatchObject({ calls: 2, turns: 30, blocked: 5 });
    expect(rec.totals().estCostUsd).toBeCloseTo(1.6);
  });

  it("numbers repeated calls to the same agent", async () => {
    const rec = new Recorder();
    const run = rec.instrument(fake(1, 0.1));
    await run(spec("engineer"), opts);
    await run(spec("engineer"), opts);
    expect(rec.calls.map((c) => c.call)).toEqual([1, 2]);
  });

  it("still forwards blocked calls to the caller's own onBlocked", async () => {
    const rec = new Recorder();
    const seen: string[] = [];
    await rec.instrument(fake(1, 0, 2))(spec("a"), { ...opts, onBlocked: (t) => seen.push(t) });
    expect(seen).toEqual(["Bash", "Bash"]);
  });

  it("records a failed call and rethrows", async () => {
    const rec = new Recorder();
    await expect(rec.instrument(fake(1, 0, 1, true))(spec("reviewer"), opts)).rejects.toThrow("agent exploded");
    expect(rec.calls[0]).toMatchObject({ agent: "reviewer", ok: false, blocked: 1, error: "agent exploded" });
  });

  it("formats a table with a total row and marks failures", async () => {
    const rec = new Recorder();
    await rec.instrument(fake(10, 0.71, 1))(spec("architect"), opts);
    await rec.instrument(fake(1, 0, 0, true))(spec("engineer"), opts).catch(() => {});
    const table = rec.format();
    expect(table).toContain("architect#1");
    expect(table).toContain("engineer#1 (failed)");
    // A failed call has no turn count from the SDK, so it adds 0 turns and $0.
    expect(table).toMatch(/total\s+10\s+0\.71\s+1/);
  });

  it("writes metrics.json including notes, creating the folder", async () => {
    const rec = new Recorder();
    await rec.instrument(fake(5, 0.25))(spec("architect"), opts);
    rec.notes["build"] = { status: "passed", attempts: 1 };
    const file = path.join(tmp, "nested", "run", "metrics.json");
    rec.write(file);

    const json = JSON.parse(readFileSync(file, "utf8"));
    expect(json.calls).toHaveLength(1);
    expect(json.totals.turns).toBe(5);
    expect(json.notes.build).toEqual({ status: "passed", attempts: 1 });
  });
});
