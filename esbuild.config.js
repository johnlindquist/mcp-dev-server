import esbuild from "esbuild";

esbuild
	.build({
		entryPoints: ["src/index.ts"],
		bundle: true,
		outfile: "build/index.mjs",
		platform: "node",
		format: "esm",
		external: ["node-pty", "tree-kill"],
		logLevel: "info",
	})
	.catch(() => process.exit(1));
