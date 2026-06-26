import {
  agent as acpAgent,
  AgentContext,
  AvailableCommand,
  CancelNotification,
  ClientCapabilities,
  InitializeRequest,
  InitializeResponse,
  methods,
  ndJsonStream,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  SessionNotification,
  SessionModeState,
  SessionConfigOption,
  CloseSessionRequest,
  CloseSessionResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  StopReason,
  ContentBlock,
  AgentConnection,
} from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";
import { KiroProcess, KiroMessage } from "./kiro-process.js";
import { toolInfoFromKiroToolUse, toolUpdateFromKiroResult } from "./tools.js";
import type { Logger } from "./utils.js";
import { nodeToWebReadable, nodeToWebWritable } from "./utils.js";

const PROTOCOL_VERSION = 1;

const MAX_TITLE_LENGTH = 256;

function sanitizeTitle(text: string): string {
  const sanitized = text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  if (sanitized.length <= MAX_TITLE_LENGTH) {
    return sanitized;
  }
  return sanitized.slice(0, MAX_TITLE_LENGTH - 1) + "\u2026";
}

/**
 * Represents a single active session with a kiro-cli process.
 */
interface Session {
  kiroProcess: KiroProcess;
  cwd: string;
  cancelled: boolean;
  /** Resolve/reject for the current in-flight prompt */
  promptResolve?: (response: PromptResponse) => void;
  promptReject?: (error: unknown) => void;
  /** Session title derived from first prompt */
  title?: string;
  /** Accumulated text for the current assistant message */
  currentMessageText: string;
  /** Current message ID */
  currentMessageId: string;
  /** Unsubscribe function for kiro process messages */
  unsubscribe?: () => void;
}

/**
 * Available slash commands that Kiro CLI supports.
 * These are exposed as ACP "available commands".
 */
const KIRO_COMMANDS: AvailableCommand[] = [
  {
    name: "help",
    description: "Get help about Kiro CLI commands, tools, and configuration",
    input: { hint: "Question about Kiro" },
  },
  {
    name: "compact",
    description: "Compact conversation history to reduce context usage",
  },
  {
    name: "clear",
    description: "Clear the current conversation and start fresh",
  },
  {
    name: "tools",
    description: "List available tools and their status",
  },
  {
    name: "mcp",
    description: "Manage MCP server connections",
  },
  {
    name: "cost",
    description: "Show token usage and cost for the current session",
  },
];

/**
 * The main Kiro ACP Agent class.
 * Bridges ACP protocol methods to kiro-cli process management.
 */
export class KiroAcpAgent {
  sessions: Record<string, Session> = {};
  client!: AgentContext;
  clientCapabilities?: ClientCapabilities;
  logger: Logger;
  private agentName?: string;

  constructor(options?: { logger?: Logger; agentName?: string }) {
    this.logger = options?.logger ?? console;
    this.agentName = options?.agentName;
  }

