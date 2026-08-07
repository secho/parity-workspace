/**
 * The only place this process reads its environment. Everything else takes config
 * as an argument, which is what makes the ingest testable against a second database.
 */

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') throw new Error(`missing required env var ${name}`);
  return value;
}

export interface Config {
  port: number;
  pgUrl: string;
  mssql: {
    server: string;
    port: number;
    database: string;
    /** db_datareader + VIEW DEFINITION. Everything that analyses the estate uses this. */
    user: string;
    password: string;
    /**
     * The only principal allowed to EXECUTE, used solely by the oracle harness and always
     * inside a transaction that is rolled back. Kept separate from the pair above so that
     * "Parity cannot write to the estate it analyses" stays a true statement about the
     * credential the analysis runs under, rather than one about how carefully it is used.
     */
    runnerUser: string;
    runnerPassword: string;
    /**
     * The restored copy M5 replays against. `SPEC.md` §4 requires the replacement to run
     * somewhere the production-equivalent database is never touched, and a separate database
     * makes that trivially true rather than argued: the shadow connection never opens
     * against the estate at all.
     */
    shadowDatabase: string;
    /**
     * Owner of the shadow database, and the only principal that can restore it. It has no
     * user in ParityShop — the engine refuses it the estate outright. Deliberately not the
     * runner: resetting a database is a different act from executing a procedure, the same
     * reasoning that split the runner off the reader at M4.
     */
    shadowOwnerUser: string;
    shadowOwnerPassword: string;
    /** The backup every revert restores. Written by `make shadow-db`. */
    shadowBaseBackup: string;
  };
  /**
   * The two replacements the shadow harness can replay against.
   *
   * Both are permanent and they are not interchangeable. `reference` is M5's hand-written
   * service — the only implementation that diverges, and therefore the positive control that
   * proves the diff engine can still find a real behavioural difference. `generated` is what
   * `implement-service` wrote, and it is the one that has to go green.
   *
   * A third instance, `pricing-service-live`, is the monolith's flagged target and is not a
   * replay target at all: it prices against the estate, so it is deliberately absent here.
   */
  pricingServiceUrl: string;
  generatedServiceUrl: string;
  /**
   * Where `open_pr` opens. One repository — `docs/DECISIONS.md` rules out a remote per app,
   * so the PR lands on this workspace repo at the `parity-platform-demo-app/` path.
   */
  github: {
    token: string;
    owner: string;
    repo: string;
    baseBranch: string;
  };
  /** Real files the SDK loads and the UI lists. Same directory, no copy in between. */
  skillsDir: string;
  /** Run workspaces. Outside the application directory on purpose — see agent/workspace.ts. */
  agentWorkspace: string;
  /** live | replay. Replay is M7; the flag is read here so the UI can say which it is. */
  mode: string;
  /**
   * Where `PARITY_MODE=replay` reads its recordings from.
   *
   * A SECOND database, and that is the whole design. The recordings ARE the analysis —
   * `resetState()` truncates `agent_runs` and `agent_steps` with everything else — so a replay
   * that read from `pgUrl` could only ever re-show what was already on screen. Beat 1 wants an
   * empty estate and beats 2-4 want replay; those are compatible only if the recordings are
   * somewhere `make demo-reset` cannot reach. Built by `make load-replay-source`, never written to.
   */
  replayPgUrl: string;
}

/**
 * Where model calls are routed.
 *
 * `anthropic_aws` is Claude Platform on AWS: Anthropic-operated, same-day API parity,
 * AWS IAM and AWS Marketplace billing. It is NOT Amazon Bedrock — Bedrock is
 * partner-operated with prefixed model IDs and a feature subset. The Agent SDK supports
 * it natively via CLAUDE_CODE_USE_ANTHROPIC_AWS, and the model IDs are unchanged, so
 * nothing in the skill registry moves.
 */
export type LlmRoute = 'anthropic_api' | 'anthropic_aws' | 'gateway';

export function llmRoute(): LlmRoute {
  if ((process.env.CLAUDE_CODE_USE_ANTHROPIC_AWS ?? '') !== '') return 'anthropic_aws';
  if ((process.env.ANTHROPIC_BASE_URL ?? '') !== '') return 'gateway';
  return 'anthropic_api';
}

/**
 * Whether an agent run can be attempted at all, and if not, why. Reported rather than
 * discovered halfway through a fourteen-procedure sweep.
 *
 * `reason` is for logs and is English like the rest of the code; `reasonCode` is what the
 * UI renders, so the Czech copy stays in the frontend's copy.ts with everything else.
 */
export type AgentBlockedReason = 'missing_key' | 'placeholder_key' | 'missing_workspace' | 'missing_region';

