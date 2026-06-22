export type OperationType = 'INSERT' | 'UPDATE' | 'DELETE';
export interface ChangeEvent {
    timestamp: string;
    database: string;
    table: string;
    operation: OperationType;
    rowid: number;
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
}
export interface RowEntry {
    hash: string;
    data: Record<string, unknown>;
}
export interface DatabaseSnapshot {
    dbPath: string;
    tables: Map<string, Map<number, RowEntry>>;
}
export interface MonitorOptions {
    dbPath: string;
    includeTables?: string[];
    excludeTables?: string[];
    pollIntervalMs: number;
    verbose: boolean;
    showBefore: boolean;
    colorize: boolean;
    forcePoll: boolean;
    debounceMs: number;
}
export interface TableInfo {
    name: string;
    type: 'table' | 'view';
    sql: string;
    hasRowid: boolean;
    columns: string[];
}
//# sourceMappingURL=types.d.ts.map