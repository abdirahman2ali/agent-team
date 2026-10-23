import { execFileSync } from "node:child_process";

export type AuthMode = "subscription" | "api-key";

type Env = Record<string, string | undefined>;

/** Subscription (the Claude Code login) is the default. API-key billing must be asked for. */
export function authMode(source: Env = process.env): AuthMode {
  return source["AGENT_TEAM_AUTH"] === "api-key" ? "api-key" : "subscription";
}

/**
 * Environment handed to the agent subprocess. USER and LOGNAME are needed for the
 * macOS keychain lookup of the login. The API key is forwarded only in api-key mode,
 * so a key in the shared .env can never silently override the subscription.
 */
export function agentEnv(source: Env = process.env, mode: AuthMode = authMode(source)): Record<string, string> {
  const keys = ["PATH", "HOME", "USER", "LOGNAME", ...(mode === "api-key" ? ["ANTHROPIC_API_KEY"] : [])];
  const env: Record<string, string> = {};
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export interface AuthCheck {
  ok: boolean;
  detail: string;
}

type StatusFn = (env: Record<string, string>) => string;

const cliStatus: StatusFn = (env) =>
  execFileSync("claude", ["auth", "status"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15000 });

/** Verify auth with the same clean environment the agents will get. Never prints credentials. */
export function checkAuth(source: Env = process.env, runStatus: StatusFn = cliStatus): AuthCheck {
  const mode = authMode(source);
  if (mode === "api-key") {
    return source["ANTHROPIC_API_KEY"]
      ? { ok: true, detail: "api-key mode (billed to the API)" }
      : { ok: false, detail: "AGENT_TEAM_AUTH=api-key but ANTHROPIC_API_KEY is not set" };
  }
  try {
    const status = JSON.parse(runStatus(agentEnv(source, mode))) as { loggedIn?: boolean; authMethod?: string; subscriptionType?: string };
    if (status.loggedIn && status.authMethod === "claude.ai") {
      return { ok: true, detail: `subscription (${status.subscriptionType ?? "unknown plan"})` };
    }
    return { ok: false, detail: "Not logged in with a claude.ai subscription. Run `claude auth login` in a terminal." };
  } catch {
    return { ok: false, detail: "Could not read `claude auth status`. Is the claude CLI installed and on PATH?" };
  }
}
