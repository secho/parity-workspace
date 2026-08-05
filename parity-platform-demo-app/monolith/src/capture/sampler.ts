/**
 * Sampling policy and branch-coverage proxy.
 *
 * SPEC §3: full capture for the first 200 calls per procedure, then 1-in-50, plus
 * always-capture on any call whose input hits an uncovered branch.
 *
 * One deliberate deviation, recorded in docs/DECISIONS.md: sp_CalculateOrderTotal is the
 * migration target and M5 must replay 2 000+ *captured* calls of it. Under the uniform
 * policy that would need ~90 000 calls of a tail procedure. It therefore captures fully
 * up to a cap instead.
 */

export interface ProcedurePolicy {
  /** Capture every call until this many have been captured. */
  fullUntil: number;
  /** After that, capture one call in every N. */
  thereafterOneIn: number;
}

const DEFAULT_POLICY: ProcedurePolicy = { fullUntil: 200, thereafterOneIn: 50 };

const POLICIES: Record<string, ProcedurePolicy> = {
  // M5 replays 2 000+ of these. The cap leaves headroom above that target.
  sp_CalculateOrderTotal: { fullUntil: 3000, thereafterOneIn: 50 },
};

export const policyFor = (procName: string): ProcedurePolicy => POLICIES[procName] ?? DEFAULT_POLICY;

const seenCalls = new Map<string, number>();
const capturedCalls = new Map<string, number>();
const seenBranches = new Set<string>();

/**
 * Branch coverage proxy.
 *
 * T-SQL branches cannot be instrumented without editing the estate, which is off limits.
 * This is a stable key over the input features that actually select branches in these
 * procedures — country (the VAT branch), promo presence and stacking (the branch holding
 * the planted defect), basket size, backorder, paging and sort mode. First sighting of a
 * key always captures, which is what "always on uncovered branches" reduces to without
 * a T-SQL profiler.
 */
export function branchKey(
  procName: string,
  params: Record<string, unknown>,
  facts?: Map<number, { countryCode: string; loyaltyTier: number }>,
): string {
  const get = (...names: string[]): unknown => {
    for (const n of names) {
      const hit = Object.keys(params).find((k) => k.toLowerCase() === n.toLowerCase());
      if (hit && params[hit] != null) return params[hit];
    }
    return undefined;
  };

  const parts: string[] = [procName];
  const bucket = (n: number): string => (n <= 1 ? '1' : n <= 5 ? '2-5' : n <= 20 ? '6-20' : '21+');

  const lines = get('LinesRaw', 'CartItems');
  if (typeof lines === 'string') {
    parts.push(`lines=${bucket(lines.split(/[|,]/).filter(Boolean).length)}`);
  }

  const promo = get('PromoCode', 'p_Code');
  parts.push(`promo=${promo ? String(promo) : 'none'}`);

  // Country and loyalty tier select the VAT branch and the loyalty-discount branch, but
  // sp_CalculateOrderTotal and sp_GetCartSummary look them up inside themselves rather
  // than taking them as parameters. Resolve them here or those branches never register
  // as uncovered — see capture/facts.ts.
  const explicitCountry = get('ShipCountry', 'BillCountry');
  const customerId = Number(get('CustomerID', 'p_CustomerID', 'iCustomerId') ?? NaN);
  const resolved = Number.isFinite(customerId) ? facts?.get(customerId) : undefined;

  const country = explicitCountry ?? resolved?.countryCode;
  if (country) parts.push(`country=${String(country)}`);
  if (resolved) parts.push(`tier=${resolved.loyaltyTier >= 3 ? 'loyal' : String(resolved.loyaltyTier)}`);

  const sort = get('sortMode');
  if (sort) parts.push(`sort=${String(sort)}`);

  const page = get('pageNumber');
  if (page !== undefined) parts.push(`page=${Number(page) <= 1 ? 'first' : 'deep'}`);

  const inStock = get('inStockOnly');
  if (inStock !== undefined) parts.push(`instock=${String(inStock)}`);

  return parts.join(' ');
}

export interface SampleDecision {
  capture: boolean;
  branchKey: string;
  reason: 'warmup' | 'interval' | 'new-branch' | 'skip';
}

export function decide(
  procName: string,
  params: Record<string, unknown>,
  facts?: Map<number, { countryCode: string; loyaltyTier: number }>,
): SampleDecision {
  const key = branchKey(procName, params, facts);
  const seen = (seenCalls.get(procName) ?? 0) + 1;
  seenCalls.set(procName, seen);

  const captured = capturedCalls.get(procName) ?? 0;
  const policy = policyFor(procName);

  let reason: SampleDecision['reason'] = 'skip';
  if (!seenBranches.has(key)) reason = 'new-branch';
  else if (captured < policy.fullUntil) reason = 'warmup';
  else if (seen % policy.thereafterOneIn === 0) reason = 'interval';

  seenBranches.add(key);
  const capture = reason !== 'skip';
  if (capture) capturedCalls.set(procName, captured + 1);

  return { capture, branchKey: key, reason };
}

export function resetSampler(): void {
  seenCalls.clear();
  capturedCalls.clear();
  seenBranches.clear();
}

export const samplerStats = () => ({
  seen: Object.fromEntries(seenCalls),
  captured: Object.fromEntries(capturedCalls),
  branches: seenBranches.size,
});
