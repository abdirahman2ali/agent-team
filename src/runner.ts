import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { agentEnv } from "./auth.js";
import { decide } from "./guard.js";

export interface AgentSpec<T> {
  name: string;
  systemPrompt: string;
  tools: readonly string[];
  schema: z.ZodType<T>;
  maxTurns: number;
  maxBudgetUsd: number;
}

export interface AgentResult<T> {
  output: T;
  costUsd: number;
  turns: number;
}

type QueryFn = (params: { prompt: string; options?: Options }) => AsyncIterable<unknown>;

export interface RunAgentOptions {
  worktree: string;
  prompt: string;
  queryFn?: QueryFn;
  onBlocked?: (tool: string, reason: string) => void;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** The CLI's validator cannot resolve the draft 2020-12 `$schema` URL that zod emits, so drop it. */
export function toOutputSchema(schema: z.ZodType): Record<string, unknown> {
  const jsonSchema: Record<string, unknown> = { ...z.toJSONSchema(schema) };
  delete jsonSchema["$schema"];
  return jsonSchema;
}

interface ResultLike {
  type: "result";
  subtype: string;
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  total_cost_usd?: number;
  num_turns?: number;
}

function isResult(message: unknown): message is ResultLike {
  return asRecord(message)["type"] === "result";
}

export async function runAgent<T>(spec: AgentSpec<T>, opts: RunAgentOptions): Promise<AgentResult<T>> {
  const { worktree, prompt, onBlocked = () => {} } = opts;
  const run = opts.queryFn ?? (query as unknown as QueryFn);

  const check = (tool: string, input: Record<string, unknown>) => {
    const verdict = decide(worktree, tool, input, spec.tools);
    if (!verdict.allow) onBlocked(tool, verdict.reason);
    return verdict;
  };

  const options: Options = {
    cwd: worktree,
    systemPrompt: spec.systemPrompt,
    tools: [...spec.tools],
    settingSources: [],
    permissionMode: "default",
    maxTurns: spec.maxTurns,
    maxBudgetUsd: spec.maxBudgetUsd,
    env: agentEnv(),
    outputFormat: { type: "json_schema", schema: toOutputSchema(spec.schema) },
    // Primary guard: PreToolUse fires for every tool call, including ones the CLI would auto-approve.
    hooks: {
      PreToolUse: [
        {
          hooks: [
            async (input) => {
              if (input.hook_event_name !== "PreToolUse") return {};
              const verdict = check(input.tool_name, asRecord(input.tool_input));
              if (verdict.allow) return {};
              return {
                hookSpecificOutput: {
                  hookEventName: "PreToolUse",
                  permissionDecision: "deny",
                  permissionDecisionReason: verdict.reason,
                },
              };
            },
          ],
        },
      ],
    },
    // Backstop: anything that still reaches a permission prompt goes through the same check.
    canUseTool: async (tool, input) => {
      const verdict = check(tool, input);
      return verdict.allow
        ? { behavior: "allow", updatedInput: input }
        : { behavior: "deny", message: verdict.reason };
    },
  };

  for await (const message of run({ prompt, options })) {
    if (!isResult(message)) continue;
    if (message.subtype !== "success") throw new Error(`${spec.name} failed: ${message.subtype}`);
    // Auth and API failures arrive as subtype "success" with is_error set.
    if (message.is_error) throw new Error(`${spec.name} failed: ${(message.result ?? "unknown error").slice(0, 300)}`);
    if (message.structured_output === undefined) throw new Error(`${spec.name} returned no structured output`);
    return {
      output: spec.schema.parse(message.structured_output),
      costUsd: message.total_cost_usd ?? 0,
      turns: message.num_turns ?? 0,
    };
  }
  throw new Error(`${spec.name} ended without a result`);
}
