#!/usr/bin/env node

import { Command } from 'commander';
import * as path from 'path';
import * as fs from 'fs';
import { SnapshotEngine } from './snapshot';
import { FileWatcher } from './watcher';
import { emitEvent, emitStartupBanner } from './format';
import { MonitorOptions } from './types';

const program = new Command();

program
  .name('sqlite-cdc')
  .description('Real-time SQLite Change Data Capture - monitors .db/.wal files and emits JSON event streams')
  .version('1.0.0')
  .argument('<db-path>', 'Path to the SQLite database file')
  .option('-t, --include-tables <tables>', 'Comma-separated list of tables to monitor', '')
  .option('-x, --exclude-tables <tables>', 'Comma-separated list of tables to exclude', '')
  .option('-p, --poll-interval <ms>', 'Polling interval in milliseconds (only used with --force-poll)', '50')
  .option('-d, --debounce <ms>', 'Debounce window for coalescing rapid file events', '20')
  .option('-f, --format <format>', 'Output format: json or pretty', 'json')
  .option('--before', 'Include before/after row data in events', false)
  .option('--force-poll', 'Use stat polling instead of OS file system events (for network/NFS mounts)', false)
  .option('--no-color', 'Disable colored output', false)
  .option('-v, --verbose', 'Enable verbose logging', false)
  .action(async (dbPathArg: string, opts: any) => {
    const dbPath = path.resolve(dbPathArg);

    if (!fs.existsSync(dbPath)) {
      process.stderr.write(`Error: Database file not found: ${dbPath}\n`);
      process.exit(1);
    }

    const includeTables = opts.includeTables ? opts.includeTables.split(',').map((s: string) => s.trim()).filter(Boolean) : undefined;
    const excludeTables = opts.excludeTables ? opts.excludeTables.split(',').map((s: string) => s.trim()).filter(Boolean) : undefined;

    const monitorOptions: MonitorOptions = {
      dbPath,
      includeTables,
      excludeTables,
      pollIntervalMs: parseInt(opts.pollInterval, 10) || 50,
      debounceMs: parseInt(opts.debounce, 10) || 20,
      forcePoll: opts.forcePoll === true,
      verbose: opts.verbose,
      showBefore: opts.before,
      colorize: opts.color !== false && process.stdout.isTTY,
    };

    const format = opts.format === 'pretty' ? 'pretty' : 'json';

    await startMonitoring(monitorOptions, format);
  });

async function startMonitoring(options: MonitorOptions, format: 'json' | 'pretty'): Promise<void> {
  const snapshotEngine = new SnapshotEngine(options.dbPath, options);

  await snapshotEngine.ensureReady();

  try {
    const initialSnapshot = snapshotEngine.takeSnapshot();
    snapshotEngine.diff(initialSnapshot);
  } catch (err: any) {
    process.stderr.write(`Error: Failed to read database: ${err.message}\n`);
    process.exit(1);
  }

  emitStartupBanner(options.dbPath, {
    ...options,
    isPolling: options.forcePoll,
  });

  let dirty = false;
  let processing = false;
  let fileWatcher: FileWatcher | null = null;
  let pollTimer: NodeJS.Timeout | null = null;

  const checkAndDiff = () => {
    if (processing) {
      dirty = true;
      return;
    }
    processing = true;

    try {
      const newSnapshot = snapshotEngine.takeSnapshot();
      const events = snapshotEngine.diff(newSnapshot);

      for (const event of events) {
        emitEvent(event, format, options.colorize);
      }
    } catch (err: any) {
      if (options.verbose) {
        process.stderr.write(`[cdc] snapshot error: ${err.message}\n`);
      }
    } finally {
      processing = false;
      if (dirty) {
        dirty = false;
        setImmediate(checkAndDiff);
      }
    }
  };

  const cleanup = () => {
    if (options.verbose) {
      process.stderr.write('[cdc] shutting down...\n');
    }
    if (fileWatcher) {
      fileWatcher.stop();
      fileWatcher = null;
    }
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    snapshotEngine.close();
    process.exit(0);
  };

  if (options.forcePoll) {
    pollTimer = startPolling(options, checkAndDiff, () => {
      if (options.verbose) {
        process.stderr.write('[cdc] polling fallback active\n');
      }
    });
  } else {
    fileWatcher = new FileWatcher(
      options.dbPath,
      (_dbPath: string) => {
        checkAndDiff();
      },
      options,
      (err: unknown) => {
        if (options.verbose) {
          process.stderr.write(`[watcher] OS events unavailable, falling back to polling: ${err instanceof Error ? err.message : String(err)}\n`);
        }
        if (fileWatcher) {
          fileWatcher.stop();
          fileWatcher = null;
        }
        pollTimer = startPolling(options, checkAndDiff);
      },
    );

    fileWatcher.start();
  }

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('SIGHUP', cleanup);

  process.stdin.on('end', () => {
    cleanup();
  });
}

function startPolling(
  options: MonitorOptions,
  checkAndDiff: () => void,
  onStart?: () => void,
): NodeJS.Timeout {
  if (onStart) onStart();

  let lastDbMtimeMs = fs.statSync(options.dbPath).mtimeMs;
  let lastDbSize = fs.statSync(options.dbPath).size;
  let lastWalMtimeMs = 0;
  let lastWalSize = 0;
  const walPath = options.dbPath + '-wal';

  try {
    if (fs.existsSync(walPath)) {
      const ws = fs.statSync(walPath);
      lastWalMtimeMs = ws.mtimeMs;
      lastWalSize = ws.size;
    }
  } catch {}

  return setInterval(() => {
    let changed = false;
    try {
      const stat = fs.statSync(options.dbPath);
      if (stat.mtimeMs !== lastDbMtimeMs || stat.size !== lastDbSize) {
        lastDbMtimeMs = stat.mtimeMs;
        lastDbSize = stat.size;
        changed = true;
      }
    } catch {}

    try {
      if (fs.existsSync(walPath)) {
        const walStat = fs.statSync(walPath);
        if (walStat.mtimeMs !== lastWalMtimeMs || walStat.size !== lastWalSize) {
          lastWalMtimeMs = walStat.mtimeMs;
          lastWalSize = walStat.size;
          changed = true;
        }
      }
    } catch {}

    if (changed) {
      checkAndDiff();
    }
  }, options.pollIntervalMs);
}

program.parse();
