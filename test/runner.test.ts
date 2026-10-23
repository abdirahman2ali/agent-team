import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { runAgent, type AgentSpec } from "../src/runner.js";

const Out = z.object({ answer: z.string() });
const spec: AgentSpec<z.infer<typeof Out>> = {
  name: "test-agent",
  systemPrompt: "x",
  tools: ["Read", "Grep"],
  schema: Out,
  maxTurns: 3,
  maxBudgetUsd: 0.5,
};

let worktree: string;
beforeAll(() => {
  worktree = mkdtempSync(path.join(tmpdir(), "runner-"));
});
afterAll(() => rmSync(worktree, { recursive: true, force: true }));

function fakeQuery(messages: unknown[], capture?: (o: Options | undefined) => void) {
  return (params: { prompt: string; options?: Options }) => {
    capture?.(params.options);
    return (async function* () {
      for (const m of messages) yield m;
    })();
  };
}

describe("runAgent", () => {
  it("returns validated structured output with cost and turns", async () => {
    const result = await runAgent(spec, {
      worktree,
      prompt: "p",
      queryFn: fakeQuery([
        { type: "assistant" },
        { type: "result", subtype: "success", structured_output: { answer: "ok" }, total_cost_usd: 0.12, num_turns: 4 },
      ]),
    });
    expect(result).toEqual({ output: { answer: "ok" }, costUsd: 0.12, turns: 4 });
  });

  it("rejects output that fails the schema", async () => {
    await expect(
      runAgent(spec, {
        worktree,
        prompt: "p",
        queryFn: fakeQuery([{ type: "result", subtype: "success", structured_output: { wrong: 1 } }]),
      }),
    ).rejects.toThrow();
  });

  it("throws on error results such as budget or turn limits", async () => {
    await expect(
      runAgent(spec, { worktree, prompt: "p", queryFn: fakeQuery([{ type: "result", subtype: "error_max_budget_usd" }]) }),
    ).rejects.toThrow(/error_max_budget_usd/);
  });

  it("surfaces is_error results (such as not logged in) instead of hiding them", async () => {
    await expect(
      runAgent(spec, {
        worktree,
        prompt: "p",
        queryFn: fakeQuery([{ type: "result", subtype: "success", is_error: true, result: "Not logged in" }]),
      }),
    ).rejects.toThrow(/Not logged in/);
  });

  it("throws when there is no result at all", async () => {
    await expect(runAgent(spec, { worktree, prompt: "p", queryFn: fakeQuery([]) })).rejects.toThrow(/without a result/);
  });

  it("locks the session down: cwd, tools, no settings, caps, minimal env", async () => {
    let seen: Options | undefined;
    await runAgent(spec, {
      worktree,
      prompt: "p",
      queryFn: fakeQuery(
        [{ type: "result", subtype: "success", structured_output: { answer: "ok" } }],
        (o) => (seen = o),
      ),
    });
    expect(seen?.cwd).toBe(worktree);
    expect(seen?.tools).toEqual(["Read", "Grep"]);
    expect(seen?.settingSources).toEqual([]);
    expect(seen?.maxTurns).toBe(3);
    expect(seen?.maxBudgetUsd).toBe(0.5);
    expect(seen?.outputFormat?.schema).not.toHaveProperty("$schema");
    expect(seen?.outputFormat?.schema).toHaveProperty("properties.answer");
    expect(Object.keys(seen?.env ?? {}).every((k) => ["PATH", "HOME", "USER", "LOGNAME"].includes(k))).toBe(true);
  });

  it("wires the guard into both the PreToolUse hook and canUseTool", async () => {
    let seen: Options | undefined;
    const blocked: string[] = [];
    await runAgent(spec, {
      worktree,
      prompt: "p",
      onBlocked: (tool, reason) => blocked.push(`${tool}: ${reason}`),
      queryFn: fakeQuery(
        [{ type: "result", subtype: "success", structured_output: { answer: "ok" } }],
        (o) => (seen = o),
      ),
    });

    const hook = seen?.hooks?.PreToolUse?.[0]?.hooks[0];
    const signal = new AbortController().signal;
    const base = { session_id: "s", transcript_path: "t", cwd: worktree, hook_event_name: "PreToolUse", tool_use_id: "1" };

    const denied = await hook?.({ ...base, tool_name: "Read", tool_input: { file_path: "/etc/hosts" } } as never, "1", { signal });
    expect(JSON.stringify(denied)).toContain('"permissionDecision":"deny"');

    const allowed = await hook?.({ ...base, tool_name: "Read", tool_input: { file_path: "a.ts" } } as never, "1", { signal });
    expect(allowed).toEqual({});

    const notEnabled = await seen?.canUseTool?.("Bash", { command: "ls" }, { signal } as never);
    expect(notEnabled?.behavior).toBe("deny");

    expect(blocked.length).toBe(2);
  });
});
