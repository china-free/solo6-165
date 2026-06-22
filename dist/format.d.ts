import { ChangeEvent } from './types';
export declare function formatEventJson(event: ChangeEvent): string;
export declare function formatEventPretty(event: ChangeEvent, colorize: boolean): string;
export declare function emitEvent(event: ChangeEvent, format: 'json' | 'pretty', colorize: boolean): void;
export declare function emitStartupBanner(dbPath: string, options: {
    verbose: boolean;
    pollIntervalMs: number;
}): void;
//# sourceMappingURL=format.d.ts.map