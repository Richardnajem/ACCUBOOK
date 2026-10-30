/**
 * Client-side global error logger — Stockfolio.
 *
 * Captures runtime failures that would otherwise only reach the devtools
 * console: `window.onerror`, unhandled promise rejections and
 * `console.error/warn`. Entries are de-duplicated (same fingerprint increments
 * a counter), capped, and persisted to localStorage so they survive a reload.
 *
 * Read them from the browser with:
 *   JSON.parse(localStorage.getItem('stockfolio-error-log'))
 *
 * Initialised once by <ErrorLoggerInit /> mounted in the root layout.
 */

export type ErrorLevel = 'error' | 'warn';

export interface ErrorLogEntry {
    id: string;
    timestamp: string;
    level: ErrorLevel;
    source: string;
    message: string;
    stack?: string;
    count: number;
    url: string;
}

const STORAGE_KEY = 'stockfolio-error-log';
const MAX_ENTRIES = 200;
const MESSAGE_CAP = 1000;
const STACK_CAP = 4000;

let entries: ErrorLogEntry[] = [];
let initialised = false;

function clip(value: unknown, cap: number): string {
    const s = String(value ?? '');
    return s.length > cap ? `${s.slice(0, cap)}… [${s.length} chars]` : s;
}

function fingerprint(level: ErrorLevel, source: string, message: string): string {
    return `${level}::${source}::${message
        .toLowerCase()
        .replace(/\b[0-9a-f]{8,}\b/g, '<ID>')
        .replace(/\b\d{6,}\b/g, '<N>')
        .slice(0, 120)}`;
}

function load(): void {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        entries = raw ? (JSON.parse(raw) as ErrorLogEntry[]) : [];
    } catch {
        entries = [];
    }
}

export const ERROR_LOG_EVENT = 'stockfolio:error-log';

function save(): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(-MAX_ENTRIES)));
    } catch {
        // Never let logging break the app.
    }
    // Let the Logs panel in Settings refresh itself while it is open.
    if (typeof window !== 'undefined') {
        try {
            window.dispatchEvent(new Event(ERROR_LOG_EVENT));
        } catch {
            // Older/odd environments without Event — the log itself is stored.
        }
    }
}

export function addErrorLog(level: ErrorLevel, source: string, message: string, stack?: string): ErrorLogEntry {
    const safeMessage = clip(message || '(no message)', MESSAGE_CAP);
    const fp = fingerprint(level, source, safeMessage);

    const existing = entries.find((e) => fingerprint(e.level, e.source, e.message) === fp);
    if (existing) {
        existing.count += 1;
        existing.timestamp = new Date().toISOString();
        if (stack && !existing.stack) existing.stack = clip(stack, STACK_CAP);
        save();
        return existing;
    }

    const entry: ErrorLogEntry = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
        timestamp: new Date().toISOString(),
        level,
        source,
        message: safeMessage,
        stack: stack ? clip(stack, STACK_CAP) : undefined,
        count: 1,
        url: typeof window !== 'undefined' ? window.location.href : '',
    };
    entries.push(entry);
    if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
    save();
    return entry;
}

export function getErrorLogs(): ErrorLogEntry[] {
    return [...entries].reverse();
}

export function clearErrorLogs(): void {
    entries = [];
    save();
}

/** Install global handlers once. Safe to call repeatedly. */
export function initErrorLogger(): void {
    if (initialised || typeof window === 'undefined') return;
    initialised = true;
    load();

    const origOnError = window.onerror;
    window.onerror = (message, source, lineno, colno, error) => {
        addErrorLog('error', source || 'window.onerror', String(message), error?.stack);
        return origOnError ? origOnError.call(window, message, source, lineno, colno, error) : false;
    };

    window.addEventListener('unhandledrejection', (event) => {
        const reason: unknown = (event as PromiseRejectionEvent).reason;
        const message =
            reason instanceof Error ? reason.message
                : typeof reason === 'string' ? reason
                    : reason == null ? 'Unhandled promise rejection (no reason)'
                        : (() => { try { return JSON.stringify(reason); } catch { return String(reason); } })();
        addErrorLog('error', 'unhandledrejection', message, reason instanceof Error ? reason.stack : undefined);
    });

    const origConsoleError = console.error;
    console.error = (...args: unknown[]) => {
        addErrorLog('error', 'console.error', args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(' '));
        origConsoleError.apply(console, args);
    };

    const origConsoleWarn = console.warn;
    console.warn = (...args: unknown[]) => {
        addErrorLog('warn', 'console.warn', args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(' '));
        origConsoleWarn.apply(console, args);
    };
}
