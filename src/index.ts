#!/usr/bin/env node

/**
 * kiro-agent-acp: A Zed ACP adapter for Kiro CLI
 *
 * This is a transparent proxy that sits between Zed (ACP client) and kiro-cli acp (ACP agent).
 * It intercepts specific ACP messages to inject configuration options for:
 * - Model selection (Auto, Sonnet, Opus, Haiku, DeepSeek, Qwen, etc.)
 * - Agent/mode switching (Default, Architect, Ask, Code)
 * - Thinking/effort level control (Low, Medium, High, Max)
 *
 * All other ACP messages pass through transparently.
 */

import { KiroAcpProxy } from "./proxy.js";

// Parse CLI arguments
const agentArg = getArgValue("--agent");

const proxy = new KiroAcpProxy({ agent: agentArg });

process.on("SIGTERM", () => {
  proxy.shutdown();
  process.exit(0);
});

process.on("SIGINT", () => {
  proxy.shutdown();
  process.exit(0);
});

process.on("unhandledRejection", (reason) => {
  process.stderr.write(`[kiro-acp-proxy] Unhandled rejection: ${reason}\n`);
});

// Start the proxy
proxy.start();

// -- Helpers --

function getArgValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= process.argv.length) return undefined;
  return process.argv[idx + 1];
}
