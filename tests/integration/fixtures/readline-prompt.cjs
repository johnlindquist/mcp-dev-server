#!/usr/bin/env node

const readline = require("node:readline");

console.log("[DEBUG] isTTY:", process.stdin.isTTY);
console.log("[DEBUG] argv:", process.argv);
console.log("[DEBUG] TERM:", process.env.TERM);

console.log("[DEBUG] before rl.question");
const rl = readline.createInterface({
	input: process.stdin,
	output: process.stdout,
});

rl.question("Do you want to continue? (yes/no): ", (answer) => {
	console.log("[DEBUG] in rl.question callback");
	if (answer.toLowerCase() === "yes") {
		console.log("You selected YES.");
	} else if (answer.toLowerCase() === "no") {
		console.log("You selected NO.");
	} else {
		console.log("Invalid input. Please type yes or no.");
	}
	rl.close();
	console.log("[DEBUG] after rl.close");
	setTimeout(() => process.exit(0), 2000);
});
console.log("[DEBUG] after rl.question");
setTimeout(() => {}, 2000);
