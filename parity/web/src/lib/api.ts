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

export interface ShadowRunInfo {
  id: number;
  status: string;
  implementation: string;
  kind: string;
  shadowDatabase: string;
  casesPlanned: number;
  casesReplayed: number;
  strataCovered: number;
  strataObserved: number;
  rawDiffs: number;
  noiseDiffs: number;
  behaviourDiffs: number;
  replayMs: number | null;
  durationMs: number | null;
  startedAt: string;
}

export interface QueueItem {
  signature: string;
  procedure: string;
  shadowRunId: number;
  scope: string;
  tableName: string | null;
  columnName: string | null;
  cases: number;
  rowsAffected: number;
  explanationCs: string | null;
  ownerTeam: string | null;
  riskClass: string | null;
  sample: {
    sourceInvocationId: number;
    branchKey: string | null;
    inputParams: Record<string, unknown>;
    oldValue: unknown;
    newValue: unknown;
  } | null;
  decision: { action: string; note: string | null; decidedBy: string; decidedAt: string } | null;
}

export interface ShadowResponse {
  runs: ShadowRunInfo[];
  controlRuns: ShadowRunInfo[];
  latestRun: ShadowRunInfo | null;
  breakdown: { verdict: string | null; verdictSource: string | null; noiseReason: string | null; n: number }[];
  findings: QueueItem[];
}

export interface QueueSummary {
  latestRun: ShadowRunInfo | null;
  rawDiffs: number;
  resolvedInCode: number;
  reachedHuman: number;
  decided: number;
}

async function get<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return (await response.json()) as T;
}

/** The first mutation the UI has needed: the three buttons in the decision queue. */
async function send<T>(path: string, method: 'POST' | 'DELETE', body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
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
export const fetchShadow = (name: string): Promise<ShadowResponse> =>
  get<ShadowResponse>(`/api/procedures/${encodeURIComponent(name)}/shadow`);
export interface DecisionRecord {
  id: number;
  signature: string;
  action: string;
  note: string | null;
  decidedBy: string;
  decidedAt: string;
  shadowRunId: number;
  implementation: string;
}

export interface PullRequestRecord {
  id: number;
  status: string;
  owner: string;
  repo: string;
  baseBranch: string;
  branch: string;
  title: string;
  body: string;
  files: { path: string }[];
  artifactHash: string;
  number: number | null;
  url: string | null;
  error: string | null;
  createdAt: string;
  openedAt: string | null;
}

export interface ServiceArtifactSet {
  attempt: number;
  runHash: string;
  files: { path: string; contents: string; sha256: string }[];
}

/**
 * By procedure, not by the latest run.
 *
 * A decision outlives the run that provoked it. Scoping this to the newest run — which the
 * queue does, correctly, because the queue shows work — would empty this list the moment the
 * generated service replays green, which is precisely when someone wants to read it.
 */
export const fetchDecisions = (name: string): Promise<{ decisions: DecisionRecord[] }> =>
  get(`/api/procedures/${encodeURIComponent(name)}/decisions`);

export const fetchService = (
  name: string,
): Promise<{ artifacts: ServiceArtifactSet | null; complete: boolean }> =>
  get(`/api/procedures/${encodeURIComponent(name)}/service`);

export const fetchPullRequest = (
  name: string,
): Promise<{ latest: PullRequestRecord | null; readiness: { ready: boolean; reason: string | null; reasonCode: string | null } }> =>
  get(`/api/procedures/${encodeURIComponent(name)}/pr`);

export interface CampaignDefinitionInfo {
  key: string;
  title: string;
  description: string;
  needsTarget: boolean;
}

export interface CampaignItemInfo {
  key: string;
  label: string;
  procedure: string | null;
  step: string | null;
  status: string;
  detail: string | null;
  costUsd: number | null;
  durationMs: number | null;
}

export interface CampaignRunInfo {
  id: number;
  campaign: string;
  status: string;
  target: string | null;
  items: CampaignItemInfo[];
  total: number;
  done: number;
  skipped: number;
  failed: number;
  costUsd: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export const fetchCampaigns = (): Promise<{
  campaigns: CampaignDefinitionInfo[];
  runs: CampaignRunInfo[];
  agentReady: { ready: boolean };
}> => get('/api/campaigns');

export const fetchCampaignRun = (id: number): Promise<{ run: CampaignRunInfo }> => get(`/api/campaigns/runs/${id}`);

/**
 * Starts and returns — the run continues in the background and the screen polls for it.
 *
 * 409 is a normal answer, not a failure: one campaign at a time, and the second click gets told
 * so. It comes back as a rejected promise like every other non-2xx, and the caller reads the
 * status out of the message.
 */
export const startCampaign = (key: string, target?: string): Promise<{ run: CampaignRunInfo }> =>
  send(`/api/campaigns/${encodeURIComponent(key)}`, 'POST', { target: target ?? null });

export const fetchQueue = (): Promise<{ open: QueueItem[]; decided: QueueItem[] }> => get('/api/queue');
export const fetchQueueSummary = (): Promise<QueueSummary> => get<QueueSummary>('/api/queue/summary');
export const decide = (signature: string, action: string, shadowRunId: number): Promise<unknown> =>
  send(`/api/queue/${encodeURIComponent(signature)}/decision`, 'POST', { action, shadowRunId });
export const undecide = (signature: string): Promise<unknown> =>
  send(`/api/queue/${encodeURIComponent(signature)}/decision`, 'DELETE');
