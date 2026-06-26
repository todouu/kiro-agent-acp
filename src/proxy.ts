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

interface ConfigOptionChoice {
  value: string;
  name: string;
  description?: string;
}

interface ConfigOption {
  id: string;
  name: string;
  description?: string;
  category?: string;
  type: "select";
  currentValue: string;
  options: ConfigOptionChoice[];
}

/** Per-session state, including the REAL options reported by kiro-cli. */
interface SessionState {
  model: string;
  mode: string;
  thinking: string;
  modelOptions: ConfigOptionChoice[];
  modeOptions: ConfigOptionChoice[];
}

/** Shape of the `models` block inside a kiro-cli session/new result. */
interface KiroModels {
  currentModelId?: string;
  availableModels?: Array<{ modelId: string; name?: string; description?: string }>;
}

/** Shape of the `modes` block inside a kiro-cli session/new result. */
interface KiroModes {
  currentModeId?: string;
  availableModes?: Array<{ id: string; name?: string; description?: string }>;
}

/** Thinking/effort levels are a fixed set in kiro-cli — there is no RPC to enumerate them. */
const THINKING_OPTIONS: ConfigOptionChoice[] = [
  { value: "low", name: "Low", description: "Fast responses" },
  { value: "medium", name: "Medium", description: "Balanced" },
  { value: "high", name: "High", description: "Deep reasoning" },
  { value: "xhigh", name: "XHigh", description: "Extended reasoning" },
  { value: "max", name: "Max", description: "Maximum reasoning" },
];
const DEFAULT_THINKING = "medium";

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
 * Model and agent lists are NOT hardcoded and are NOT fetched via any extra
 * RPC. kiro-cli already embeds the real, current lists directly in the
 * session/new result:
 *   result.models = { currentModelId, availableModels: [{ modelId, name, description }] }
 *   result.modes  = { currentModeId,  availableModes:  [{ id, name, description }] }
 *
 * (An earlier version of this proxy tried to call `_kiro.dev/commands/options`
 * and `_kiro.dev/commands/model/options` to fetch these lists. Those methods
 * do NOT exist in kiro-cli — they return -32601 "Method not found", and the
 * bogus `command: "/model "` argument is what produced the
 * `unknown variant /model` parse errors in the logs. They have been removed.)
 *
 * This proxy:
 * 1. Intercepts session/new responses → reads result.models / result.modes and
 *    injects matching configOptions so editors can render dropdowns.
 * 2. Intercepts session/set_config_option → translates to the real kiro-cli
 *    methods: session/set_model {modelId} and session/set_mode {modeId}.
 *    Thinking/effort has no RPC, so it is sent as the `/effort` slash command.
 * 3. Passes everything else through transparently.
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

  /** Track sessions and their current config + real option lists */
  private sessions: Map<string, SessionState> = new Map();

  /** Internal request IDs we generated ourselves, whose responses must be swallowed */
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

      // Swallow responses to our own internal requests (e.g. the /effort prompt)
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
   * Read the real model/agent lists out of a session/new result and inject
   * configOptions so the editor can render dropdown selectors.
   */
  private injectConfigOptions(msg: JsonRpcMessage): JsonRpcMessage {
    try {
      const result = { ...(msg.result as Record<string, unknown>) };
      const sessionId = result.sessionId as string;

      if (!sessionId) return msg;

      // --- Models: from result.models.availableModels ---
      const kiroModels = result.models as KiroModels | undefined;
      const modelOptions: ConfigOptionChoice[] = (kiroModels?.availableModels ?? []).map((m) => ({
        value: m.modelId,
        name: m.name ?? m.modelId,
        description: m.description,
      }));
      const currentModel = kiroModels?.currentModelId ?? modelOptions[0]?.value ?? "auto";

      // --- Agents (modes): from result.modes.availableModes ---
      const kiroModes = result.modes as KiroModes | undefined;
      const modeOptions: ConfigOptionChoice[] = (kiroModes?.availableModes ?? []).map((m) => ({
        value: m.id,
        name: m.name ?? m.id,
        description: m.description,
      }));
      const currentMode = kiroModes?.currentModeId ?? modeOptions[0]?.value ?? "";

      // Persist the real options for this session
      const state: SessionState = {
        model: currentModel,
        mode: currentMode,
        thinking: DEFAULT_THINKING,
        modelOptions,
        modeOptions,
      };
      this.sessions.set(sessionId, state);

      // Build configOptions, skipping any list kiro-cli didn't provide
      const configOptions = this.buildFullConfigOptions(state);

      // Merge: our derived options first, then any existing from kiro
      const existing = (result.configOptions as ConfigOption[]) ?? [];
      result.configOptions = [...configOptions, ...existing];

      return { ...msg, result };
    } catch (err) {
      log(`Error injecting configOptions: ${err}`);
      return msg;
    }
  }

  /**
   * Handle session/set_config_option from the editor by translating to the
   * real kiro-cli methods.
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

    const state = this.sessions.get(sessionId);
    if (!state) {
      // We never saw session/new for this session — forward as-is and let kiro decide.
      this.pendingRequests.set(msg.id!, { method: "session/set_config_option" });
      this.writeToKiro(JSON.stringify(msg));
      return;
    }

    switch (configId) {
      case "model": {
        state.model = value;
        // Real method: session/set_model { sessionId, modelId }
        this.forwardSetRequest(msg.id!, "session/set_model", { sessionId, modelId: value });
        break;
      }

      case "mode": {
        state.mode = value;
        // Real method: session/set_mode { sessionId, modeId }
        this.forwardSetRequest(msg.id!, "session/set_mode", { sessionId, modeId: value });
        break;
      }

      case "thinking": {
        state.thinking = value;
        // No RPC exists for thinking/effort — send the /effort slash command via prompt.
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
        // Reply to the editor immediately with the updated config snapshot.
        this.writeToClient(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: { configOptions: this.buildFullConfigOptions(state) },
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
  }

  /**
   * Forward a config change to kiro-cli using a real RPC method, then translate
   * kiro's response back into the configOptions snapshot the editor expects.
   *
   * The editor's original request id is preserved by reusing it toward kiro and
   * rewriting the response in handleKiroOutput via pendingRequests.
   */
  private forwardSetRequest(
    clientReqId: string | number,
    method: string,
    params: Record<string, unknown>,
  ): void {
    const sessionId = params.sessionId as string;
    const reqId = ++this.internalIdCounter;
    this.internalRequestIds.add(reqId);
    this.writeToKiro(JSON.stringify({ jsonrpc: "2.0", id: reqId, method, params }));

    // Respond to the editor immediately with the updated config snapshot.
    // (session/set_model and session/set_mode return an empty result {}, so
    // there is nothing useful to wait for — we already track state locally.)
    const state = this.sessions.get(sessionId);
    this.writeToClient(
      JSON.stringify({
        jsonrpc: "2.0",
        id: clientReqId,
        result: { configOptions: state ? this.buildFullConfigOptions(state) : [] },
      }),
    );
  }

  /**
   * Build the full configOptions array from current session state, using the
   * REAL model/agent lists captured at session/new. Lists kiro-cli didn't
   * provide are omitted rather than faked.
   */
  private buildFullConfigOptions(state: SessionState): ConfigOption[] {
    const options: ConfigOption[] = [];

    if (state.modelOptions.length > 0) {
      options.push({
        id: "model",
        name: "Model",
        description: "Select AI model",
        category: "model",
        type: "select",
        currentValue: state.model,
        options: state.modelOptions,
      });
    }

    if (state.modeOptions.length > 0) {
      options.push({
        id: "mode",
        name: "Agent",
        description: "Switch agent",
        category: "mode",
        type: "select",
        currentValue: state.mode,
        options: state.modeOptions,
      });
    }

    options.push({
      id: "thinking",
      name: "Thinking",
      description: "Control reasoning depth (/effort)",
      category: "thought_level",
      type: "select",
      currentValue: state.thinking,
      options: THINKING_OPTIONS,
    });

    return options;
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
