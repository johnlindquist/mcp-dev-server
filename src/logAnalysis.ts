import { NO_NOTABLE_EVENTS_MSG } from "./constants/messages.js";

export interface ChangeSummary {
	message: string;
	errors: string[];
	warnings: string[];
	urls: string[];
	prompts: string[];
}

export function analyseLogs(logs: string[]): ChangeSummary {
	const errors = logs.filter((l) => /\b(err(or)?|exception|fatal)\b/i.test(l));
	const warnings = logs.filter((l) => /\bwarn(ing)?\b/i.test(l));
	const urls = logs.filter((l) => /(https?:\/\/[^\s]+)/i.test(l));
	const prompts = logs.filter((l) =>
		/(?:\?|\binput\b|\bpassword\b).*[:?]\s*$/i.test(l),
	);

	const notable = [...errors, ...warnings, ...urls, ...prompts];
	const slice = (arr: string[]) =>
		arr
			.slice(0, 3) // keep context light
			.map((l) => `• ${l.trim()}`);

	const bulletLines = [
		errors.length ? `❌ Errors (${errors.length})` : null,
		warnings.length ? `⚠️ Warnings (${warnings.length})` : null,
		urls.length ? `🔗 URLs (${urls.length})` : null,
		prompts.length ? `⌨️ Prompts (${prompts.length})` : null,
	].filter(Boolean);

	const headline = bulletLines.length
		? `Since last check: ${bulletLines.join(", ")}.`
		: NO_NOTABLE_EVENTS_MSG;

	return {
		message: [headline, ...slice(notable)].join("\n"),
		errors,
		warnings,
		urls,
		prompts,
	};
}
