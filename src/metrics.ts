import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AgentResult, AgentSpec, RunAgentOptions } from "./runner.js";

export interface AgentCall {
  agent: string;
  call: number;
  ok: boolean;
  turns: number;
  /** SDK-reported estimate at API prices. Not billed on a subscription. */
  estCostUsd: number;
  blocked: number;
  durationMs: number;
  error?: string;
}

type RunAgentFn = <T>(spec: AgentSpec<T>, opts: RunAgentOptions) => Promise<AgentResult<T>>;

/** Records every agent call: turns, estimated cost, blocked tool calls, duration. */
export class Recorder {
  readonly calls: AgentCall[] = [];
  readonly notes: Record<string, unknown> = {};
  private counts = new Map<string, number>();

  instrument(run: RunAgentFn): RunAgentFn {
    return async <T>(spec: AgentSpec<T>, opts: RunAgentOptions): Promise<AgentResult<T>> => {
      const call = (this.counts.get(spec.name) ?? 0) + 1;
      this.counts.set(spec.name, call);
      let blocked = 0;
      const start = Date.now();
      const onBlocked = (tool: string, reason: string) => {
        blocked++;
        opts.onBlocked?.(tool, reason);
      };
      try {
        const result = await run(spec, { ...opts, onBlocked });
        this.calls.push({
          agent: spec.name, call, ok: true, turns: result.turns, estCostUsd: result.costUsd,
          blocked, durationMs: Date.now() - start,
        });
        return result;
      } catch (err) {
        this.calls.push({
          agent: spec.name, call, ok: false, turns: 0, estCostUsd: 0, blocked, durationMs: Date.now() - start,
          error: err instanceof Error ? err.message.slice(0, 200) : String(err),
        });
        throw err;
      }
    };
  }

  totals() {
    return {
      calls: this.calls.length,
      turns: this.calls.reduce((n, c) => n + c.turns, 0),
      estCostUsd: this.calls.reduce((n, c) => n + c.estCostUsd, 0),
      blocked: this.calls.reduce((n, c) => n + c.blocked, 0),
      durationMs: this.calls.reduce((n, c) => n + c.durationMs, 0),
    };
  }

  write(file: string): void {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ calls: this.calls, totals: this.totals(), notes: this.notes }, null, 2));
  }

  /** Plain-text table for the end of a run. */
  format(): string {
    const rows = this.calls.map((c) => [
      `${c.agent}#${c.call}${c.ok ? "" : " (failed)"}`,
      String(c.turns),
      c.estCostUsd.toFixed(2),
      String(c.blocked),
      `${Math.round(c.durationMs / 1000)}s`,
    ]);
    const t = this.totals();
    rows.push(["total", String(t.turns), t.estCostUsd.toFixed(2), String(t.blocked), `${Math.round(t.durationMs / 1000)}s`]);
    const header = ["agent", "turns", "est $", "blocked", "time"];
    const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
    const line = (r: string[]) => r.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join("  ").trimEnd();
    return [line(header), ...rows.map(line)].join("\n");
  }
}
