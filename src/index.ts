#!/usr/bin/env node

/**
 * kiro-agent-acp: ACP Registry entry point for Kiro CLI
 *
 * This is a thin transparent wrapper around `kiro-cli acp`.
 * It exists to provide a convenient npx-installable package for the ACP Registry,
 * so editors like Zed and JetBrains can install Kiro with one click.
 *
 * kiro-cli acp already handles everything natively:
 * - Model selection (configOptions with category "model")
 * - Agent switching (configOptions with category "mode")
 * - Thinking/effort level (configOptions with category "thought_level")
 * - Session management, tool calls, slash commands, etc.
 *
 * All ACP messages pass through this proxy transparently.
 */

import { KiroAcpProxy } from "./proxy.js";

// Parse CLI arguments
const agentArg = getArgValue("--agent");

// Collect any extra args to pass through to kiro-cli acp
const extraArgs = getExtraArgs();

const proxy = new KiroAcpProxy({ agent: agentArg, extraArgs });

process.on("SIGTERM", () => {
  proxy.shutdown();
  process.exit(0);
});

process.on("SIGINT", () => {
  proxy.shutdown();
  process.exit(0);
});

process.on("unhandledRejection", (reason) => {
  process.stderr.write(`[kiro-agent-acp] Unhandled rejection: ${reason}\n`);
});

// Start the proxy
proxy.start();

// -- Helpers --

function getArgValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= process.argv.length) return undefined;
  return process.argv[idx + 1];
}

function getExtraArgs(): string[] {
  // Pass through any args after -- to kiro-cli acp
  const separatorIdx = process.argv.indexOf("--");
  if (separatorIdx === -1) return [];
  return process.argv.slice(separatorIdx + 1);
}
