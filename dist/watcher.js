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
exports.FileWatcher = void 0;
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const chokidar_1 = require("chokidar");
class FileWatcher {
    watcher = null;
    dirWatcher = null;
    dbPath;
    onChange;
    onErrorCb = null;
    debounceMs;
    verbose;
    debounceTimer = null;
    watchedFiles = new Set();
    constructor(dbPath, onChange, options, onError) {
        this.dbPath = path.resolve(dbPath);
        this.onChange = onChange;
        this.onErrorCb = onError || null;
        this.debounceMs = options.debounceMs;
        this.verbose = options.verbose;
    }
    start() {
        const dir = path.dirname(this.dbPath);
        const base = path.basename(this.dbPath);
        const walFile = base + '-wal';
        const shmFile = base + '-shm';
        const targets = [this.dbPath];
        const walPath = path.join(dir, walFile);
        const shmPath = path.join(dir, shmFile);
        if (fs.existsSync(walPath))
            targets.push(walPath);
        if (fs.existsSync(shmPath))
            targets.push(shmPath);
        const watcher = new chokidar_1.FSWatcher({
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
        watcher.on('all', (event, filePath) => {
            if (this.verbose) {
                this.log(`file event: ${event} on ${filePath}`);
            }
            this.scheduleDiff();
        });
        watcher.on('error', (error) => {
            this.log(`watcher error: ${error instanceof Error ? error.message : String(error)}`);
            if (this.onErrorCb) {
                this.onErrorCb(error);
            }
        });
        watcher.on('ready', () => {
            this.log('file watcher ready, monitoring for changes via OS events...');
        });
        const dirWatcher = new chokidar_1.FSWatcher({
            ignoreInitial: true,
            depth: 0,
            persistent: true,
        });
        this.dirWatcher = dirWatcher;
        dirWatcher.add(dir);
        dirWatcher.on('all', (event, filePath) => {
            if (event !== 'add')
                return;
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
        dirWatcher.on('error', (error) => {
            this.log(`dir watcher error: ${error instanceof Error ? error.message : String(error)}`);
            if (this.onErrorCb) {
                this.onErrorCb(error);
            }
        });
    }
    scheduleDiff() {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = setTimeout(() => {
            this.debounceTimer = null;
            this.onChange(this.dbPath);
        }, this.debounceMs);
    }
    stop() {
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
    log(msg) {
        if (this.verbose) {
            process.stderr.write(`[watcher] ${msg}\n`);
        }
    }
}
exports.FileWatcher = FileWatcher;
//# sourceMappingURL=watcher.js.map