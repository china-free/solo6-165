import { ChangeEvent } from './types';

const COLORS = {
  INSERT: '\x1b[32m',
  UPDATE: '\x1b[33m',
  DELETE: '\x1b[31m',
  RESET: '\x1b[0m',
  DIM: '\x1b[2m',
  BOLD: '\x1b[1m',
  CYAN: '\x1b[36m',
};

export function formatEventJson(event: ChangeEvent): string {
  return JSON.stringify(event);
}

export function formatEventPretty(event: ChangeEvent, colorize: boolean): string {
  const time = event.timestamp;
  const op = event.operation;
  const table = event.table;
  const rowid = event.rowid;

  if (colorize) {
    const color = COLORS[op] || '';
    const line = `${COLORS.DIM}${time}${COLORS.RESET} ${color}${COLORS.BOLD}${op.padEnd(6)}${COLORS.RESET} ${COLORS.CYAN}${table}${COLORS.RESET} rowid=${rowid}`;

    if (event.after) {
      const data = JSON.stringify(event.after);
      return `${line} ${COLORS.DIM}${data}${COLORS.RESET}`;
    }
    if (event.before) {
      const data = JSON.stringify(event.before);
      return `${line} ${COLORS.DIM}${data}${COLORS.RESET}`;
    }
    return line;
  }

  let line = `${time} ${op.padEnd(6)} ${table} rowid=${rowid}`;
  if (event.after) {
    line += ` ${JSON.stringify(event.after)}`;
  }
  if (event.before) {
    line += ` ${JSON.stringify(event.before)}`;
  }
  return line;
}

export function emitEvent(event: ChangeEvent, format: 'json' | 'pretty', colorize: boolean): void {
  const output = format === 'json'
    ? formatEventJson(event)
    : formatEventPretty(event, colorize);
  process.stdout.write(output + '\n');
}

export function emitStartupBanner(dbPath: string, options: { verbose: boolean; pollIntervalMs: number }): void {
  process.stderr.write(
    `\x1b[36m\x1b[1msqlite-cdc\x1b[0m - SQLite Change Data Capture\n` +
    `\x1b[2mMonitoring: ${dbPath}\x1b[0m\n` +
    `\x1b[2mPoll interval: ${options.pollIntervalMs}ms | Verbose: ${options.verbose}\x1b[0m\n` +
    `\x1b[2mWaiting for changes...\n\x1b[0m`
  );
}
