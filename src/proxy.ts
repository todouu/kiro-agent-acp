import { ChildProcess, spawn } from "node:child_process";
import * as readline from "node:readline";

/**
 * JSON-RPC message types
 */
interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface ConfigOption {
  id: string;
  name: string;
  description?: string;
  category?: string;
  type: "select";
  currentValue: string;
  options: Array<{ value: string; name: string; description?: string }>;
}

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
 * ACP proxy between editor (Zed/JetBrains) and kiro-cli acp.
 *
 * kiro-cli supports session/set_model and session/set_mode but does NOT
 * return configOptions in session/new responses. Editors need configOptions
 * to show dropdown selectors.
 *
 * This proxy:
 * 1. Intercepts session/new responses → injects configOptions
 * 2. Intercepts session/set_config_option → translates to kiro-cli methods
 * 3. Passes everything else through transparently
 */
export class KiroAcpProxy {
  private kiroProcess: ChildProcess | null = null;
  private kiroOutputBuffer: string = "";
  private stdinReader: readline.Interface | null = null;
  private started = false;
  private agentArg?: string;
  private extraArgs: string[];

  /** Track pending requests to intercept their responses */
  private pendingRequests: Map<string | number, { method: string }> = new Map();

  /** Track sessions and their current config */
  private sessions: Map<string, { model: string; thinking: string }> = new Map();

  /** Internal request IDs to swallow responses */
  private internalRequestIds: Set<string | number> = new Set();
  private internalIdCounter = 900000;

  constructor(options?: { agent?: string; extraArgs?: string[] }) {
    this.agentArg = options?.agent;
    this.extraArgs = options?.extraArgs ?? [];
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    const kiroPath = resolveKiroCliPath();
    const args = ["acp", ...this.extraArgs];

    if (this.agentArg) {
      args.push("--agent", this.agentArg);
    }

    log(`Starting: ${kiroPath} ${args.join(" ")}`);

    this.kiroProcess = spawn(kiroPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    this.kiroProcess.stdout?.on("data", (data: Buffer) => {
      try {
        this.handleKiroOutput(data.toString());
      } catch (err) {
        log(`Error handling kiro output: ${err}`);
      }
    });

    this.kiroProcess.stderr?.on("data", (data: Buffer) => {
      log(data.toString().trimEnd());
    });

    this.kiroProcess.on("error", (err) => {
      log(`kiro-cli error: ${err.message}`);
      process.exit(1);
    });

    this.kiroProcess.on("exit", (code) => {
      log(`kiro-cli exited: ${code}`);
      process.exit(code ?? 0);
    });

    this.stdinReader = readline.createInterface({ input: process.stdin, terminal: false });
    this.stdinReader.on("line", (line) => {
      try {
        this.handleClientInput(line);
      } catch (err) {
        log(`Error handling client input: ${err}`);
      }
    });
    this.stdinReader.on("close", () => this.shutdown());
  }

  /**
   * Handle input from the editor.
   */
  private handleClientInput(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      this.writeToKiro(trimmed);
      return;
    }

    // Intercept session/set_config_option
    if (this.isRequest(msg) && msg.method === "session/set_config_option") {
      this.handleSetConfigOption(msg);
      return;
    }

    // Track requests to intercept responses
    if (this.isRequest(msg) && msg.id != null) {
      this.pendingRequests.set(msg.id, { method: msg.method! });
    }

    // Forward to kiro-cli
    this.writeToKiro(trimmed);
  }

  /**
   * Handle output from kiro-cli.
   */
  private handleKiroOutput(data: string): void {
    this.kiroOutputBuffer += data;
    const lines = this.kiroOutputBuffer.split("\n");
    this.kiroOutputBuffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        this.writeToClient(trimmed);
        continue;
      }

      // Swallow responses to internal requests
      if (this.isResponse(msg) && msg.id != null && this.internalRequestIds.has(msg.id)) {
        this.internalRequestIds.delete(msg.id);
        continue;
      }

      // Intercept responses to tracked requests
      if (this.isResponse(msg) && msg.id != null) {
        const pending = this.pendingRequests.get(msg.id);
        if (pending) {
          this.pendingRequests.delete(msg.id);

          if (pending.method === "session/new" && msg.result) {
            msg = this.injectConfigOptions(msg);
          }
        }
      }

