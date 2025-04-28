// src/utils.ts

import stripAnsi from 'strip-ansi';
import { SERVER_NAME } from './constants.js';

// Logging
export const log = {
    info: (label: string | null, message: string, data?: unknown) => console.error(`[${SERVER_NAME}${label ? ` ${label}` : ''}] INFO: ${message}`, data ?? ''),
    warn: (label: string | null, message: string, data?: unknown) => console.error(`[${SERVER_NAME}${label ? ` ${label}` : ''}] WARN: ${message}`, data ?? ''),
    error: (label: string | null, message: string, error?: unknown) => console.error(`[${SERVER_NAME}${label ? ` ${label}` : ''}] ERROR: ${message}`, error ?? ''),
    debug: (label: string | null, message: string, data?: unknown) => {
        console.error(`[${SERVER_NAME}${label ? ` ${label}` : ''}] DEBUG: ${message}`, data ?? '');
    }
};

// Helper Functions
export function stripAnsiSafe(input: string): string {
    if (typeof input !== 'string') return input;
    try {
        const cleanedInput = input.replace(/\\u0000/g, '');
        return stripAnsi(cleanedInput);
    } catch (e: unknown) {
        log.error(null, `Error stripping ANSI: ${e instanceof Error ? e.message : String(e)}`, { originalInput: input });
        return input;
    }
}

export function formatLogsForResponse(logs: string[], lineCount: number): string[] {
    const recentLogs = logs.slice(-lineCount);
    return recentLogs.map(stripAnsiSafe);
} 