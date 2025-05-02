import { describe, expect, it } from "vitest";
import { detectPromptInLogs } from "../../src/process/detectPrompt";

describe("detectPromptInLogs", () => {
	it("detects OSC 133 prompt sequence", () => {
		const logs = ["Some output", "\x1b]133;B\x07 Waiting for input..."];
		const result = detectPromptInLogs(logs);
		expect(result.isWaiting).toBe(true);
		expect(result.matchedLine).toContain("\x1b]133;B");
	});

	it("detects common shell prompt patterns", () => {
		const logs = ["Welcome to the shell!", "user@host:~$ "];
		const result = detectPromptInLogs(logs);
		expect(result.isWaiting).toBe(true);
		expect(result.matchedLine).toContain("$ ");
	});

	it("detects custom prompt with question mark", () => {
		const logs = ["Do you want to continue? "];
		const result = detectPromptInLogs(logs);
		expect(result.isWaiting).toBe(true);
		expect(result.matchedLine).toContain("continue?");
	});

	it("returns false if no prompt is present", () => {
		const logs = ["Process started successfully.", "All systems go."];
		const result = detectPromptInLogs(logs);
		expect(result.isWaiting).toBe(false);
		expect(result.matchedLine).toBeUndefined();
	});
});
