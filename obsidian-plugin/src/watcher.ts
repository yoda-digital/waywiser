import { statSync } from "fs";

export class DBWatcher {
  private path: string;
  private intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastMtime: number = 0;
  private lastSize: number = 0;
  private onChange: () => void;

  constructor(path: string, intervalMs: number, onChange: () => void) {
    this.path = path;
    this.intervalMs = intervalMs;
    this.onChange = onChange;
  }

  start(): void {
    this.snapshot();
    this.timer = setInterval(() => this.check(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private snapshot(): void {
    try {
      const stat = statSync(this.path);
      this.lastMtime = stat.mtimeMs;
      this.lastSize = stat.size;
    } catch { /* file doesn't exist yet */ }
  }

  private check(): void {
    try {
      const stat = statSync(this.path);
      if (stat.mtimeMs !== this.lastMtime || stat.size !== this.lastSize) {
        this.lastMtime = stat.mtimeMs;
        this.lastSize = stat.size;
        this.onChange();
      }
    } catch { /* file temporarily unavailable */ }
  }
}
