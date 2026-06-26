import { ChildProcess, spawn } from "node:child_process";
import * as readline from "node:readline";

/**
 * JSON-RPC message types
 */
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

/**
 * Resolves the path to the kiro-cli executable.
 */
function resolveKiroCliPath(): string {
  if (process.env.KIRO_CLI_PATH) {
    return process.env.KIRO_CLI_PATH;
  }
  return "kiro-cli";
}

/**
 * A transparent ACP proxy between the editor (Zed/JetBrains) and kiro-cli acp.
 *
 * Since kiro-cli acp already implements the full ACP protocol — including
 * configOptions for model selection, agent switching, and thinking levels —
 * this proxy simply passes all messages through transparently.
 *
 * The proxy exists to:
 * 1. Provide a convenient npx-installable entry point for the ACP Registry
 * 2. Allow future enhancements on top of kiro-cli acp without modifying kiro-cli itself
 * 3. Handle process lifecycle (spawning kiro-cli, piping stdio, clean shutdown)
 */
export class KiroAcpProxy {
  private kiroProcess: ChildProcess | null = null;
  private kiroOutputBuffer: string = "";
  private stdinReader: readline.Interface | null = null;
  private started = false;
  private agentArg?: string;
  private extraArgs: string[];

  constructor(options?: { agent?: string; extraArgs?: string[] }) {
    this.agentArg = options?.agent;
    this.extraArgs = options?.extraArgs ?? [];
  }

  /**
   * Start the proxy - spawns kiro-cli acp and wires up stdin/stdout piping.
   */
  start(): void {
    if (this.started) return;
    this.started = true;

    const kiroPath = resolveKiroCliPath();
    const args = ["acp", ...this.extraArgs];

    if (this.agentArg) {
      args.push("--agent", this.agentArg);
    }

    log(`Starting: ${kiroPath} ${args.join(" ")}`);

    // Spawn kiro-cli acp subprocess
    this.kiroProcess = spawn(kiroPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
      },
    });

    // Handle kiro-cli stdout → forward to our stdout (the editor)
    this.kiroProcess.stdout?.on("data", (data: Buffer) => {
      this.handleKiroOutput(data.toString());
    });

    // Forward kiro-cli stderr to our stderr (for debugging)
    this.kiroProcess.stderr?.on("data", (data: Buffer) => {
      log(data.toString().trimEnd());
    });

    this.kiroProcess.on("error", (err) => {
      log(`kiro-cli process error: ${err.message}`);
      process.exit(1);
    });

    this.kiroProcess.on("exit", (code) => {
      log(`kiro-cli exited with code: ${code}`);
      process.exit(code ?? 0);
    });

    // Read stdin (from the editor) line by line and forward to kiro-cli
    this.stdinReader = readline.createInterface({
      input: process.stdin,
      terminal: false,
    });

    this.stdinReader.on("line", (line) => {
      this.handleClientInput(line);
    });

    this.stdinReader.on("close", () => {
      log("stdin closed, shutting down");
      this.shutdown();
    });
  }

  /**
   * Handle input from the client (editor) — forward directly to kiro-cli.
   * All ACP messages pass through transparently.
   */
  private handleClientInput(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    this.writeToKiro(trimmed);
  }

  /**
   * Handle output from kiro-cli — forward directly to the editor.
   * Handles line buffering for ndjson stream.
   */
  private handleKiroOutput(data: string): void {
    this.kiroOutputBuffer += data;
    const lines = this.kiroOutputBuffer.split("\n");
    this.kiroOutputBuffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      this.writeToClient(trimmed);
    }
  }

  /**
   * Write a line to kiro-cli stdin.
   */
  private writeToKiro(line: string): void {
    if (this.kiroProcess?.stdin?.writable) {
      this.kiroProcess.stdin.write(line + "\n");
    }
  }

  /**
   * Write a line to our stdout (back to the editor).
   */
  private writeToClient(line: string): void {
    process.stdout.write(line + "\n");
  }

  /**
   * Graceful shutdown.
   */
  shutdown(): void {
    if (this.kiroProcess && !this.kiroProcess.killed) {
      this.kiroProcess.kill("SIGTERM");
      setTimeout(() => {
        if (this.kiroProcess && !this.kiroProcess.killed) {
          this.kiroProcess.kill("SIGKILL");
        }
      }, 3000);
    }
    this.stdinReader?.close();
  }
}

function log(...args: unknown[]): void {
  process.stderr.write(`[kiro-agent-acp] ${args.join(" ")}\n`);
}
