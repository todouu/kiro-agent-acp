#!/usr/bin/env node

import { runAcp } from "./kiro-acp-agent.js";

// Parse CLI arguments
const agentName = getArgValue("--agent");

// stdout is used to send messages to the client (JSON-RPC)
// Redirect all console output to stderr to avoid interfering with ACP
console.log = console.error;
console.info = console.error;
console.warn = console.error;
console.debug = console.error;

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

const { connection, agent } = runAcp({ agentName });

async function shutdown() {
  if (agent) {
    await agent.dispose().catch((err) => {
      console.error("Error during cleanup:", err);
    });
  }
  process.exit(0);
}

// Exit cleanly when the ACP connection closes (e.g. stdin EOF)
connection.closed.then(shutdown);

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// Keep process alive while connection is open
process.stdin.resume();

/**
 * Extract a CLI argument value (e.g., --agent my-agent -> "my-agent")
 */
function getArgValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= process.argv.length) return undefined;
  return process.argv[idx + 1];
}
