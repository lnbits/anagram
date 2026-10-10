// NIP-01 has no event-ID pagination cursor. Keep the oldest second inclusive;
// expand only a crowded timestamp boundary, never silently skip tied messages.
export class HistoryPager {
  readonly pageSize = 128;
  limit = this.pageSize;
  done = false;
  constructor(
    readonly since: number,
    public until: number,
    readonly exhaustive = false,
  ) {}
  advance(count: number, oldest: number) {
    if (count === 0 || (!this.exhaustive && count < this.limit)) {
      this.done = true;
      return;
    }
    if (!Number.isFinite(oldest) || oldest < this.since || oldest > this.until)
      throw new Error('Invalid history page boundary');
    if (oldest === this.until && count < this.limit) {
      this.until -= 1;
      this.limit = this.pageSize;
      this.done = this.until < this.since;
    } else if (oldest === this.until) {
      if (this.limit >= 4096)
        throw new Error('History timestamp exceeds page capacity; coverage retained for retry');
      this.limit *= 2;
    } else {
      this.until = oldest;
      this.limit = this.pageSize;
    }
  }
}
