/**
 * Live terminal status for long-running stages: a spinner, run totals, and one line per
 * worker saying what it is doing right now (loading, scrolling page 3, waiting 8s,
 * BLOCKED 12:30 left…). Normal log lines keep printing above the status block.
 *
 * When stdout is not a terminal (piped to a file, nohup), it prints a one-line heartbeat
 * every minute instead, so the log still shows the run is alive.
 */
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const TICK_MS = 250;
const HEARTBEAT_MS = 60_000;
const TOTALS_REFRESH_MS = 2_000;

interface WorkerState {
  text: string;
  since: number;
  until?: number;
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export class Progress {
  private workers = new Map<number, WorkerState>();
  private frame = 0;
  private drawnLines = 0;
  private timer?: NodeJS.Timeout;
  private totals = '';
  private totalsAt = 0;
  private lastHeartbeat = Date.now();
  private readonly startedAt = Date.now();
  private readonly tty = !!process.stdout.isTTY && !process.env.NO_PROGRESS;
  private readonly orig = { log: console.log, warn: console.warn, error: console.error };

  /** `totals` is called every couple of seconds and should be cheap (a few COUNT queries). */
  constructor(
    private readonly stage: string,
    private readonly totalsFn: (elapsedMs: number) => string,
  ) {}

  /** Sets what worker `w` is doing. `untilMs` shows a countdown instead of elapsed time. */
  set(w: number, text: string, untilMs?: number) {
    const prev = this.workers.get(w);
    const since = prev && prev.text === text ? prev.since : Date.now();
    this.workers.set(w, { text, since, until: untilMs });
  }

  remove(w: number) {
    this.workers.delete(w);
  }

  start() {
    if (this.tty) {
      // Route log output above the status block so the two don't garble each other.
      for (const k of ['log', 'warn', 'error'] as const) {
        console[k] = (...args: unknown[]) => {
          this.clear();
          this.orig[k](...args);
          this.draw();
        };
      }
      process.stdout.write('\x1b[?25l'); // hide cursor
      process.once('exit', () => process.stdout.write('\x1b[?25h')); // restore even on a forced exit
    } else {
      this.orig.log(`[${this.stage}] started ${new Date().toLocaleTimeString()}`);
    }
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref();
    this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.tty) {
      this.clear();
      Object.assign(console, this.orig);
      process.stdout.write('\x1b[?25h');
    }
  }

  private refreshTotals() {
    if (Date.now() - this.totalsAt < TOTALS_REFRESH_MS && this.totals) return;
    try {
      this.totals = this.totalsFn(Date.now() - this.startedAt);
    } catch {
      /* DB busy: keep the previous totals */
    }
    this.totalsAt = Date.now();
  }

  private tick() {
    this.refreshTotals();
    if (this.tty) {
      this.frame = (this.frame + 1) % SPINNER.length;
      this.clear();
      this.draw();
    } else if (Date.now() - this.lastHeartbeat >= HEARTBEAT_MS) {
      this.lastHeartbeat = Date.now();
      const active = [...this.workers.entries()].map(([w, s]) => `w${w}: ${s.text}`).join(' | ');
      this.orig.log(`[${new Date().toLocaleTimeString()}] ${this.stage} · ${this.totals}${active ? ` · ${active}` : ''}`);
    }
  }

  private lines(): string[] {
    const width = Math.max(40, (process.stdout.columns || 120) - 1);
    const now = Date.now();
    const head = `${SPINNER[this.frame]} ${this.stage} · running ${formatDuration(now - this.startedAt)} · ${this.totals}`;
    const rows = [...this.workers.entries()]
      .sort(([a], [b]) => a - b)
      .map(([w, s]) => {
        const t = s.until ? `${formatDuration(s.until - now)} left` : formatDuration(now - s.since);
        return `  w${w}  ${s.text} · ${t}`;
      });
    return [head, ...rows].map((l) => (l.length > width ? `${l.slice(0, width - 1)}…` : l));
  }

  private draw() {
    const out = this.lines();
    const styled = out.map((l, i) => (i === 0 ? `\x1b[1;36m${l}\x1b[0m` : /BLOCKED|network down/.test(l) ? `\x1b[31m${l}\x1b[0m` : l));
    process.stdout.write(`${styled.join('\n')}\n`);
    this.drawnLines = out.length;
  }

  private clear() {
    if (!this.drawnLines) return;
    process.stdout.write(`\x1b[${this.drawnLines}A\x1b[J`);
    this.drawnLines = 0;
  }
}
