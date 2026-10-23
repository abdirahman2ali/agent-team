/** Commands shown to agents. A test checks every one passes the guard, so this cannot drift from BASH_ALLOWLIST. */
export const BASH_EXAMPLES: readonly string[] = [
  "git status",
  "git diff",
  "git diff origin/main",
  "git log --oneline -10",
  "git show HEAD",
  "npm test",
  "npm run typecheck",
  "npm run lint",
  "npx --no-install tsc --noEmit",
  "npx --no-install vitest run",
  "pytest -q",
  "python3 -m pytest -q",
  "ruff check .",
  "ruff format --check .",
  "ls src",
];

/** Blocked commands cost a full turn each, so tell the agent up front what Bash accepts. */
export const BASH_RULES = `Bash accepts only these commands, one per call:
${BASH_EXAMPLES.map((c) => `  ${c}`).join("\n")}
Arguments may change (paths, flags), but the command must start the same way.
Every path argument must stay inside the worktree: no absolute paths outside it, no .., no ~.
Not allowed, so do not try: pipes, &&, ;, redirects, $variables, quotes, backslashes, braces, backticks, cat, grep, find, sed, cd, git add/commit/push/checkout/reset, git diff --no-index or --output, ruff --fix, ruff format without --check, pip, npm install, npx without --no-install.
To read files use Read, to search use Grep and Glob.`;
