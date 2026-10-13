/** What the node is busy with, so an idle shutdown never cuts a request or a download short. */
export class Activity {
  private active = 0;
  private lastAt: number;

  constructor(private readonly now: () => number = Date.now) {
    this.lastAt = now();
  }

  /** A request started; call the returned function when it is over (safe to call twice). */
  begin(): () => void {
    this.active++;
    this.lastAt = this.now();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.active = Math.max(0, this.active - 1);
      this.lastAt = this.now();
    };
  }

  /** Something happened that counts as work (a download made progress). */
  touch(): void {
    this.lastAt = this.now();
  }

  get inFlight(): number {
    return this.active;
  }

  get idleSeconds(): number {
    return Math.floor((this.now() - this.lastAt) / 1000);
  }
}
