#!/usr/bin/env node

import { Command } from 'commander';
import * as path from 'path';
import * as fs from 'fs';
import { SnapshotEngine } from './snapshot';
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
  .option('-p, --poll-interval <ms>', 'Polling interval in milliseconds', '50')
  .option('-f, --format <format>', 'Output format: json or pretty', 'json')
  .option('--before', 'Include before/after row data in events', false)
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

  emitStartupBanner(options.dbPath, options);

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
  let dirty = false;
  let processing = false;

  const checkAndDiff = () => {
    if (processing) {
      dirty = true;
      return;
    }
    processing = true;

    try {
      const newSnapshot = snapshotEngine.takeSnapshot();
      const events = snapshotEngine.diff(newSnapshot);

      let enrichedEvents = events;
      if (options.showBefore && events.length > 0) {
        enrichedEvents = snapshotEngine.enrichEvents(events);
      }

      for (const event of enrichedEvents) {
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

  const pollTimer = setInterval(() => {
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

  const cleanup = () => {
    if (options.verbose) {
      process.stderr.write('[cdc] shutting down...\n');
    }
    clearInterval(pollTimer);
    snapshotEngine.close();
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('SIGHUP', cleanup);

  process.stdin.on('end', () => {
    cleanup();
  });
}

program.parse();
