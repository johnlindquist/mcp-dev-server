import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
		globalSetup: ["./tests/integration/global.setup.ts"],
		testTimeout: 40000,
		globals: true,
	},
});
