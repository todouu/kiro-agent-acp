import { ChildProcess, spawn } from "node:child_process";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import type { Logger } from "./utils.js";

/**
 * Resolves the path to the kiro-cli executable.
 *
 * Checks in order:
 * 1. KIRO_CLI_PATH environment variable
 * 2. Common install locations
 * 3. Falls back to "kiro-cli" (relies on PATH)
 */
export function resolveKiroCliPath(): string {
  if (process.env.KIRO_CLI_PATH) {
    return process.env.KIRO_CLI_PATH;
  }

  // Common locations
  const home = os.homedir();
  const candidates: string[] = [];

  if (process.platform === "win32") {
    candidates.push(
      path.join(home, "AppData", "Local", "Programs", "kiro-cli", "kiro-cli.exe"),
      path.join(home, ".local", "bin", "kiro-cli.exe"),
    );
  } else {
    candidates.push(
      path.join(home, ".local", "bin", "kiro-cli"),
      "/usr/local/bin/kiro-cli",
      path.join(home, ".kiro", "bin", "kiro-cli"),
    );
  }

  // For now just rely on PATH resolution
  return "kiro-cli";
}

/**
 * Message types from kiro-cli JSON output
 */
export interface KiroMessage {
  type: "text" | "tool_use" | "tool_result" | "thinking" | "error" | "done" | "session_info";
  id?: string;
  content?: string;
  name?: string;
  input?: Record<string, unknown>;
  output?: string;
  is_error?: boolean;
  session_id?: string;
  title?: string;
}

/**
 * Represents a running kiro-cli session process.
 * Manages the lifecycle of the subprocess and communication with it.
 */
export class KiroProcess {
  private process: ChildProcess | null = null;
  private sessionId: string;
  private cwd: string;
  private logger: Logger;
  private outputBuffer: string = "";
  private messageCallbacks: Array<(msg: KiroMessage) => void> = [];
  private exitPromise: Promise<number | null> | null = null;
  private agentName?: string;

  constructor(options: { cwd: string; logger: Logger; agentName?: string }) {
    this.sessionId = randomUUID();
    this.cwd = options.cwd;
    this.logger = options.logger;
    this.agentName = options.agentName;
  }

  get id(): string {
    return this.sessionId;
  }

  get isRunning(): boolean {
    return this.process !== null && this.process.exitCode === null;
  }

  /**
   * Starts a kiro-cli process in chat mode with JSON output.
   */
  async start(): Promise<void> {
    const kiroPath = resolveKiroCliPath();
    const args = ["chat", "--output-format", "json", "--non-interactive"];

    if (this.agentName) {
      args.push("--agent", this.agentName);
    }

    this.logger.log(`Starting kiro-cli: ${kiroPath} ${args.join(" ")} in ${this.cwd}`);

    this.process = spawn(kiroPath, args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        // Ensure non-interactive mode
        KIRO_NON_INTERACTIVE: "1",
        // Pass through any authentication
        ...(process.env.KIRO_AUTH_TOKEN ? { KIRO_AUTH_TOKEN: process.env.KIRO_AUTH_TOKEN } : {}),
      },
    });

    // Handle stdout (JSON messages)
    this.process.stdout?.on("data", (data: Buffer) => {
      this.handleOutput(data.toString());
    });

    // Handle stderr (logs)
    this.process.stderr?.on("data", (data: Buffer) => {
      this.logger.error(`[kiro-cli stderr] ${data.toString().trim()}`);
    });

    // Track process exit
    this.exitPromise = new Promise<number | null>((resolve) => {
      this.process!.on("exit", (code) => {
        this.logger.log(`kiro-cli process exited with code: ${code}`);
        resolve(code);
      });
    });

    this.process.on("error", (err) => {
      this.logger.error(`kiro-cli process error: ${err.message}`);
    });
  }

  /**
   * Sends a prompt to the kiro-cli process.
   */
  async sendPrompt(prompt: string): Promise<void> {
    if (!this.process || !this.process.stdin) {
      throw new Error("kiro-cli process is not running");
    }

    // Write the prompt to stdin followed by newline
    const message = prompt.replace(/\n/g, "\\n") + "\n";
    this.process.stdin.write(message);
  }

  /**
   * Sends a slash command to the kiro-cli process.
   */
  async sendCommand(command: string, input?: string): Promise<void> {
    const fullCommand = input ? `${command} ${input}` : command;
    return this.sendPrompt(fullCommand);
  }

  /**
   * Register a callback to receive parsed messages.
   */
  onMessage(callback: (msg: KiroMessage) => void): () => void {
    this.messageCallbacks.push(callback);
    return () => {
      const idx = this.messageCallbacks.indexOf(callback);
      if (idx >= 0) this.messageCallbacks.splice(idx, 1);
    };
  }

  /**
   * Handle raw output from the process, parsing JSON lines.
   */
  private handleOutput(data: string): void {
    this.outputBuffer += data;
    const lines = this.outputBuffer.split("\n");
    // Keep the last partial line in the buffer
    this.outputBuffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const msg = JSON.parse(trimmed) as KiroMessage;
        for (const cb of this.messageCallbacks) {
          try {
            cb(msg);
          } catch (err) {
            this.logger.error(`Message callback error: ${err}`);
          }
        }
      } catch {
        // Not JSON - treat as plain text output
        const textMsg: KiroMessage = { type: "text", content: trimmed };
        for (const cb of this.messageCallbacks) {
          try {
            cb(textMsg);
          } catch (err) {
            this.logger.error(`Message callback error: ${err}`);
          }
        }
      }
    }
  }

  /**
   * Interrupt the current operation (send SIGINT).
   */
  interrupt(): void {
    if (this.process && !this.process.killed) {
      this.process.kill("SIGINT");
    }
  }

  /**
   * Terminate the kiro-cli process.
   */
  async dispose(): Promise<void> {
    if (this.process && !this.process.killed) {
      this.process.kill("SIGTERM");

      // Give it a moment to clean up, then force kill
      const timeout = setTimeout(() => {
        if (this.process && !this.process.killed) {
          this.process.kill("SIGKILL");
        }
      }, 5000);

      await this.exitPromise;
      clearTimeout(timeout);
    }
    this.process = null;
  }
}
