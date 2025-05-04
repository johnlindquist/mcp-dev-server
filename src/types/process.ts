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
export type ShellStatus =
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
	source: "tool" | "shell";
}

/** Detailed information about a managed process. */
export interface ShellInfo {
	label: string;
	command: string;
	args: string[];
	cwd: string;
	host: HostEnumType;
	status: ShellStatus;
	logs: LogEntry[];
	pid: number | undefined;
	shell: IPty | null;
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
	idleFlushTimer?: NodeJS.Timeout;
	os: OperatingSystemEnumType;
	isProbablyAwaitingInput?: boolean;
	osc133Buffer?: string;
}
