import { ChildProcess, spawn } from "node:child_process";
import * as readline from "node:readline";
import * as os from "node:os";
import * as path from "node:path";
import {
  MODELS,
  AGENTS,
  THINKING_LEVELS,
  DEFAULT_MODEL,
  DEFAULT_AGENT,
  DEFAULT_THINKING,
} from "./config.js";

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
 * ACP Session Config Option structure
 */
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
 * Current configuration state per session
 */
interface SessionConfig {
  model: string;
  agent: string;
  thinking: string;
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
 * The ACP Proxy that sits between Zed and kiro-cli acp.
 *
 * It intercepts ACP messages to:
 * 1. Inject configOptions (model, agent, thinking) into session/new responses
 * 2. Handle session/set_config_option to switch model/agent/thinking
 * 3. Pass everything else through transparently
 */
export class KiroAcpProxy {
  private kiroProcess: ChildProcess | null = null;
  private sessionConfigs: Map<string, SessionConfig> = new Map();
  private pendingRequests: Map<string | number, { method: string }> = new Map();
  private kiroOutputBuffer: string = "";
  private stdinReader: readline.Interface | null = null;
  private started = false;
  private agentArg?: string;

  constructor(options?: { agent?: string }) {
    this.agentArg = options?.agent;
  }

  /**
   * Start the proxy - spawns kiro-cli acp and wires up stdin/stdout piping.
   */
  start(): void {
    if (this.started) return;
    this.started = true;

    const kiroPath = resolveKiroCliPath();
    const args = ["acp"];

    if (this.agentArg) {
      args.push("--agent", this.agentArg);
    }

    log(`Starting: ${kiroPath} ${args.join(" ")}`);

    // Spawn kiro-cli acp subprocess
    this.kiroProcess = spawn(kiroPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        KIRO_NON_INTERACTIVE: "1",
      },
    });

    // Handle kiro-cli stdout → parse → maybe modify → write to our stdout (Zed)
    this.kiroProcess.stdout?.on("data", (data: Buffer) => {
      this.handleKiroOutput(data.toString());
    });

    // Forward kiro-cli stderr to our stderr
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

    // Read stdin (from Zed) line by line and forward/intercept
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
   * Handle input from the client (Zed) - intercept or forward to kiro-cli.
   */
  private handleClientInput(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      // Not valid JSON, forward as-is
      this.writeToKiro(line);
      return;
    }

    // Intercept session/set_config_option requests
    if (isRequest(msg) && msg.method === "session/set_config_option") {
      this.handleSetConfigOption(msg as JsonRpcRequest);
      return;
    }

    // Track requests so we can intercept their responses
    if (isRequest(msg) && msg.id !== undefined && msg.id !== null) {
      this.pendingRequests.set(msg.id, { method: msg.method });
    }

