import initSqlJs, { Database } from 'sql.js';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { ChangeEvent, DatabaseSnapshot, RowEntry, TableInfo, MonitorOptions } from './types';

export class SnapshotEngine {
  private dbPath: string;
  private prevSnapshot: DatabaseSnapshot | null = null;
  private options: MonitorOptions;
  private sqlJsReady: Promise<void>;
  private SQL: any = null;

  constructor(dbPath: string, options: MonitorOptions) {
    this.dbPath = dbPath;
    this.options = options;
    this.sqlJsReady = this.initSqlJs();
  }

  private async initSqlJs(): Promise<void> {
    this.SQL = await initSqlJs();
  }

  async ensureReady(): Promise<void> {
    await this.sqlJsReady;
  }

  private openDb(): Database {
    const buffer = fs.readFileSync(this.dbPath);
    return new this.SQL.Database(buffer);
  }

  private getTableList(db: Database): TableInfo[] {
    const tables: TableInfo[] = [];
    const results = db.exec(
      "SELECT name, type, sql FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name"
    );

    if (!results.length || !results[0].values) return tables;

    for (const row of results[0].values) {
      const name = row[0] as string;
      const type = row[1] as string;
      const sql = row[2] as string;

      if (this.options.includeTables && !this.options.includeTables.includes(name)) continue;
      if (this.options.excludeTables && this.options.excludeTables.includes(name)) continue;

      const columns = this.getColumns(db, name);
      const hasRowid = this.checkHasRowid(db, name);

      tables.push({
        name,
        type: type as 'table' | 'view',
        sql,
        hasRowid,
        columns,
      });
    }
    return tables;
  }

  private getColumns(db: any, tableName: string): string[] {
    const results = db.exec(`PRAGMA table_info("${tableName}")`);
    if (!results.length || !results[0].values) return [];
    return results[0].values.map((row: any[]) => row[1] as string);
  }

  private checkHasRowid(db: Database, tableName: string): boolean {
    try {
      db.exec(`SELECT rowid FROM "${tableName}" LIMIT 1`);
      return true;
    } catch {
      return false;
    }
  }

  takeSnapshot(): DatabaseSnapshot {
    const db = this.openDb();
    const tables = new Map<string, Map<number, RowEntry>>();

    const tableList = this.getTableList(db);

    for (const table of tableList) {
      const rowMap = new Map<number, RowEntry>();
      try {
        let sql: string;
        if (table.hasRowid) {
          sql = `SELECT rowid AS _rowid_, * FROM "${table.name}"`;
        } else {
          sql = `SELECT * FROM "${table.name}"`;
        }

        const results = db.exec(sql);
        if (results.length > 0 && results[0].values) {
          const columns = results[0].columns;
          for (const row of results[0].values) {
            const rowObj: Record<string, unknown> = {};
            let rowidValue: number | null = null;
            for (let i = 0; i < columns.length; i++) {
              if (columns[i] === '_rowid_') {
                rowidValue = row[i] as number;
              }
              const val = row[i];
              if (val instanceof Uint8Array) {
                rowObj[columns[i]] = `<blob ${val.length}B>`;
              } else {
                rowObj[columns[i]] = val;
              }
            }
            const rowid = table.hasRowid && rowidValue !== null ? rowidValue : this.computeRowId(rowObj);
            const hash = this.hashRow(rowObj, table.hasRowid);
            const data = this.extractRowData(rowObj, table.hasRowid);
            rowMap.set(rowid, { hash, data });
          }
        }
      } catch (err: any) {
        if (this.options.verbose) {
          process.stderr.write(`[snapshot] error reading table ${table.name}: ${err.message}\n`);
        }
      }
      tables.set(table.name, rowMap);
    }

    db.close();

    return { dbPath: this.dbPath, tables };
  }

  diff(newSnapshot: DatabaseSnapshot): ChangeEvent[] {
    const events: ChangeEvent[] = [];

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
        } else if (prevRowMap.get(rowid)!.hash !== newEntry.hash) {
          const before = includeBefore ? prevRowMap.get(rowid)!.data : undefined;
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

  enrichEvents(events: ChangeEvent[]): ChangeEvent[] {
    return events;
  }

  private createEvent(
    timestamp: string,
    table: string,
    operation: ChangeEvent['operation'],
    rowid: number,
    before?: Record<string, unknown>,
    after?: Record<string, unknown>,
  ): ChangeEvent {
    const event: ChangeEvent = { timestamp, database: this.dbPath, table, operation, rowid };
    if (before) event.before = before;
    if (after) event.after = after;
    return event;
  }

  private extractRowData(row: Record<string, unknown>, hasRowid: boolean): Record<string, unknown> {
    const data: Record<string, unknown> = {};
    for (const key of Object.keys(row)) {
      if (hasRowid && key === '_rowid_') continue;
      data[key] = row[key];
    }
    return data;
  }

  private hashRow(row: Record<string, unknown>, hasRowid: boolean): string {
    const parts: string[] = [];
    for (const key of Object.keys(row)) {
      if (hasRowid && key === '_rowid_') continue;
      const val = row[key];
      if (val instanceof Uint8Array) {
        parts.push(`${key}:${Buffer.from(val).toString('base64')}`);
      } else if (val === null) {
        parts.push(`${key}:NULL`);
      } else {
        parts.push(`${key}:${String(val)}`);
      }
    }
    return crypto.createHash('md5').update(parts.join('|')).digest('hex').substring(0, 16);
  }

  private computeRowId(row: Record<string, unknown>): number {
    const keys = Object.keys(row).sort();
    const hash = crypto.createHash('md5').update(keys.map(k => String(row[k])).join('|')).digest();
    return hash.readUInt32BE(0);
  }

  reset(): void {
    this.prevSnapshot = null;
  }

  close(): void {
    this.reset();
  }
}
