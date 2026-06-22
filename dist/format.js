"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatEventJson = formatEventJson;
exports.formatEventPretty = formatEventPretty;
exports.emitEvent = emitEvent;
exports.emitStartupBanner = emitStartupBanner;
const COLORS = {
    INSERT: '\x1b[32m',
    UPDATE: '\x1b[33m',
    DELETE: '\x1b[31m',
    RESET: '\x1b[0m',
    DIM: '\x1b[2m',
    BOLD: '\x1b[1m',
    CYAN: '\x1b[36m',
};
function formatEventJson(event) {
    return JSON.stringify(event);
}
function formatEventPretty(event, colorize) {
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
function emitEvent(event, format, colorize) {
    const output = format === 'json'
        ? formatEventJson(event)
        : formatEventPretty(event, colorize);
    process.stdout.write(output + '\n');
}
function emitStartupBanner(dbPath, options) {
    const mode = options.isPolling
        ? `Polling interval: ${options.pollIntervalMs}ms (fallback mode)`
        : `Mode: OS file system events (inotify/kqueue/ReadDirectoryChanges)`;
    process.stderr.write(`\x1b[36m\x1b[1msqlite-cdc\x1b[0m - SQLite Change Data Capture\n` +
        `\x1b[2mMonitoring: ${dbPath}\x1b[0m\n` +
        `\x1b[2m${mode} | Verbose: ${options.verbose}\x1b[0m\n` +
        `\x1b[2mWaiting for changes...\n\x1b[0m`);
}
//# sourceMappingURL=format.js.map