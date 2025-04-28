import { z } from "zod";
import type { ZodRawShape } from "zod";
import type { IPty } from 'node-pty';

/* ------------------------------------------------------------------------ */
/*  1.  MCP payload primitives                                              */
/* ------------------------------------------------------------------------ */
export interface TextContent {
    readonly type: "text";
    text: string;
    [key: string]: unknown;
}

export interface ImageContent {
    readonly type: "image";
    /** base-64 payload */
    data: string;
    mimeType: string;
    [key: string]: unknown;
}

export interface AudioContent {
    readonly type: "audio";
    /** base-64 payload */
    data: string;
    mimeType: string;
    [key: string]: unknown;
}

export interface TextResource {
    /** raw text representation of the resource */
    text: string;
    uri: string;
    mimeType?: string;
    [key: string]: unknown;
}

export interface BlobResource {
    /** base-64 blob (files, compressed JSON, etc.) */
    uri: string;
    blob: string;
    mimeType?: string;
    [key: string]: unknown;
}

export interface ResourceContent {
    readonly type: "resource";
    resource: TextResource | BlobResource;
    [key: string]: unknown;
}

export type ToolContent =
    | TextContent
    | ImageContent
    | AudioContent
    | ResourceContent;

/* ------------------------------------------------------------------------ */
/*  2.  Strongly-typed CallToolResult                                       */
/*      – fixes all "resource missing" & literal-widening errors            */
/* ------------------------------------------------------------------------ */
export interface CallToolResult {
    /** Actual tool output; at least one payload required. */
    content: ToolContent[];
    /** Optional metadata – free-form. */
    _meta?: Record<string, unknown>;
    /** Signals a domain-level failure (LLMs can still read `content`). */
    isError?: boolean;
    /** Index signature to match SDK type */
    [key: string]: unknown;
}

export const textPayload = (text: string): TextContent =>
    ({ type: "text", text } as const);

export const ok = (...c: readonly ToolContent[]): CallToolResult =>
    ({ content: [...c] });

export const fail = (...c: readonly ToolContent[]): CallToolResult =>
    ({ isError: true, content: [...c] });

/* ------------------------------------------------------------------------ */
/*  4.  Zod helpers – give server.tool what it actually wants               */
/*      – fixes every `ZodObject … not assignable to ZodRawShape` (2345)    */
/* ------------------------------------------------------------------------ */
export const shape = <S extends ZodRawShape>(s: S): S => s;

/* ------------------------------------------------------------------------ */
/*  5.  Utility guards (optional but nice)                                  */
/* ------------------------------------------------------------------------ */
export const safeSubstring = (v: unknown, len = 100): string =>
    typeof v === "string" ? v.substring(0, len) : "";

export const isRunning = (status: string) =>
    status === "running" || status === "verifying";

// Helper to safely get text from CallToolResult for JSON parsing
export const getResultText = (result: CallToolResult): string | null => {
    if (result.content && result.content.length > 0) {
        const firstContent = result.content[0];
        // Check if it's a TextContent object and has a text property
        if (firstContent &&
            'type' in firstContent &&
            firstContent.type === 'text' &&
            'text' in firstContent &&
            typeof firstContent.text === 'string') {
            return firstContent.text;
        }
    }
    return null;
};

export type ServerStatus = 'starting' | 'verifying' | 'running' | 'stopping' | 'stopped' | 'restarting' | 'crashed' | 'error';

export interface ServerInfo {
    label: string;
    process: IPty | null; // Changed from ChildProcess to IPty
    command: string;
    cwd: string;
    startTime: Date;
    status: ServerStatus;
    pid: number | null;
    logs: string[];
    exitCode: number | null;
    error: string | null;
    retryCount: number;
    lastAttemptTime: number | null;
    workspacePath: string;
}