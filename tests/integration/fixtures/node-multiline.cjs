#!/usr/bin/env node

const readline = require("node:readline");
const rl = readline.createInterface({
	input: process.stdin,
	output: process.stdout,
});

console.error("[DEBUG] before first prompt");
console.log("Username: ");
rl.output.write("Username: ");
setTimeout(() => {
	console.error("[DEBUG] after first prompt");
	rl.question("", (username) => {
		console.error("[DEBUG] before second prompt");
		console.log("Password: ");
		rl.output.write("Password: ");
		setTimeout(() => {
			console.error("[DEBUG] after second prompt");
			rl.question("", (password) => {
				console.log(
					`Welcome, ${username}! (Password: ${password.length} chars)`,
				);
				rl.close();
			});
		}, 2000);
	});
}, 2000);
