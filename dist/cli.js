#!/usr/bin/env node
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const commander_1 = require("commander");
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const snapshot_1 = require("./snapshot");
const watcher_1 = require("./watcher");
const format_1 = require("./format");
const program = new commander_1.Command();
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
    .action(async (dbPathArg, opts) => {
    const dbPath = path.resolve(dbPathArg);
    if (!fs.existsSync(dbPath)) {
        process.stderr.write(`Error: Database file not found: ${dbPath}\n`);
        process.exit(1);
    }
    const includeTables = opts.includeTables ? opts.includeTables.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
    const excludeTables = opts.excludeTables ? opts.excludeTables.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
    const monitorOptions = {
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
async function startMonitoring(options, format) {
    const snapshotEngine = new snapshot_1.SnapshotEngine(options.dbPath, options);
    await snapshotEngine.ensureReady();
    try {
        const initialSnapshot = snapshotEngine.takeSnapshot();
        snapshotEngine.diff(initialSnapshot);
    }
    catch (err) {
        process.stderr.write(`Error: Failed to read database: ${err.message}\n`);
        process.exit(1);
    }
    (0, format_1.emitStartupBanner)(options.dbPath, {
        ...options,
        isPolling: options.forcePoll,
    });
    let dirty = false;
    let processing = false;
    let fileWatcher = null;
    let pollTimer = null;
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
                (0, format_1.emitEvent)(event, format, options.colorize);
            }
        }
        catch (err) {
            if (options.verbose) {
                process.stderr.write(`[cdc] snapshot error: ${err.message}\n`);
            }
        }
        finally {
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
    }
    else {
        fileWatcher = new watcher_1.FileWatcher(options.dbPath, (_dbPath) => {
            checkAndDiff();
        }, options, (err) => {
            if (options.verbose) {
                process.stderr.write(`[watcher] OS events unavailable, falling back to polling: ${err instanceof Error ? err.message : String(err)}\n`);
            }
            if (fileWatcher) {
                fileWatcher.stop();
                fileWatcher = null;
            }
            pollTimer = startPolling(options, checkAndDiff);
        });
        fileWatcher.start();
    }
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
    process.on('SIGHUP', cleanup);
    process.stdin.on('end', () => {
        cleanup();
    });
}
function startPolling(options, checkAndDiff, onStart) {
    if (onStart)
        onStart();
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
    }
    catch { }
    return setInterval(() => {
        let changed = false;
        try {
            const stat = fs.statSync(options.dbPath);
            if (stat.mtimeMs !== lastDbMtimeMs || stat.size !== lastDbSize) {
                lastDbMtimeMs = stat.mtimeMs;
                lastDbSize = stat.size;
                changed = true;
            }
        }
        catch { }
        try {
            if (fs.existsSync(walPath)) {
                const walStat = fs.statSync(walPath);
                if (walStat.mtimeMs !== lastWalMtimeMs || walStat.size !== lastWalSize) {
                    lastWalMtimeMs = walStat.mtimeMs;
                    lastWalSize = walStat.size;
                    changed = true;
                }
            }
        }
        catch { }
        if (changed) {
            checkAndDiff();
        }
    }, options.pollIntervalMs);
}
program.parse();
//# sourceMappingURL=cli.js.map