  /**
   * Handle ACP initialize request.
   */
  async initialize(request: InitializeRequest): Promise<InitializeResponse> {
    this.clientCapabilities = request.clientCapabilities;

    return {
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: {
        name: "kiro",
        version: "0.1.0",
        title: "Kiro Agent",
      },
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: {
          image: true,
          audio: false,
          embeddedContext: true,
        },
        sessionCapabilities: {
          close: {},
          list: {},
        },
      },
    };
  }

  /**
   * Handle ACP session/new request.
   * Creates a new kiro-cli subprocess for this session.
   */
  async newSession(request: NewSessionRequest): Promise<NewSessionResponse> {
    const sessionId = randomUUID();
    const cwd = request.cwd;

    // Create and start a kiro-cli process
    const kiroProcess = new KiroProcess({
      cwd,
      logger: this.logger,
      agentName: this.agentName,
    });

    await kiroProcess.start();

    const session: Session = {
      kiroProcess,
      cwd,
      cancelled: false,
      currentMessageText: "",
      currentMessageId: randomUUID(),
    };

    this.sessions[sessionId] = session;

    // Set up message handling for this session
    const unsubscribe = kiroProcess.onMessage((msg) => {
      this.handleKiroMessage(sessionId, msg);
    });
    session.unsubscribe = unsubscribe;

    // Send available commands notification
    this.client
      .notify(methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: KIRO_COMMANDS,
        },
      } as SessionNotification)
      .catch((err) => this.logger.error("Failed to send commands update:", err));

    const modes: SessionModeState = {
      availableModes: [
        { id: "code", name: "Code", description: "Write and edit code" },
        { id: "ask", name: "Ask", description: "Ask questions without making changes" },
      ],
      currentModeId: "code",
    };

    return {
      sessionId,
      modes,
    };
  }

  /**
   * Handle ACP session/prompt request.
   * Sends user message to the kiro-cli process and streams responses back.
   */
  async prompt(request: PromptRequest): Promise<PromptResponse> {
    const session = this.sessions[request.sessionId];
    if (!session) {
      throw new Error(`Session not found: ${request.sessionId}`);
    }

    if (!session.kiroProcess.isRunning) {
      throw new Error("The Kiro session has ended. Please start a new session.");
    }

    session.cancelled = false;
    session.currentMessageText = "";
    session.currentMessageId = randomUUID();

    // Extract text from the prompt blocks
    const textParts: string[] = [];
    for (const block of request.prompt) {
      if ("text" in block && typeof block.text === "string") {
        textParts.push(block.text);
      } else if ("uri" in block && typeof block.uri === "string") {
        // Resource link - include as context
        textParts.push(`[Context: ${block.uri}]`);
      }
    }

    const promptText = textParts.join("\n");

    // Generate title from first prompt if we don't have one yet
    if (!session.title && promptText) {
      session.title = sanitizeTitle(promptText);
      // Notify client of title
      this.client
        .notify(methods.client.session.update, {
          sessionId: request.sessionId,
          update: {
            sessionUpdate: "session_info_update",
            title: session.title,
          },
        } as SessionNotification)
        .catch((err) => this.logger.error("Failed to send title update:", err));
    }

    // Return a promise that resolves when the turn is complete
    return new Promise<PromptResponse>((resolve, reject) => {
      session.promptResolve = resolve;
      session.promptReject = reject;

      // Send the prompt to kiro-cli
      session.kiroProcess.sendPrompt(promptText).catch((err) => {
        session.promptResolve = undefined;
        session.promptReject = undefined;
        reject(err);
      });

      // Set a timeout for the turn - kiro-cli should respond within a reasonable time
      // but for long-running operations this may need to be longer
      const timeout = setTimeout(
        () => {
          if (session.promptResolve) {
            // If we have accumulated text, treat it as a completed turn
            if (session.currentMessageText) {
              const resolve = session.promptResolve;
              session.promptResolve = undefined;
              session.promptReject = undefined;
              resolve({ stopReason: "end_turn" });
            }
          }
        },
        5 * 60 * 1000, // 5 minutes max per turn
      );

      // Clean up timeout when promise settles
      const originalResolve = session.promptResolve;
      session.promptResolve = (resp) => {
        clearTimeout(timeout);
        originalResolve?.(resp);
      };
    });
  }

  /**
   * Handle ACP session/cancel notification.
   * Interrupts the current kiro-cli operation.
   */
  async cancel(notification: CancelNotification): Promise<void> {
    const session = this.sessions[notification.sessionId];
    if (!session) return;

    session.cancelled = true;
    session.kiroProcess.interrupt();

    // Settle the pending prompt
    if (session.promptResolve) {
      const resolve = session.promptResolve;
      session.promptResolve = undefined;
      session.promptReject = undefined;
      resolve({ stopReason: "cancelled" });
    }
  }

  /**
   * Handle ACP session/close request.
   */
  async closeSession(request: CloseSessionRequest): Promise<CloseSessionResponse> {
    const session = this.sessions[request.sessionId];
    if (session) {
      // Cancel any pending prompt
      if (session.promptResolve) {
        const resolve = session.promptResolve;
        session.promptResolve = undefined;
        session.promptReject = undefined;
        resolve({ stopReason: "cancelled" });
      }

      // Unsubscribe from messages
      session.unsubscribe?.();

      // Dispose the kiro-cli process
      await session.kiroProcess.dispose();

      // Remove from sessions
      delete this.sessions[request.sessionId];
    }
    return {};
  }

  /**
   * Handle ACP session/list request.
   */
  async listSessions(_request: ListSessionsRequest): Promise<ListSessionsResponse> {
    const sessions = Object.entries(this.sessions).map(([sessionId, session]) => ({
      sessionId,
      cwd: session.cwd,
      title: session.title ?? null,
      updatedAt: new Date().toISOString(),
    }));
    return { sessions };
  }

  /**
   * Handle messages from the kiro-cli process and convert them to ACP notifications.
   */
  private handleKiroMessage(sessionId: string, msg: KiroMessage): void {
    const session = this.sessions[sessionId];
    if (!session) return;

    switch (msg.type) {
      case "text": {
        if (!msg.content) break;
        session.currentMessageText += msg.content;

        // Stream the text as an agent message chunk
        this.client
          .notify(methods.client.session.update, {
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: msg.content },
              messageId: session.currentMessageId,
            },
          } as SessionNotification)
          .catch((err) => this.logger.error("Failed to send message chunk:", err));
        break;
      }

      case "thinking": {
        if (!msg.content) break;

        this.client
          .notify(methods.client.session.update, {
            sessionId,
            update: {
              sessionUpdate: "agent_thought_chunk",
              content: { type: "text", text: msg.content },
              messageId: session.currentMessageId,
            },
          } as SessionNotification)
          .catch((err) => this.logger.error("Failed to send thought chunk:", err));
        break;
      }

      case "tool_use": {
        const toolCallId = msg.id ?? randomUUID();
        const toolName = msg.name ?? "unknown";
        const toolInput = msg.input;

        const toolInfo = toolInfoFromKiroToolUse(toolName, toolInput, session.cwd);

        this.client
          .notify(methods.client.session.update, {
            sessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId,
              title: toolInfo.title,
              kind: toolInfo.kind,
              content: toolInfo.content,
              locations: toolInfo.locations,
              status: "in_progress",
            },
          } as SessionNotification)
          .catch((err) => this.logger.error("Failed to send tool_call:", err));
        break;
      }

      case "tool_result": {
        const toolCallId = msg.id ?? "";
        const toolName = msg.name ?? "unknown";
        const output = msg.output ?? msg.content;
        const isError = msg.is_error ?? false;

        const toolUpdate = toolUpdateFromKiroResult(toolName, output, isError);

        this.client
          .notify(methods.client.session.update, {
            sessionId,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId,
              status: isError ? "failed" : "completed",
              ...(toolUpdate.content ? { content: toolUpdate.content } : {}),
            },
          } as SessionNotification)
          .catch((err) => this.logger.error("Failed to send tool_call_update:", err));
        break;
      }

      case "error": {
        const errorText = msg.content ?? "An error occurred";

        this.client
          .notify(methods.client.session.update, {
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: `\n\n**Error:** ${errorText}\n` },
              messageId: session.currentMessageId,
            },
          } as SessionNotification)
          .catch((err) => this.logger.error("Failed to send error:", err));

        // Settle the prompt with an error stop reason if one is pending
        if (session.promptResolve) {
          const resolve = session.promptResolve;
          session.promptResolve = undefined;
          session.promptReject = undefined;
          resolve({ stopReason: "end_turn" });
        }
        break;
      }

      case "done": {
        // Turn is complete
        if (session.promptResolve) {
          const resolve = session.promptResolve;
          session.promptResolve = undefined;
          session.promptReject = undefined;
          resolve({ stopReason: "end_turn" });
        }
        break;
      }

      case "session_info": {
        // Update session title if provided
        if (msg.title) {
          session.title = msg.title;
          this.client
            .notify(methods.client.session.update, {
              sessionId,
              update: {
                sessionUpdate: "session_info_update",
                title: session.title,
              },
            } as SessionNotification)
            .catch((err) => this.logger.error("Failed to send session info:", err));
        }
        break;
      }
    }
  }

  /**
   * Clean up all sessions.
   */
  async dispose(): Promise<void> {
    const sessions = Object.entries(this.sessions);
    for (const [sessionId, session] of sessions) {
      session.unsubscribe?.();
      await session.kiroProcess.dispose();
      delete this.sessions[sessionId];
    }
  }
}

