export interface Blocker {
  key: string;
  label: string;
}

export interface EstateProcedure {
  name: string;
  schemaName: string;
  lineCount: number;
  invocations90d: number;
  lastInvokedAt: string | null;
  oracleClass: string | null;
  oracleState: string;
  campaignStatus: string;
  domain: string | null;
  riskClass: string | null;
  ownerTeam: string | null;
  usesDynamicSql: boolean;
  blocker: Blocker | null;
}

export interface Bucket {
  key?: string;
  status?: string;
  label: string;
  procedures: number;
  invocations90d: number;
}

export interface EstateResponse {
  totals: {
    procedures: number;
    liveProcedures: number;
    deadProcedures: number;
    invocations90d: number;
    coverage: number;
    coverageByCount: number;
  };
  statusBar: Bucket[];
  blockers: Bucket[];
  procedures: EstateProcedure[];
}

export interface ColumnAccess {
  tableName: string;
  columnName: string;
  access: 'read' | 'write';
  isWriteOwner: boolean;
  inferred: boolean;
}

export interface ProcedureResponse {
  procedure: EstateProcedure & { sourceSql: string; seamRequirements: string | null };
  reads: ColumnAccess[];
  writes: ColumnAccess[];
  coupling: { tableName: string; columnName: string; other: string; writers: number }[];
  calls: string[];
  calledBy: string[];
}

export interface Runtime {
  provider: string;
  baseUrl: string | null;
  mode: string;
  agentReady: boolean;
  agentBlockedReason: string | null;
  lastModelUsed: string | null;
  lastRunAt: string | null;
}

export interface SkillInfo {
  name: string;
  description: string;
  model: string;
  availableFrom: string;
}

export interface PolicyRuleInfo {
  id: number;
  taskClass: string;
  toolName: string;
  tier: number;
  requiresHuman: boolean;
  note: string | null;
}

export interface AuditEntryInfo {
  id: number;
  seq: number;
  toolName: string;
  inputSummary: string | null;
  resultSummary: string | null;
  durationMs: number | null;
  outcome: string;
  reason: string | null;
  createdAt: string;
  runId: string;
  skill: string;
  taskClass: string;
}

export interface AgentStepInfo {
  seq: number;
  kind: string;
  toolName: string | null;
  text: string | null;
}

export interface AgentRunInfo {
  runId: string;
  skill: string;
  taskClass: string;
  status: string;
  model: string | null;
  numTurns: number | null;
  costUsd: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number | null;
  startedAt: string;
  output: string | null;
  error: string | null;
  steps: AgentStepInfo[];
}

export interface GoldenTestInfo {
  id: number;
  name: string;
  branchKey: string | null;
  sourceInvocationId: number;
  inputParams: unknown;
  normalisations: string[];
  rationale: string | null;
  /** pass | fail | error, or null if the suite has not been run since this case was added. */
  status: string | null;
  detail: string | null;
}

export interface InvariantInfo {
  id: number;
  name: string;
  kind: string;
  evaluable: boolean;
  rationale: string | null;
  casesChecked: number;
  casesViolated: number;
  firstViolation: string | null;
  /** Derived: a rule broken by most of what it checked is not describing this procedure. */
  confirmed: boolean;
}

export interface OracleResponse {
  latestRun: {
    id: number;
    kind: string;
    goldenPassed: number;
    goldenFailed: number;
    invariantsChecked: number;
    invariantsViolated: number;
    durationMs: number | null;
    startedAt: string;
  } | null;
  goldenTests: GoldenTestInfo[];
  invariants: InvariantInfo[];
}

async function get<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return (await response.json()) as T;
}

export const fetchEstate = (): Promise<EstateResponse> => get<EstateResponse>('/api/estate');
export const fetchProcedure = (name: string): Promise<ProcedureResponse> =>
  get<ProcedureResponse>(`/api/procedures/${encodeURIComponent(name)}`);
export const fetchSpec = (name: string): Promise<{ spec: { markdown: string; createdAt: string } | null }> =>
  get(`/api/procedures/${encodeURIComponent(name)}/spec`);
export const fetchOracle = (name: string): Promise<OracleResponse> =>
  get<OracleResponse>(`/api/procedures/${encodeURIComponent(name)}/oracle`);
export const fetchRuns = (name: string): Promise<{ runs: AgentRunInfo[] }> =>
  get(`/api/procedures/${encodeURIComponent(name)}/runs`);
export const fetchRuntime = (): Promise<Runtime> => get<Runtime>('/api/runtime');
export const fetchSkills = (): Promise<{ skillsDir: string; skills: SkillInfo[] }> => get('/api/skills');
export const fetchPolicy = (): Promise<{ rules: PolicyRuleInfo[] }> => get('/api/policy');
export const fetchAudit = (): Promise<{ entries: AuditEntryInfo[] }> => get('/api/audit');
