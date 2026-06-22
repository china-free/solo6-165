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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SnapshotEngine = void 0;
const sql_js_1 = __importDefault(require("sql.js"));
const fs = __importStar(require("fs"));
const crypto = __importStar(require("crypto"));
class SnapshotEngine {
    dbPath;
    prevSnapshot = null;
    options;
    sqlJsReady;
    SQL = null;
    constructor(dbPath, options) {
        this.dbPath = dbPath;
        this.options = options;
        this.sqlJsReady = this.initSqlJs();
    }
    async initSqlJs() {
        this.SQL = await (0, sql_js_1.default)();
    }
    async ensureReady() {
        await this.sqlJsReady;
    }
    openDb() {
        const buffer = fs.readFileSync(this.dbPath);
        return new this.SQL.Database(buffer);
    }
    getTableList(db) {
        const tables = [];
        const results = db.exec("SELECT name, type, sql FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name");
        if (!results.length || !results[0].values)
            return tables;
        for (const row of results[0].values) {
            const name = row[0];
            const type = row[1];
            const sql = row[2];
            if (this.options.includeTables && !this.options.includeTables.includes(name))
                continue;
            if (this.options.excludeTables && this.options.excludeTables.includes(name))
                continue;
            const columns = this.getColumns(db, name);
            const hasRowid = this.checkHasRowid(db, name);
            tables.push({
                name,
                type: type,
                sql,
                hasRowid,
                columns,
            });
        }
        return tables;
    }
    getColumns(db, tableName) {
        const results = db.exec(`PRAGMA table_info("${tableName}")`);
        if (!results.length || !results[0].values)
            return [];
        return results[0].values.map((row) => row[1]);
    }
    checkHasRowid(db, tableName) {
        try {
            db.exec(`SELECT rowid FROM "${tableName}" LIMIT 1`);
            return true;
        }
        catch {
            return false;
        }
    }
    takeSnapshot() {
        const db = this.openDb();
        const tables = new Map();
        const tableList = this.getTableList(db);
        for (const table of tableList) {
            const rowMap = new Map();
            try {
                let sql;
                if (table.hasRowid) {
                    sql = `SELECT rowid AS _rowid_, * FROM "${table.name}"`;
                }
                else {
                    sql = `SELECT * FROM "${table.name}"`;
                }
                const results = db.exec(sql);
                if (results.length > 0 && results[0].values) {
                    const columns = results[0].columns;
                    for (const row of results[0].values) {
                        const rowObj = {};
                        let rowidValue = null;
                        for (let i = 0; i < columns.length; i++) {
                            if (columns[i] === '_rowid_') {
                                rowidValue = row[i];
                            }
                            const val = row[i];
                            if (val instanceof Uint8Array) {
                                rowObj[columns[i]] = `<blob ${val.length}B>`;
                            }
                            else {
                                rowObj[columns[i]] = val;
                            }
                        }
                        const rowid = table.hasRowid && rowidValue !== null ? rowidValue : this.computeRowId(rowObj);
                        const hash = this.hashRow(rowObj, table.hasRowid);
                        const data = this.extractRowData(rowObj, table.hasRowid);
                        rowMap.set(rowid, { hash, data });
                    }
                }
            }
            catch (err) {
                if (this.options.verbose) {
                    process.stderr.write(`[snapshot] error reading table ${table.name}: ${err.message}\n`);
                }
            }
            tables.set(table.name, rowMap);
        }
        db.close();
        return { dbPath: this.dbPath, tables };
    }
    diff(newSnapshot) {
        const events = [];
        if (!this.prevSnapshot) {
            this.prevSnapshot = newSnapshot;
            return events;
        }
        const now = new Date().toISOString();
        const includeBefore = this.options.showBefore;
        for (const [tableName, newRowMap] of newSnapshot.tables) {
            const prevRowMap = this.prevSnapshot.tables.get(tableName);
            if (!prevRowMap) {
                for (const [rowid, entry] of newRowMap) {
                    events.push(this.createEvent(now, tableName, 'INSERT', rowid, undefined, entry.data));
                }
                continue;
            }
            for (const [rowid, newEntry] of newRowMap) {
                if (!prevRowMap.has(rowid)) {
                    events.push(this.createEvent(now, tableName, 'INSERT', rowid, undefined, newEntry.data));
                }
                else if (prevRowMap.get(rowid).hash !== newEntry.hash) {
                    const before = includeBefore ? prevRowMap.get(rowid).data : undefined;
                    events.push(this.createEvent(now, tableName, 'UPDATE', rowid, before, newEntry.data));
                }
            }
            for (const [rowid, prevEntry] of prevRowMap) {
                if (!newRowMap.has(rowid)) {
                    const before = includeBefore ? prevEntry.data : undefined;
                    events.push(this.createEvent(now, tableName, 'DELETE', rowid, before));
                }
            }
        }
        for (const [tableName, prevRowMap] of this.prevSnapshot.tables) {
            if (!newSnapshot.tables.has(tableName)) {
                const now2 = new Date().toISOString();
                for (const [rowid, prevEntry] of prevRowMap) {
                    const before = includeBefore ? prevEntry.data : undefined;
                    events.push(this.createEvent(now2, tableName, 'DELETE', rowid, before));
                }
            }
        }
        this.prevSnapshot = newSnapshot;
        return events;
    }
    enrichEvents(events) {
        return events;
    }
    createEvent(timestamp, table, operation, rowid, before, after) {
        const event = { timestamp, database: this.dbPath, table, operation, rowid };
        if (before)
            event.before = before;
        if (after)
            event.after = after;
        return event;
    }
    extractRowData(row, hasRowid) {
        const data = {};
        for (const key of Object.keys(row)) {
            if (hasRowid && key === '_rowid_')
                continue;
            data[key] = row[key];
        }
        return data;
    }
    hashRow(row, hasRowid) {
        const parts = [];
        for (const key of Object.keys(row)) {
            if (hasRowid && key === '_rowid_')
                continue;
            const val = row[key];
            if (val instanceof Uint8Array) {
                parts.push(`${key}:${Buffer.from(val).toString('base64')}`);
            }
            else if (val === null) {
                parts.push(`${key}:NULL`);
            }
            else {
                parts.push(`${key}:${String(val)}`);
            }
        }
        return crypto.createHash('md5').update(parts.join('|')).digest('hex').substring(0, 16);
    }
    computeRowId(row) {
        const keys = Object.keys(row).sort();
        const hash = crypto.createHash('md5').update(keys.map(k => String(row[k])).join('|')).digest();
        return hash.readUInt32BE(0);
    }
    reset() {
        this.prevSnapshot = null;
    }
    close() {
        this.reset();
    }
}
exports.SnapshotEngine = SnapshotEngine;
//# sourceMappingURL=snapshot.js.map