import { MonitorOptions } from './types';
export type FileChangeCallback = (dbPath: string) => void;
export type ErrorCallback = (error: unknown) => void;
export declare class FileWatcher {
    private watcher;
    private dirWatcher;
    private dbPath;
    private onChange;
    private onErrorCb;
    private debounceMs;
    private verbose;
    private debounceTimer;
    private watchedFiles;
    constructor(dbPath: string, onChange: FileChangeCallback, options: MonitorOptions, onError?: ErrorCallback);
    start(): void;
    private scheduleDiff;
    stop(): void;
    private log;
}
//# sourceMappingURL=watcher.d.ts.map