import { useEffect, useRef } from 'react';

/**
 * Re-run a loader on an interval, and immediately when the tab comes back to the front.
 *
 * Every screen in Parity reads state that something else writes — a campaign running in the
 * background, a beat fired from `/rezie`, a decision taken in another window. Without this they
 * were all snapshots taken at mount, and the only way to see the estate move was F5. On a stage
 * that reads as a broken app rather than as a page that has not been told.
 *
 * Deliberately dumb: no websockets, no cache invalidation, no dependency on which screen started
 * the work. Every one of these queries is a handful of indexed reads against a Postgres on
 * localhost, and one every couple of seconds is not a load — it is cheaper than the SSE topic it
 * would take to do this properly, and it cannot get out of sync with what actually happened,
 * because it re-asks rather than being told.
 *
 * Two things it does not do. It does not poll a hidden tab — `document.hidden` is checked on every
 * tick, so a laptop with the demo open on a second desktop is not making requests all afternoon.
 * And it does not overlap: the loader is awaited before the next tick is honoured, so a slow
 * response cannot pile up behind itself.
 */
export function usePoll(load: () => Promise<unknown> | void, intervalMs = 2000, deps: unknown[] = []): void {
  const inFlight = useRef(false);
  const loader = useRef(load);
  loader.current = load;

  useEffect(() => {
    let cancelled = false;

    const tick = async (): Promise<void> => {
      if (cancelled || inFlight.current || document.hidden) return;
      inFlight.current = true;
      try {
        await loader.current();
      } finally {
        inFlight.current = false;
      }
    };

    const timer = window.setInterval(() => void tick(), intervalMs);
    // Coming back to the tab should feel instant rather than "up to two seconds stale".
    const onVisible = (): void => {
      if (!document.hidden) void tick();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, ...deps]);
}
