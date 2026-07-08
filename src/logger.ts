import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';
import { config } from './config.js';

type LogLevel = 'debug' | 'info' | 'success' | 'warn' | 'error';

const ICONS: Record<LogLevel, string> = {
  debug: '🔧',
  info: 'ℹ',
  success: '✅',
  warn: '⚠',
  error: '❌',
};

function timestampForFilename(date = new Date()): string {
  // Colons aren't valid in Windows filenames — swap ':' and '.' for '-'.
  return date.toISOString().replace(/[:.]/g, '-');
}

class RunLogger {
  readonly filePath: string;
  private readonly stream: fs.WriteStream;

  constructor(logsDir: string) {
    this.filePath = path.join(logsDir, `${timestampForFilename()}.jsonl`);
    this.stream = fs.createWriteStream(this.filePath, { flags: 'a' });
  }

  private writeLine(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    const entry = { ts: new Date().toISOString(), level, message, ...meta };
    this.stream.write(`${JSON.stringify(entry)}\n`);
  }

  private format(level: LogLevel, message: string, meta?: Record<string, unknown>): string {
    const suffix = meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
    return `${ICONS[level]} ${message}${suffix}`;
  }

  /** Written to the JSONL file only — kept out of the console to avoid clutter. */
  debug(message: string, meta?: Record<string, unknown>): void {
    this.writeLine('debug', message, meta);
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.writeLine('info', message, meta);
    console.log(this.format('info', message, meta));
  }

  success(message: string, meta?: Record<string, unknown>): void {
    this.writeLine('success', message, meta);
    console.log(this.format('success', message, meta));
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.writeLine('warn', message, meta);
    console.warn(this.format('warn', message, meta));
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.writeLine('error', message, meta);
    console.error(this.format('error', message, meta));
  }

  /** Banner for "starting a new client" — cosmetic, mirrors the reference actor's console output. */
  section(title: string): void {
    const rule = '═'.repeat(60);
    console.log(`\n${rule}\n  ${title}\n${rule}`);
    this.writeLine('info', title, { section: true });
  }

  step(title: string): void {
    console.log(`\n── ${title} ──`);
    this.writeLine('debug', title, { step: true });
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.stream.end(resolve));
  }
}

export const logger = new RunLogger(config.paths.logsDir);

/** Best-effort debug screenshot — never throws, since a failed screenshot must not kill the run. */
export async function screenshot(page: Page, label: string): Promise<string | null> {
  const dir = path.join(config.paths.tmpDir, 'screenshots');
  fs.mkdirSync(dir, { recursive: true });
  const safeLabel = label.replace(/[^a-z0-9_-]/gi, '_');
  const filePath = path.join(dir, `${Date.now()}_${safeLabel}.png`);
  try {
    await page.screenshot({ path: filePath, fullPage: true });
    logger.debug('Screenshot saved', { filePath });
    return filePath;
  } catch (err) {
    logger.warn(`Could not take screenshot "${label}"`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
