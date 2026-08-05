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

async function get<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return (await response.json()) as T;
}

export const fetchEstate = (): Promise<EstateResponse> => get<EstateResponse>('/api/estate');
export const fetchProcedure = (name: string): Promise<ProcedureResponse> =>
  get<ProcedureResponse>(`/api/procedures/${encodeURIComponent(name)}`);
