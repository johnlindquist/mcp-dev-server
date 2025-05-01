feat: Switch to node-pty-prebuilt-multiarch

Replaces the `node-pty` dependency with `node-pty-prebuilt-multiarch`.

This change aims to resolve installation issues users encountered due to the native build requirements of `node-pty`, particularly inconsistencies with Node.js versions and node-gyp. The `node-pty-prebuilt-multiarch` package provides prebuilt binaries, simplifying the installation process across different platforms and environments.

Changes include:
- Updated `package.json` dependencies.
- Added a `postinstall` script (`pnpm rebuild`) to ensure the native addon is correctly located.
- Updated import paths in source files (`ptyManager.ts`, `types.ts`, `processLogic.ts`).
- Updated `esbuild.config.js` external dependencies.
- Simplified CI workflow (`.github/workflows/ci.yml`) by removing `node-pty` specific build/cache steps.
- Updated documentation (`README.md`, `.cursor/` files) to reflect the new dependency. 