      this.writeToClient(JSON.stringify(msg));
    }
  }

  /**
   * Inject configOptions into session/new response.
   */
  private injectConfigOptions(msg: JsonRpcMessage): JsonRpcMessage {
    try {
      const result = { ...(msg.result as Record<string, unknown>) };
      const sessionId = result.sessionId as string;

      if (!sessionId) return msg;

      // Track session
      this.sessions.set(sessionId, { model: "auto", thinking: "medium" });

      // Build configOptions for the editor to show dropdowns
      const configOptions: ConfigOption[] = [
        {
          id: "model",
          name: "Model",
          description: "Select AI model",
          category: "model",
          type: "select",
          currentValue: "auto",
          options: [
            { value: "auto", name: "Auto", description: "Kiro routes to optimal model" },
            { value: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
            { value: "claude-opus-4", name: "Claude Opus 4" },
            { value: "claude-haiku-4", name: "Claude Haiku 4" },
            { value: "deepseek-r1", name: "DeepSeek R1" },
            { value: "qwen-3", name: "Qwen 3" },
          ],
        },
        {
          id: "thinking",
          name: "Thinking",
          description: "Control reasoning depth (/effort)",
          category: "thought_level",
          type: "select",
          currentValue: "medium",
          options: [
            { value: "low", name: "Low", description: "Fast responses" },
            { value: "medium", name: "Medium", description: "Balanced" },
            { value: "high", name: "High", description: "Deep reasoning" },
            { value: "max", name: "Max", description: "Maximum reasoning" },
          ],
        },
      ];

      // Merge: our options first, then any existing from kiro
      const existing = (result.configOptions as ConfigOption[]) ?? [];
      result.configOptions = [...configOptions, ...existing];

      // Also inject modes if kiro didn't provide them
      if (!result.modes) {
        result.modes = {
          currentModeId: "code",
          availableModes: [
            { id: "code", name: "Code", description: "Write and modify code" },
            { id: "ask", name: "Ask", description: "Answer questions without changes" },
            { id: "architect", name: "Architect", description: "Design and plan" },
          ],
        };
      }

      return { ...msg, result };
    } catch (err) {
      log(`Error injecting configOptions: ${err}`);
      return msg;
    }
  }

  /**
   * Handle session/set_config_option from the editor.
   */
  private handleSetConfigOption(msg: JsonRpcMessage): void {
    const params = msg.params as {
      sessionId?: string;
      configId?: string;
      value?: string;
    };

    const { sessionId, configId, value } = params ?? {};

    if (!sessionId || !configId || !value) {
      this.writeToClient(
        JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32602, message: "Invalid params" },
        }),
      );
      return;
    }

    const config = this.sessions.get(sessionId) ?? { model: "auto", thinking: "medium" };

    switch (configId) {
      case "model": {
        config.model = value;
        this.sessions.set(sessionId, config);
        // Send session/set_model to kiro-cli
        const reqId = ++this.internalIdCounter;
        this.internalRequestIds.add(reqId);
        this.writeToKiro(
          JSON.stringify({
            jsonrpc: "2.0",
            id: reqId,
            method: "session/set_model",
            params: { sessionId, modelId: value },
          }),
        );
        break;
      }

      case "thinking": {
        config.thinking = value;
        this.sessions.set(sessionId, config);
        // Send /effort via prompt (safest way)
        const reqId = ++this.internalIdCounter;
        this.internalRequestIds.add(reqId);
        this.writeToKiro(
          JSON.stringify({
            jsonrpc: "2.0",
            id: reqId,
            method: "session/prompt",
            params: {
              sessionId,
              prompt: [{ type: "text", text: `/effort ${value}` }],
            },
          }),
        );
        break;
      }

      default: {
        // Unknown option — forward to kiro-cli as-is
        this.pendingRequests.set(msg.id!, { method: "session/set_config_option" });
        this.writeToKiro(JSON.stringify(msg));
        return;
      }
    }

    // Respond to editor immediately with updated config state
    this.writeToClient(
      JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          configOptions: [
            {
              id: "model",
              name: "Model",
              category: "model",
              type: "select",
              currentValue: config.model,
              options: [
                { value: "auto", name: "Auto" },
                { value: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
                { value: "claude-opus-4", name: "Claude Opus 4" },
                { value: "claude-haiku-4", name: "Claude Haiku 4" },
                { value: "deepseek-r1", name: "DeepSeek R1" },
                { value: "qwen-3", name: "Qwen 3" },
              ],
            },
            {
              id: "thinking",
              name: "Thinking",
              category: "thought_level",
              type: "select",
              currentValue: config.thinking,
              options: [
                { value: "low", name: "Low" },
                { value: "medium", name: "Medium" },
                { value: "high", name: "High" },
                { value: "max", name: "Max" },
              ],
            },
          ],
        },
      }),
    );
  }

  private writeToKiro(line: string): void {
    if (this.kiroProcess?.stdin?.writable) {
      this.kiroProcess.stdin.write(line + "\n");
    }
  }

  private writeToClient(line: string): void {
    process.stdout.write(line + "\n");
  }

  private isRequest(msg: JsonRpcMessage): boolean {
    return "method" in msg && "id" in msg && msg.id != null;
  }

  private isResponse(msg: JsonRpcMessage): boolean {
    return ("result" in msg || "error" in msg) && !("method" in msg);
  }

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
  process.stderr.write(`[kiro-acp] ${args.join(" ")}\n`);
}
