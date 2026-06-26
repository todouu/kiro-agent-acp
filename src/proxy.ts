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
 * ACP proxy that sits between the editor (Zed/JetBrains) and kiro-cli acp.
 *
 * kiro-cli acp supports session/set_mode and session/set_model but does NOT
 * send configOptions in its session/new response. Editors like Zed need
 * configOptions to render dropdown selectors.
 *
 * This proxy:
 * 1. Intercepts session/new responses → injects configOptions
 * 2. After session creation, queries kiro-cli for real model/agent lists
 * 3. Sends config_option_update notifications with real data
 * 4. Intercepts session/set_config_option → translates to kiro-cli methods
 */
export class KiroAcpProxy {
  private kiroProcess: ChildProcess | null = null;
  private kiroOutputBuffer: string = "";
  private stdinReader: readline.Interface | null = null;
  private started = false;
  private agentArg?: string;
  private extraArgs: string[];

  /** Track pending requests to know which responses to intercept */
  private pendingRequests: Map<string | number, { method: string }> = new Map();

  /** Internal request counter for proxy-initiated requests */
  private internalIdCounter = 900000;

  /** Track sessions and their current config */
  private sessions: Map<string, { model: string; mode: string; thinking: string }> = new Map();

  /** Track internal request IDs to swallow their responses */
  private internalRequestIds: Set<string | number> = new Set();

  constructor(options?: { agent?: string; extraArgs?: string[] }) {
    this.agentArg = options?.agent;
    this.extraArgs = options?.extraArgs ?? [];
  }

