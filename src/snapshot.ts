import initSqlJs, { Database } from 'sql.js';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { ChangeEvent, DatabaseSnapshot, TableInfo, MonitorOptions } from './types';

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
    const tables = new Map<string, Map<number, string>>();

    const tableList = this.getTableList(db);

    for (const table of tableList) {
      const rowMap = new Map<number, string>();
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
              rowObj[columns[i]] = row[i];
            }
            const rowid = table.hasRowid && rowidValue !== null ? rowidValue : this.computeRowId(rowObj);
            const hash = this.hashRow(rowObj, table.hasRowid);
            rowMap.set(rowid, hash);
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

    for (const [tableName, newRowMap] of newSnapshot.tables) {
      const prevRowMap = this.prevSnapshot.tables.get(tableName);

      if (!prevRowMap) {
        for (const [rowid, _] of newRowMap) {
          events.push(this.createEvent(now, tableName, 'INSERT', rowid));
        }
        continue;
      }

      for (const [rowid, newHash] of newRowMap) {
        if (!prevRowMap.has(rowid)) {
          events.push(this.createEvent(now, tableName, 'INSERT', rowid));
        } else if (prevRowMap.get(rowid) !== newHash) {
          events.push(this.createEvent(now, tableName, 'UPDATE', rowid));
        }
      }

      for (const [rowid, _] of prevRowMap) {
        if (!newRowMap.has(rowid)) {
          events.push(this.createEvent(now, tableName, 'DELETE', rowid));
        }
      }
    }

    for (const [tableName, prevRowMap] of this.prevSnapshot.tables) {
      if (!newSnapshot.tables.has(tableName)) {
        const now2 = new Date().toISOString();
        for (const [rowid, _] of prevRowMap) {
          events.push(this.createEvent(now2, tableName, 'DELETE', rowid));
        }
      }
    }

    this.prevSnapshot = newSnapshot;
    return events;
  }

  enrichEvents(events: ChangeEvent[]): ChangeEvent[] {
    if (!this.options.showBefore) return events;

    const db = this.openDb();
    const enriched: ChangeEvent[] = [];

    for (const event of events) {
      if (event.operation === 'DELETE') {
        enriched.push(event);
        continue;
      }

      try {
        const results = db.exec(`SELECT * FROM "${event.table}" WHERE rowid = ${event.rowid}`);
        if (results.length > 0 && results[0].values.length > 0) {
          const columns = results[0].columns;
          const row = results[0].values[0];
          const record: Record<string, unknown> = {};
          for (let i = 0; i < columns.length; i++) {
            const val = row[i];
            if (val instanceof Uint8Array) {
              record[columns[i]] = `<blob ${val.length}B>`;
            } else {
              record[columns[i]] = val;
            }
          }
          enriched.push({ ...event, after: record });
        } else {
          enriched.push(event);
        }
      } catch {
        enriched.push(event);
      }
    }

    db.close();
    return enriched;
  }

  private createEvent(
    timestamp: string,
    table: string,
    operation: ChangeEvent['operation'],
    rowid: number,
  ): ChangeEvent {
    return { timestamp, database: this.dbPath, table, operation, rowid };
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
