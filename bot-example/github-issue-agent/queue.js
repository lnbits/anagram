// A serial job queue with a bounded waiting list. The bot uses one for Ollama and one for
// GitHub, so a slow model never delays publication and only one request of each kind runs.
export class Queue {
  constructor(limit, onError = () => {}) {
    this.limit = limit;
    this.onError = onError;
    this.jobs = [];
    this.current = null;
    this.stopped = false;
  }
  get full() {
    return this.jobs.length >= this.limit;
  }
  // Returns false when the waiting list is full or the queue is stopped.
  push(job) {
    if (this.stopped || this.full) return false;
    this.jobs.push(job);
    this.pump();
    return true;
  }
  pump() {
    if (this.current || this.stopped) return;
    const job = this.jobs.shift();
    if (!job) return;
    this.current = Promise.resolve()
      .then(job)
      .catch(this.onError)
      .finally(() => {
        this.current = null;
        this.pump();
      });
  }
  // Waits for the queue to become empty (used by tests).
  async idle() {
    while (this.current || this.jobs.length) await (this.current ?? Promise.resolve());
  }
  // Drops waiting jobs and waits for the running one to finish.
  async stop() {
    this.stopped = true;
    this.jobs = [];
    await this.current;
  }
}
