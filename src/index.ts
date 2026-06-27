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

// Collect any extra args to pass through to kiro-cli acp.
// Everything except our own `--agent <name>` flag is forwarded transparently,
// so flags like `--trust-all-tools` can be placed directly in the editor's args.
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
  if (idx !== -1 && idx + 1 < process.argv.length) {
    return process.argv[idx + 1];
  }
  // Also support the `--flag=value` form.
  const prefixed = process.argv.find((a) => a.startsWith(`${flag}=`));
  return prefixed ? prefixed.slice(flag.length + 1) : undefined;
}

function getExtraArgs(): string[] {
  // Drop `node` and the script path, keep only the user-supplied args.
  const argv = process.argv.slice(2);

  const passthrough: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    // Our own flag — consume it and its value, don't forward it.
    if (arg === "--agent") {
      i++; // skip the value
      continue;
    }
    if (arg.startsWith("--agent=")) {
      continue;
    }

    // Explicit separator: everything after `--` goes straight to kiro-cli acp.
    if (arg === "--") {
      passthrough.push(...argv.slice(i + 1));
      break;
    }

    // Anything else (e.g. --trust-all-tools) is forwarded transparently.
    passthrough.push(arg);
  }

  return passthrough;
}
