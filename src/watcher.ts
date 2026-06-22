import * as path from 'path';
import * as fs from 'fs';
import { FSWatcher } from 'chokidar';
import { MonitorOptions } from './types';

export type FileChangeCallback = (dbPath: string) => void;
export type ErrorCallback = (error: unknown) => void;

export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private dirWatcher: FSWatcher | null = null;
  private dbPath: string;
  private onChange: FileChangeCallback;
  private onErrorCb: ErrorCallback | null = null;
  private debounceMs: number;
  private verbose: boolean;
  private debounceTimer: NodeJS.Timeout | null = null;
  private watchedFiles: Set<string> = new Set();

  constructor(
    dbPath: string,
    onChange: FileChangeCallback,
    options: MonitorOptions,
    onError?: ErrorCallback,
  ) {
    this.dbPath = path.resolve(dbPath);
    this.onChange = onChange;
    this.onErrorCb = onError || null;
    this.debounceMs = options.debounceMs;
    this.verbose = options.verbose;
  }

  start(): void {
    const dir = path.dirname(this.dbPath);
    const base = path.basename(this.dbPath);
    const walFile = base + '-wal';
    const shmFile = base + '-shm';

    const targets: string[] = [this.dbPath];
    const walPath = path.join(dir, walFile);
    const shmPath = path.join(dir, shmFile);

    if (fs.existsSync(walPath)) targets.push(walPath);
    if (fs.existsSync(shmPath)) targets.push(shmPath);

    const watcher = new FSWatcher({
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: Math.max(20, Math.floor(this.debounceMs * 0.6)),
        pollInterval: 10,
      },
      atomic: 50,
      persistent: true,
      followSymlinks: true,
    });
    this.watcher = watcher;

    for (const target of targets) {
      if (fs.existsSync(target)) {
        watcher.add(target);
        this.watchedFiles.add(target);
        if (this.verbose) {
          this.log(`watching file: ${target}`);
        }
      }
    }

    watcher.on('all', (event: string, filePath: string) => {
      if (this.verbose) {
        this.log(`file event: ${event} on ${filePath}`);
      }
      this.scheduleDiff();
    });

    watcher.on('error', (error: unknown) => {
      this.log(`watcher error: ${error instanceof Error ? error.message : String(error)}`);
      if (this.onErrorCb) {
        this.onErrorCb(error);
      }
    });

    watcher.on('ready', () => {
      this.log('file watcher ready, monitoring for changes via OS events...');
    });

    const dirWatcher = new FSWatcher({
      ignoreInitial: true,
      depth: 0,
      persistent: true,
    });
    this.dirWatcher = dirWatcher;

    dirWatcher.add(dir);
    dirWatcher.on('all', (event: string, filePath: string) => {
      if (event !== 'add') return;

      const fileName = path.basename(filePath);
      if (fileName === base || fileName === walFile || fileName === shmFile) {
        if (!this.watchedFiles.has(filePath)) {
          watcher.add(filePath);
          this.watchedFiles.add(filePath);
          if (this.verbose) {
            this.log(`detected new file, added to watch: ${filePath}`);
          }
        }
        this.scheduleDiff();
      }
    });

    dirWatcher.on('error', (error: unknown) => {
      this.log(`dir watcher error: ${error instanceof Error ? error.message : String(error)}`);
      if (this.onErrorCb) {
        this.onErrorCb(error);
      }
    });
  }

  private scheduleDiff(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.onChange(this.dbPath);
    }, this.debounceMs);
  }

  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.dirWatcher) {
      this.dirWatcher.close();
      this.dirWatcher = null;
    }
    this.watchedFiles.clear();
  }

  private log(msg: string): void {
    if (this.verbose) {
      process.stderr.write(`[watcher] ${msg}\n`);
    }
  }
}
