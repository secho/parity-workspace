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
    user: string;
    password: string;
  };
  /** Real files the SDK loads and the UI lists. Same directory, no copy in between. */
  skillsDir: string;
  /** Run workspaces. Outside the application directory on purpose — see agent/workspace.ts. */
  agentWorkspace: string;
  /** live | replay. Replay is M7; the flag is read here so the UI can say which it is. */
  mode: string;
}

/**
 * Whether an agent run can be attempted at all, and if not, why. Reported rather than
 * discovered halfway through a fourteen-procedure sweep.
 *
 * `reason` is for logs and is English like the rest of the code; `reasonCode` is what the
 * UI renders, so the Czech copy stays in the frontend's copy.ts with everything else.
 */
export type AgentBlockedReason = 'missing_key' | 'placeholder_key';

export function agentReadiness(): { ready: boolean; reason: string | null; reasonCode: AgentBlockedReason | null } {
  const key = process.env.ANTHROPIC_API_KEY ?? '';
  if (key === '') return { ready: false, reason: 'ANTHROPIC_API_KEY is not set', reasonCode: 'missing_key' };
  // `sk-ant-` on its own is the placeholder from .env.example.
  if (key.length < 20) {
    return { ready: false, reason: 'ANTHROPIC_API_KEY looks like the .env.example placeholder', reasonCode: 'placeholder_key' };
  }
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
    },
    skillsDir: process.env.PARITY_SKILLS_DIR ?? '/app/skills',
    agentWorkspace: process.env.PARITY_AGENT_WORKSPACE ?? '/tmp/parity-agent',
    mode: process.env.PARITY_MODE ?? 'live',
  };
}