/**
 * Creates and starts the ACP agent app with all handlers wired up.
 * Returns the connection and agent instance for lifecycle management.
 */
export function runAcp(options?: { agentName?: string }): {
  connection: AgentConnection;
  agent: KiroAcpAgent;
} {
  const app = acpAgent({ name: "kiro-agent-acp" });
  let kiroAgent: KiroAcpAgent;

  app.onConnect((connection) => {
    kiroAgent = new KiroAcpAgent({
      logger: console,
      agentName: options?.agentName,
    });
    kiroAgent.client = connection.client;
  });

  // Register all ACP method handlers
  app.onRequest(methods.agent.initialize, async ({ params, client }) => {
    if (!kiroAgent) {
      kiroAgent = new KiroAcpAgent({
        logger: console,
        agentName: options?.agentName,
      });
      kiroAgent.client = client;
    }
    return kiroAgent.initialize(params);
  });

  app.onRequest(methods.agent.session.new, async ({ params }) => {
    return kiroAgent.newSession(params);
  });

  app.onRequest(methods.agent.session.prompt, async ({ params }) => {
    return kiroAgent.prompt(params);
  });

  app.onNotification(methods.agent.session.cancel, async ({ params }) => {
    await kiroAgent.cancel(params);
  });

  app.onRequest(methods.agent.session.close, async ({ params }) => {
    return kiroAgent.closeSession(params);
  });

  app.onRequest(methods.agent.session.list, async ({ params }) => {
    return kiroAgent.listSessions(params);
  });

  // Connect to stdin/stdout
  const stream = ndJsonStream(
    nodeToWebWritable(process.stdout),
    nodeToWebReadable(process.stdin),
  );

  const connection = app.connect(stream);

  return { connection, agent: kiroAgent! };
}