export function agentReadiness(): { ready: boolean; reason: string | null; reasonCode: AgentBlockedReason | null } {
  if (llmRoute() === 'anthropic_aws') {
    // Both are required and neither has a fallback — the SDK fails at request time,
    // fourteen procedures into a sweep, which is the wrong place to find out.
    if ((process.env.ANTHROPIC_AWS_API_KEY ?? '') === '') {
      return { ready: false, reason: 'ANTHROPIC_AWS_API_KEY is not set', reasonCode: 'missing_key' };
    }
    if ((process.env.ANTHROPIC_AWS_WORKSPACE_ID ?? '') === '') {
      return { ready: false, reason: 'ANTHROPIC_AWS_WORKSPACE_ID is not set', reasonCode: 'missing_workspace' };
    }
    if ((process.env.AWS_REGION ?? '') === '') {
      return { ready: false, reason: 'AWS_REGION is not set', reasonCode: 'missing_region' };
    }
    return { ready: true, reason: null, reasonCode: null };
  }

  const key = process.env.ANTHROPIC_API_KEY ?? '';
  if (key === '') return { ready: false, reason: 'ANTHROPIC_API_KEY is not set', reasonCode: 'missing_key' };
  // `sk-ant-` on its own is the placeholder from .env.example.
  if (key.length < 20) {
    return { ready: false, reason: 'ANTHROPIC_API_KEY looks like the .env.example placeholder', reasonCode: 'placeholder_key' };
  }
  return { ready: true, reason: null, reasonCode: null };
}

export type PrBlockedReason = 'missing_token' | 'missing_owner' | 'missing_repo';

/**
 * Whether a PR can actually be opened, and if not, why — same shape and same reason as
 * `agentReadiness()`.
 *
 * A PR that cannot be opened is a normal state, not an error: assembling one and opening it
 * are separate acts, the gate only ever assembles, and the token is sourced from `gh` by
 * `make github-token` rather than committed. What must never happen is a URL on screen that
 * nothing opened — hard rule 4, absent beats simulated — so the reason code goes to the UI
 * and the UI renders absence.
 */
export function prReadiness(config: Config): { ready: boolean; reason: string | null; reasonCode: PrBlockedReason | null } {
  if (config.github.token === '') {
    return { ready: false, reason: 'GITHUB_TOKEN is not set — run `make github-token`', reasonCode: 'missing_token' };
  }
  if (config.github.owner === '') return { ready: false, reason: 'GITHUB_OWNER is not set', reasonCode: 'missing_owner' };
  if (config.github.repo === '') return { ready: false, reason: 'GITHUB_REPO is not set', reasonCode: 'missing_repo' };
  return { ready: true, reason: null, reasonCode: null };
}

export function loadConfig(): Config {
  return {
    port: Number(process.env.PORT ?? 3000),
    pgUrl: required('PARITY_PG_URL', 'postgres://parity:parity@localhost:5433/parity'),
    mssql: {
      // Parity reaches ParityShop over the database connection and nothing else.
      // It never imports the demo app's code — that separation is the whole argument.
      server: required('MSSQL_HOST', 'localhost'),
      port: Number(process.env.MSSQL_PORT ?? 1433),
      database: required('MSSQL_DATABASE', 'ParityShop'),
      user: required('MSSQL_USER', 'sa'),
      password: required('MSSQL_SA_PASSWORD'),
      runnerUser: required('PARITY_RUNNER_USER', 'parity_runner'),
      runnerPassword: required('PARITY_RUNNER_PASSWORD', 'Parity_Runner_2026!'),
      shadowDatabase: required('MSSQL_SHADOW_DATABASE', 'ParityShop_Shadow'),
      shadowOwnerUser: required('PARITY_SHADOW_USER', 'parity_shadow'),
      shadowOwnerPassword: required('PARITY_SHADOW_PASSWORD', 'Parity_Shadow_2026!'),
      shadowBaseBackup: required('MSSQL_SHADOW_BASE_BACKUP', '/var/opt/mssql/backup/ParityShop_Shadow_base.bak'),
    },
    pricingServiceUrl: required('PRICING_SERVICE_URL', 'http://pricing-service:3000'),
    generatedServiceUrl: required('GENERATED_SERVICE_URL', 'http://pricing-service-generated:3000'),
    github: {
      // No fallback and no throw. An absent token is a normal state — the demo runs without
      // one right up to the moment someone clicks the button — so it is reported by
      // prReadiness() rather than discovered as a crash halfway through assembling a PR.
      token: process.env.GITHUB_TOKEN ?? '',
      owner: process.env.GITHUB_OWNER ?? 'secho',
      repo: process.env.GITHUB_REPO ?? 'parity-workspace',
      baseBranch: process.env.GITHUB_BASE_BRANCH ?? 'main',
    },
    skillsDir: process.env.PARITY_SKILLS_DIR ?? '/app/skills',
    agentWorkspace: process.env.PARITY_AGENT_WORKSPACE ?? '/tmp/parity-agent',
    mode: process.env.PARITY_MODE ?? 'live',
    replayPgUrl: process.env.PARITY_REPLAY_PG_URL ?? 'postgres://parity:parity@localhost:5433/parity_replay',
  };
}
