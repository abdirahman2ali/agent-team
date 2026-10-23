import { describe, expect, it } from "vitest";
import { agentEnv, authMode, checkAuth } from "../src/auth.js";

const base = { PATH: "/bin", HOME: "/h", USER: "u", LOGNAME: "u", AWS_SECRET: "nope", ANTHROPIC_API_KEY: "sk-test" };

describe("authMode", () => {
  it("defaults to subscription", () => {
    expect(authMode({})).toBe("subscription");
    expect(authMode({ AGENT_TEAM_AUTH: "anything-else" })).toBe("subscription");
  });

  it("uses the API only when asked", () => {
    expect(authMode({ AGENT_TEAM_AUTH: "api-key" })).toBe("api-key");
  });
});

describe("agentEnv", () => {
  it("never forwards the API key in subscription mode, even when one is set", () => {
    const env = agentEnv(base, "subscription");
    expect(env).toEqual({ PATH: "/bin", HOME: "/h", USER: "u", LOGNAME: "u" });
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
  });

  it("forwards the API key only in api-key mode, and still nothing else", () => {
    const env = agentEnv(base, "api-key");
    expect(env["ANTHROPIC_API_KEY"]).toBe("sk-test");
    expect(env).not.toHaveProperty("AWS_SECRET");
  });
});

describe("checkAuth", () => {
  const loggedIn = () => JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "pro" });

  it("accepts a claude.ai subscription login", () => {
    expect(checkAuth(base, loggedIn)).toEqual({ ok: true, detail: "subscription (pro)" });
  });

  it("runs the status check in the clean environment, not the full one", () => {
    let seen: Record<string, string> = {};
    checkAuth(base, (env) => {
      seen = env;
      return loggedIn();
    });
    expect(seen).not.toHaveProperty("AWS_SECRET");
    expect(seen).not.toHaveProperty("ANTHROPIC_API_KEY");
  });

  it("rejects a logged-out or non-subscription login", () => {
    expect(checkAuth(base, () => JSON.stringify({ loggedIn: false, authMethod: "none" })).ok).toBe(false);
    expect(checkAuth(base, () => JSON.stringify({ loggedIn: true, authMethod: "apiKey" })).ok).toBe(false);
  });

  it("fails cleanly when the CLI is missing or prints junk", () => {
    expect(checkAuth(base, () => { throw new Error("ENOENT"); }).ok).toBe(false);
    expect(checkAuth(base, () => "not json").ok).toBe(false);
  });

  it("api-key mode requires the key", () => {
    expect(checkAuth({ AGENT_TEAM_AUTH: "api-key" }).ok).toBe(false);
    expect(checkAuth({ AGENT_TEAM_AUTH: "api-key", ANTHROPIC_API_KEY: "k" }).ok).toBe(true);
  });
});
