import { promisify } from "node:util";
import treeKill from "tree-kill";

// This file previously contained process lifecycle functions (handleExit, etc.)
// which have been moved to src/process/*.ts (e.g., retry.ts).
// Keeping killProcessTree here for now if it's needed by other parts, otherwise this can be deleted.

/**
 * Promisified version of tree-kill.
 * Used for forcefully terminating process trees.
 */
export const killProcessTree = promisify(treeKill);