    // Forward everything else to kiro-cli
    this.writeToKiro(line);
  }

  /**
   * Handle output from kiro-cli - intercept or forward to Zed.
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
        // Not JSON, forward as-is
        this.writeToClient(line);
        continue;
      }

      // Check if this is a response to a tracked request
      if (isResponse(msg) && msg.id !== undefined && msg.id !== null) {
        const pending = this.pendingRequests.get(msg.id);
        if (pending) {
          this.pendingRequests.delete(msg.id);

          // Intercept session/new and session/load responses to inject configOptions
          if (
            (pending.method === "session/new" || pending.method === "session/load") &&
            msg.result
          ) {
            msg = this.injectConfigOptions(msg as JsonRpcResponse, pending.method);
          }

          // Intercept initialize response to advertise config capabilities
          if (pending.method === "initialize" && msg.result) {
            msg = this.enhanceInitializeResponse(msg as JsonRpcResponse);
          }
        }
      }

      this.writeToClient(JSON.stringify(msg));
    }
  }

  /**
   * Handle session/set_config_option - we handle this ourselves without forwarding.
   */
  private handleSetConfigOption(request: JsonRpcRequest): void {
    const params = request.params as {
      sessionId?: string;
      configId?: string;
      value?: string;
    };

    const sessionId = params?.sessionId;
    const configId = params?.configId;
    const value = params?.value;

    if (!sessionId || !configId || !value) {
      this.sendErrorResponse(request.id!, -32602, "Invalid params");
      return;
    }

    // Get or create session config
    let config = this.sessionConfigs.get(sessionId);
    if (!config) {
      config = { model: DEFAULT_MODEL, agent: DEFAULT_AGENT, thinking: DEFAULT_THINKING };
      this.sessionConfigs.set(sessionId, config);
    }

    // Apply the config change
    switch (configId) {
      case "model":
        if (MODELS.some((m) => m.value === value)) {
          config.model = value;
          // Send /model command to kiro-cli to actually switch the model
          this.sendSlashCommandToKiro(sessionId, `/model ${value}`);
        } else {
          this.sendErrorResponse(request.id!, -32602, `Unknown model: ${value}`);
          return;
        }
        break;

      case "agent":
        if (AGENTS.some((a) => a.value === value)) {
          config.agent = value;
          // Agent switching would require restarting the session in kiro-cli
          // For now, send as a mode hint
          this.sendSlashCommandToKiro(sessionId, `/agent ${value}`);
        } else {
          this.sendErrorResponse(request.id!, -32602, `Unknown agent: ${value}`);
          return;
        }
        break;

      case "thinking":
        if (THINKING_LEVELS.some((t) => t.value === value)) {
          config.thinking = value;
          // Send /effort command to kiro-cli
          this.sendSlashCommandToKiro(sessionId, `/effort ${value}`);
        } else {
          this.sendErrorResponse(request.id!, -32602, `Unknown thinking level: ${value}`);
          return;
        }
        break;

      default:
        // Unknown config option - forward to kiro-cli
        this.writeToKiro(JSON.stringify(request));
        return;
    }

    // Respond with the full config state
    const response: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: request.id!,
      result: {
        configOptions: this.buildConfigOptions(config),
      },
    };
    this.writeToClient(JSON.stringify(response));
  }

  /**
   * Inject configOptions into session/new or session/load responses.
   */
  private injectConfigOptions(response: JsonRpcResponse, _method: string): JsonRpcResponse {
    const result = response.result as Record<string, unknown>;
    const sessionId = result?.sessionId as string | undefined;

    if (!sessionId) return response;

    // Initialize session config
    const config: SessionConfig = {
      model: DEFAULT_MODEL,
      agent: DEFAULT_AGENT,
      thinking: DEFAULT_THINKING,
    };
    this.sessionConfigs.set(sessionId, config);

    // Inject our configOptions
    const existingOptions = (result.configOptions as ConfigOption[]) ?? [];
    const ourOptions = this.buildConfigOptions(config);

    result.configOptions = [...ourOptions, ...existingOptions];

    return { ...response, result };
  }

  /**
   * Enhance the initialize response to ensure config option support is advertised.
   */
  private enhanceInitializeResponse(response: JsonRpcResponse): JsonRpcResponse {
    const result = response.result as Record<string, unknown>;
    if (!result) return response;

    // Ensure agentCapabilities includes sessionCapabilities
    const caps = (result.agentCapabilities ?? {}) as Record<string, unknown>;
    const sessionCaps = (caps.sessionCapabilities ?? {}) as Record<string, unknown>;

    // Advertise close + list if not already
    if (!sessionCaps.close) sessionCaps.close = {};
    if (!sessionCaps.list) sessionCaps.list = {};

    caps.sessionCapabilities = sessionCaps;
    result.agentCapabilities = caps;

    return { ...response, result };
  }

  /**
   * Build the full set of config options.
   */
  private buildConfigOptions(config: SessionConfig): ConfigOption[] {
    return [
      {
        id: "model",
        name: "Model",
        description: "Select the AI model for this session",
        category: "model",
        type: "select",
        currentValue: config.model,
        options: MODELS,
      },
      {
        id: "agent",
        name: "Agent",
        description: "Select the agent mode",
        category: "mode",
        type: "select",
        currentValue: config.agent,
        options: AGENTS,
      },
      {
        id: "thinking",
        name: "Thinking",
        description: "Control reasoning depth",
        category: "thought_level",
        type: "select",
        currentValue: config.thinking,
        options: THINKING_LEVELS,
      },
    ];
  }

  /**
   * Send a slash command to kiro-cli by injecting a session/prompt request.
   * This is how we actually switch model/effort/agent at runtime.
   */
  private sendSlashCommandToKiro(sessionId: string, command: string): void {
    // We send the slash command as a regular prompt that kiro-cli will interpret
    const promptRequest: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: `internal_${Date.now()}`,
      method: "session/prompt",
      params: {
        sessionId,
        prompt: [{ type: "text", text: command }],
      },
    };
    // Track it so we swallow the response
    this.pendingRequests.set(promptRequest.id!, { method: "__internal_command" });
    this.writeToKiro(JSON.stringify(promptRequest));
  }

  /**
   * Send an error response to the client.
   */
  private sendErrorResponse(id: string | number, code: number, message: string): void {
    const response: JsonRpcResponse = {
      jsonrpc: "2.0",
      id,
      error: { code, message },
    };
    this.writeToClient(JSON.stringify(response));
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
   * Write a line to our stdout (back to Zed).
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

// -- Helpers --

function isRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return "method" in msg && "id" in msg;
}

function isResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return ("result" in msg || "error" in msg) && "id" in msg && !("method" in msg);
}

function log(...args: unknown[]): void {
  process.stderr.write(`[kiro-acp-proxy] ${args.join(" ")}\n`);
}
