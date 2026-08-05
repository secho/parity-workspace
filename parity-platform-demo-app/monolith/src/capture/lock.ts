/**
 * A read/write lock over "who is allowed to be writing right now".
 *
 * Change Tracking versions are database-global. A captured call reads the CT version
 * before the procedure runs and again after, and everything in between is attributed to
 * it — so a concurrent write from any other call lands in its write set and corrupts it.
 *
 * Serialising every write would cost too much: writes are a quarter of the traffic.
 * Instead, uncaptured writes run concurrently with each other (shared), and a captured
 * write excludes all of them (exclusive). Captured writes are the small minority, so the
 * common path stays parallel.
 *
 * This is in-process rather than sp_getapplock because the alternative is holding a
 * session-scoped lock across three round-trips on one pinned connection, and
 * sp_PlaceOrder runs its own BEGIN TRAN/ROLLBACK inside — nesting our transaction under
 * that invites a rollback we did not ask for. The monolith is a single process and the
 * only writer during a traffic run, so an in-process lock is sufficient. If a second
 * writer ever appears, captured write sets become unreliable and this is where to look.
 */
export class WriteLock {
  private sharedCount = 0;
  private exclusive = false;
  private readonly waiters: (() => void)[] = [];

  private async acquire(wantExclusive: boolean): Promise<void> {
    while (wantExclusive ? this.exclusive || this.sharedCount > 0 : this.exclusive) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    if (wantExclusive) this.exclusive = true;
    else this.sharedCount++;
  }

  private release(wasExclusive: boolean): void {
    if (wasExclusive) this.exclusive = false;
    else this.sharedCount--;
    // Wake everyone; each re-checks its own condition. The queue is short by design.
    const waiting = this.waiters.splice(0, this.waiters.length);
    for (const wake of waiting) wake();
  }

  async run<T>(mode: 'shared' | 'exclusive', fn: () => Promise<T>): Promise<T> {
    const wantExclusive = mode === 'exclusive';
    await this.acquire(wantExclusive);
    try {
      return await fn();
    } finally {
      this.release(wantExclusive);
    }
  }
}

export const writeLock = new WriteLock();
