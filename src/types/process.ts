import type * as fs from "node:fs";
import type { IDisposable, IPty } from "node-pty";
import { z } from "zod";

// Host enum definition
export const HostEnum = z.enum([
	"cursor",
	"claude",
	"chatgpt",
	"vscode",
	"windsurf",
	"unknown",
]);
export type HostEnumType = z.infer<typeof HostEnum>;

// Operating system enum definition
export const OperatingSystemEnum = z.enum(["windows", "linux", "mac"]);
export type OperatingSystemEnumType = z.infer<typeof OperatingSystemEnum>;

/** Represents the current state of a managed process. */
export type ProcessStatus =
	| "starting"
	| "running"
	| "verifying"
	| "stopped"
	| "crashed"
	| "error"
	| "restarting"
	| "stopping";

/** Represents a single log entry with timestamp and content. */
export interface LogEntry {
	timestamp: number;
	content: string;
}

/** Detailed information about a managed process. */
export interface ProcessInfo {
	label: string;
	command: string;
	args: string[];
	cwd: string;
	host: HostEnumType;
	status: ProcessStatus;
	logs: LogEntry[];
	pid: number | undefined;
	process: IPty | null;
	dataListener?: IDisposable;
	onExitListener?: IDisposable;
	exitCode: number | null;
	signal: string | null;
	verificationPattern?: RegExp;
	verificationTimeoutMs?: number;
	retryDelayMs?: number;
	maxRetries?: number;
	restartAttempts?: number;
	lastExitTimestamp?: number;
	lastCrashTime?: number;
	isRestarting?: boolean;
	stopRequested?: boolean;
	verificationTimer?: NodeJS.Timeout;
	logFilePath: string | null;
	logFileStream: fs.WriteStream | null;
	lastLogTimestampReturned?: number;
	mainDataListenerDisposable?: IDisposable;
	mainExitListenerDisposable?: IDisposable;
	partialLineBuffer?: string;
	os: OperatingSystemEnumType;
	isAwaitingInput?: boolean;
}
