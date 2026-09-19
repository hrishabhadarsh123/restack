/**
 * Logger with verbosity control for the restack CLI.
 * Keep the public surface tiny: debug/info/warn/error/success.
 */
import pc from "picocolors";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

class Logger {
  private minLevel: LogLevel = "info";

  setLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  getLevel(): LogLevel {
    return this.minLevel;
  }

  private enabled(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[this.minLevel];
  }

  /** Raw line, always shown (used for progress output). */
  line(text = ""): void {
    process.stderr.write(text + "\n");
  }

  debug(text: string): void {
    if (this.enabled("debug")) process.stderr.write(pc.dim(text) + "\n");
  }

  info(text: string): void {
    if (this.enabled("info")) process.stderr.write(text + "\n");
  }

  success(text: string): void {
    if (this.enabled("info")) process.stderr.write(pc.green(text) + "\n");
  }

  warn(text: string): void {
    if (this.enabled("warn")) process.stderr.write(pc.yellow("⚠ " + text) + "\n");
  }

  error(text: string): void {
    if (this.enabled("error")) process.stderr.write(pc.red("✗ " + text) + "\n");
  }
}

/** Singleton logger — CLI sets the level from flags, modules import `logger`. */
export const logger = new Logger();