  /**
   * Start the proxy.
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

    this.kiroProcess = spawn(kiroPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    this.kiroProcess.stdout?.on("data", (data: Buffer) => {
      this.handleKiroOutput(data.toString());
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
    this.stdinReader.on("line", (line) => this.handleClientInput(line));
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

    // Intercept session/set_config_option — we handle this ourselves
    if (isRequest(msg) && msg.method === "session/set_config_option") {
      this.handleSetConfigOption(msg);
      return;
    }

    // Track requests so we can intercept their responses
    if (isRequest(msg) && msg.id != null) {
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

      // Swallow responses to our internal requests
      if (isResponse(msg) && msg.id != null && this.internalRequestIds.has(msg.id)) {
        this.internalRequestIds.delete(msg.id);
        this.handleInternalResponse(msg);
        continue;
      }

      // Intercept responses to tracked requests
      if (isResponse(msg) && msg.id != null) {
        const pending = this.pendingRequests.get(msg.id);
        if (pending) {
          this.pendingRequests.delete(msg.id);

          if (pending.method === "session/new" && msg.result) {
            msg = this.handleSessionNewResponse(msg);
          }
        }
      }

      this.writeToClient(JSON.stringify(msg));
    }
  }

  /**
   * Intercept session/new response — inject configOptions for the editor.
   */
  private handleSessionNewResponse(msg: JsonRpcMessage): JsonRpcMessage {
    const result = msg.result as Record<string, unknown>;
    const sessionId = result?.sessionId as string;

    if (!sessionId) return msg;

    // Initialize session config
    this.sessions.set(sessionId, { model: "auto", mode: "default", thinking: "medium" });

    // Inject configOptions so Zed shows dropdown selectors
    // We start with placeholder options, then query kiro for real data
    const configOptions: ConfigOption[] = [
      {
        id: "model",
        name: "Model",
        description: "Select AI model",
        category: "model",
        type: "select",
        currentValue: "auto",
        options: [{ value: "auto", name: "Auto", description: "Loading models..." }],
      },
      {
        id: "thinking",
        name: "Thinking",
        description: "Reasoning depth",
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

    // Inject modes if kiro didn't provide them
    if (!result.modes) {
      result.modes = {
        currentModeId: "code",
        availableModes: [
          { id: "code", name: "Code", description: "Write and modify code" },
          { id: "ask", name: "Ask", description: "Answer questions without changes" },
        ],
      };
    }

    // Merge with any existing configOptions from kiro
    const existing = (result.configOptions as ConfigOption[]) ?? [];
    result.configOptions = [...configOptions, ...existing];

    // After returning the response, query kiro for real model list
    setTimeout(() => this.queryRealOptions(sessionId), 100);

    return { ...msg, result };
  }

  /**
   * Query kiro-cli for real model/agent options via slash commands.
   */
  private queryRealOptions(sessionId: string): void {
    // Use _kiro.dev/commands/options to get model autocomplete
    const modelReqId = this.nextInternalId();
    this.internalRequestIds.add(modelReqId);
    this.writeToKiro(
      JSON.stringify({
        jsonrpc: "2.0",
        id: modelReqId,
        method: "_kiro.dev/commands/options",
        params: { sessionId, command: "/model " },
      }),
    );
  }

  /**
   * Handle responses to our internal requests.
   */
  private handleInternalResponse(msg: JsonRpcMessage): void {
    // Parse model options from _kiro.dev/commands/options response
    if (msg.result) {
      const result = msg.result as { options?: Array<{ value: string; label?: string; description?: string }> };
      if (result.options && result.options.length > 0) {
        // Found real model list! Update all sessions.
        const modelOptions = result.options.map((opt) => ({
          value: opt.value,
          name: opt.label ?? opt.value,
          description: opt.description,
        }));

        // Send config_option_update to client for each session
        for (const [sessionId, config] of this.sessions) {
          const configOptions: ConfigOption[] = [
            {
              id: "model",
              name: "Model",
              description: "Select AI model",
              category: "model",
              type: "select",
              currentValue: config.model,
              options: modelOptions,
            },
            {
              id: "thinking",
              name: "Thinking",
              description: "Reasoning depth",
              category: "thought_level",
              type: "select",
              currentValue: config.thinking,
              options: [
                { value: "low", name: "Low", description: "Fast responses" },
                { value: "medium", name: "Medium", description: "Balanced" },
                { value: "high", name: "High", description: "Deep reasoning" },
                { value: "max", name: "Max", description: "Maximum reasoning" },
              ],
            },
          ];

          // Send config_option_update notification to editor
          this.writeToClient(
            JSON.stringify({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId,
                update: {
                  sessionUpdate: "config_option_update",
                  configOptions,
                },
              },
            }),
          );
        }
      }
    }
  }

  /**
   * Handle session/set_config_option from the editor.
   * Translate to appropriate kiro-cli method.
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
        JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "Invalid params" } }),
      );
      return;
    }

    const config = this.sessions.get(sessionId);

    switch (configId) {
      case "model": {
        if (config) config.model = value;
        // Forward as session/set_model to kiro-cli (Kiro's native method)
        const reqId = this.nextInternalId();
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

      case "mode": {
        if (config) config.mode = value;
        // Forward as session/set_mode to kiro-cli (standard ACP method)
        const reqId = this.nextInternalId();
        this.internalRequestIds.add(reqId);
        this.writeToKiro(
          JSON.stringify({
            jsonrpc: "2.0",
            id: reqId,
            method: "session/set_mode",
            params: { sessionId, modeId: value },
          }),
        );
        break;
      }

      case "thinking": {
        if (config) config.thinking = value;
        // Use kiro slash command /effort
        const reqId = this.nextInternalId();
        this.internalRequestIds.add(reqId);
        this.writeToKiro(
          JSON.stringify({
            jsonrpc: "2.0",
            id: reqId,
            method: "_kiro.dev/commands/execute",
            params: { sessionId, command: `/effort ${value}` },
          }),
        );
        break;
      }

      default: {
        // Unknown config option — forward to kiro-cli as-is
        this.writeToKiro(JSON.stringify(msg));
        return;
      }
    }

    // Respond to client with full config state
    const currentConfig = this.sessions.get(sessionId) ?? { model: "auto", mode: "code", thinking: "medium" };
    this.writeToClient(
      JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          configOptions: this.buildCurrentConfigOptions(currentConfig),
        },
      }),
    );
  }

  /**
   * Build configOptions from current session state.
   */
  private buildCurrentConfigOptions(config: { model: string; mode: string; thinking: string }): ConfigOption[] {
    return [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: config.model,
        // Real options should have been populated by queryRealOptions
        options: [{ value: config.model, name: config.model }],
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
    ];
  }

  private nextInternalId(): number {
    return ++this.internalIdCounter;
  }

  private writeToKiro(line: string): void {
    if (this.kiroProcess?.stdin?.writable) {
      this.kiroProcess.stdin.write(line + "\n");
    }
  }

  private writeToClient(line: string): void {
    process.stdout.write(line + "\n");
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

// -- Helpers --

function isRequest(msg: JsonRpcMessage): boolean {
  return "method" in msg && "id" in msg && msg.id != null;
}

function isResponse(msg: JsonRpcMessage): boolean {
  return ("result" in msg || "error" in msg) && !("method" in msg);
}

function log(...args: unknown[]): void {
  process.stderr.write(`[kiro-agent-acp] ${args.join(" ")}\n`);
}
