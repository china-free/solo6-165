import { ChangeEvent, DatabaseSnapshot, MonitorOptions } from './types';
export declare class SnapshotEngine {
    private dbPath;
    private prevSnapshot;
    private options;
    private sqlJsReady;
    private SQL;
    constructor(dbPath: string, options: MonitorOptions);
    private initSqlJs;
    ensureReady(): Promise<void>;
    private openDb;
    private getTableList;
    private getColumns;
    private checkHasRowid;
    takeSnapshot(): DatabaseSnapshot;
    diff(newSnapshot: DatabaseSnapshot): ChangeEvent[];
    enrichEvents(events: ChangeEvent[]): ChangeEvent[];
    private createEvent;
    private hashRow;
    private computeRowId;
    reset(): void;
    close(): void;
}
//# sourceMappingURL=snapshot.d.ts.map