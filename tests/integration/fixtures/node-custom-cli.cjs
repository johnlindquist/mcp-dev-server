#!/usr/bin/env node

console.error("[DEBUG] before prompt");
console.log("Type a secret word: ");
process.stdout.write("Type a secret word: ");
setTimeout(() => {
	console.error("[DEBUG] after prompt");
	process.stdin.once("data", (data) => {
		const word = data.toString().trim();
		console.log(`You typed: ${word}`);
		process.exit(0);
	});
}, 2000);
