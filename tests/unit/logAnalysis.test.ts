import { describe, expect, it } from "vitest";
import { analyseLogs } from "../../src/logAnalysis";

describe("analyseLogs", () => {
	it("summarises a mixed bag of logs", () => {
		const summary = analyseLogs([
			"Server running at http://localhost:3000",
			"WARNING: low disk space",
			"Error: connection refused",
			"Enter admin password: ",
		]);

		expect(summary.message).toMatch(/Errors \(1\)/);
		expect(summary.message).toMatch(/Warnings \(1\)/);
		expect(summary.message).toMatch(/URLs \(1\)/);
		expect(summary.message).toMatch(/Prompts \(1\)/);
		expect(summary.message).toMatch(
			/Since last check: ❌ Errors \(1\), ⚠️ Warnings \(1\), 🔗 URLs \(1\), ⌨️ Prompts \(1\)\./,
		);
		const bulletPoints = summary.message.split("\n").slice(1);
		expect(bulletPoints).toHaveLength(3);
		expect(bulletPoints[0]).toBe("• Error: connection refused");
		expect(bulletPoints[1]).toBe("• WARNING: low disk space");
		expect(bulletPoints[2]).toBe("• Server running at http://localhost:3000");
	});

	it("handles no notable events", () => {
		const summary = analyseLogs([
			"Just a regular log line",
			"Another normal message",
		]);
		expect(summary.message).toBe("No notable events since last check.");
		expect(summary.errors).toHaveLength(0);
		expect(summary.warnings).toHaveLength(0);
		expect(summary.urls).toHaveLength(0);
		expect(summary.prompts).toHaveLength(0);
	});

	it("handles multiple items of the same type", () => {
		const summary = analyseLogs([
			"Error: Thing 1 failed",
			"error: Thing 2 failed",
			"http://example.com",
			"https://test.com",
		]);
		expect(summary.message).toMatch(/Errors \(2\)/);
		expect(summary.message).toMatch(/URLs \(2\)/);
		expect(summary.message).not.toMatch(/Warnings \(\d+\)/);
		expect(summary.message).not.toMatch(/Prompts \(\d+\)/);
		expect(summary.errors).toHaveLength(2);
		expect(summary.urls).toHaveLength(2);
	});

	it("limits bullet points to 3", () => {
		const summary = analyseLogs([
			"Error 1",
			"Error 2",
			"Error 3",
			"Error 4",
			"Warning 1",
		]);
		expect(summary.message).toMatch(/Errors \(4\)/);
		expect(summary.message).toMatch(/Warnings \(1\)/);
		const bulletPoints = summary.message.split("\n").slice(1); // Get lines after headline
		expect(bulletPoints).toHaveLength(3);
		expect(bulletPoints[0]).toBe("• Error 1");
		expect(bulletPoints[1]).toBe("• Error 2");
		expect(bulletPoints[2]).toBe("• Error 3"); // Only first 3 notable lines shown
	});
});
