import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectChecks, formatFailures, runChecks } from "../src/checks.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "checks-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const pkg = (scripts: Record<string, string>) => writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts }));

describe("detectChecks", () => {
  it("finds nothing in a static site", () => {
    writeFileSync(path.join(dir, "index.html"), "<html></html>");
    expect(detectChecks(dir)).toEqual([]);
  });

  it("finds npm test, typecheck and lint", () => {
    pkg({ test: "vitest run", typecheck: "tsc --noEmit", lint: "eslint .", build: "tsc" });
    expect(detectChecks(dir).map((c) => c.name)).toEqual(["npm test", "npm run typecheck", "npm run lint"]);
  });

  it("ignores the npm init placeholder test script", () => {
    pkg({ test: 'echo "Error: no test specified" && exit 1' });
    expect(detectChecks(dir)).toEqual([]);
  });

  it("tolerates a broken package.json", () => {
    writeFileSync(path.join(dir, "package.json"), "{ not json");
    expect(detectChecks(dir)).toEqual([]);
  });

  it("finds pytest and ruff", () => {
    mkdirSync(path.join(dir, "tests"));
    writeFileSync(path.join(dir, "pyproject.toml"), "[tool.ruff]\nline-length = 100\n");
    expect(detectChecks(dir).map((c) => c.name)).toEqual(["pytest", "ruff check"]);
  });
});

describe("runChecks", () => {
  it("reports pass and fail with output", () => {
    const results = runChecks(dir, [
      { name: "ok", command: "node", args: ["-e", "console.log('fine')"] },
      { name: "bad", command: "node", args: ["-e", "console.error('boom'); process.exit(2)"] },
    ]);
    expect(results[0]).toMatchObject({ name: "ok", ok: true });
    expect(results[0]?.output).toContain("fine");
    expect(results[1]).toMatchObject({ name: "bad", ok: false });
    expect(results[1]?.output).toContain("boom");
  });

  it("treats a missing command as a failure instead of throwing", () => {
    const [result] = runChecks(dir, [{ name: "ghost", command: "definitely-not-a-command-xyz", args: [] }]);
    expect(result?.ok).toBe(false);
  });

  it("truncates very long output to the tail", () => {
    const [result] = runChecks(dir, [
      { name: "loud", command: "node", args: ["-e", "console.log('x'.repeat(20000)); console.log('END'); process.exit(1)"] },
    ]);
    expect(result?.output.length).toBeLessThan(3100);
    expect(result?.output).toContain("END");
  });

  it("does not leak the parent environment to checks", () => {
    process.env["AGENT_TEAM_TEST_SECRET"] = "leak";
    const [result] = runChecks(dir, [
      { name: "env", command: "node", args: ["-e", "console.log(process.env.AGENT_TEAM_TEST_SECRET ?? 'absent')"] },
    ]);
    delete process.env["AGENT_TEAM_TEST_SECRET"];
    expect(result?.output).toBe("absent");
  });
});

describe("formatFailures", () => {
  it("lists only failed checks", () => {
    const text = formatFailures([
      { name: "a", ok: true, output: "fine" },
      { name: "b", ok: false, output: "broke" },
    ]);
    expect(text).toContain("b FAILED");
    expect(text).toContain("broke");
    expect(text).not.toContain("fine");
  });
});
