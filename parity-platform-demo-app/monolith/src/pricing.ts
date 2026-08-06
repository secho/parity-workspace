import { currentContext } from './capture/index.js';

/**
 * The other path.
 *
 * `sp_CalculateOrderTotal` has been extracted into `pricing-service`, and this is how the
 * monolith reaches it. Both paths stay runnable: the flag is read per request and the default
 * is the procedure, so nothing changes for anyone who does not ask for the new one.
 *
 * Per request, not per deploy, and defaulting off — that is what makes it a migration rather
 * than a switch. The old path stays the one that runs until somebody chooses otherwise, and
 * choosing is reversible in the time it takes to drop a header.
 *
 * Note what is deliberately NOT here: capture. `procs.ts` wraps every stored-procedure call so
 * that `parity_capture.Invocation` has no holes, and a call that never reached a procedure is
 * not a procedure invocation. Recording it as one would put rows into the capture describing
 * calls the estate never made, and every number downstream is drawn from that table.
 */

export interface PricingResult {
  netSubtotal: number;
  vatRate: number;
  promoCode: string | null;
  promoDiscount: number;
  loyaltyDiscount: number;
  totalNet: number;
  totalVat: number;
  totalWithVat: number;
  stackedWithLoyalty: boolean;
}

const baseUrl = (): string => process.env.PRICING_SERVICE_URL ?? 'http://pricing-service-live:3000';

/** `x-parity-pricing: service` routes one request to the extracted service. Anything else does not. */
export const wantsService = (header: unknown): boolean => header === 'service';

export async function calculateOrderTotalViaService(input: {
  orderNumber: string;
  promoCode?: string | null;
  modifiedBy?: string;
}): Promise<PricingResult> {
  const response = await fetch(`${baseUrl()}/replay/sp_CalculateOrderTotal`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // Carried through so a request's origin survives the hop. The traffic generator sets it
      // and the acceptance gate sets `verify:m6`, which is how those calls stay out of the
      // case selection that shadow runs draw from.
      ...(currentContext().caller === undefined ? {} : { 'x-parity-caller': String(currentContext().caller) }),
    },
    body: JSON.stringify({
      OrderNumber: input.orderNumber,
      PromoCode: input.promoCode ?? null,
      ModifiedBy: input.modifiedBy ?? 'api',
    }),
  });

  const body = (await response.json()) as { summary?: PricingResult; error?: string };
  if (!response.ok) throw new Error(body.error ?? `pricing-service returned ${response.status}`);
  if (body.summary === undefined) throw new Error('pricing-service returned no summary');
  return body.summary;
}
