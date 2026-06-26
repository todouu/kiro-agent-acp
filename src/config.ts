/**
 * Configuration for models, agents, and thinking levels that Kiro CLI supports.
 * These are exposed as ACP SessionConfigOptions in the Zed UI.
 */

export interface ModelOption {
  value: string;
  name: string;
  description?: string;
}

export interface AgentOption {
  value: string;
  name: string;
  description?: string;
}

export interface ThinkingOption {
  value: string;
  name: string;
  description?: string;
}

/**
 * Available Kiro CLI models.
 * Based on Kiro's model offerings: Auto routing + Claude family + open weight models.
 */
export const MODELS: ModelOption[] = [
  { value: "auto", name: "Auto", description: "Let Kiro route each task to the optimal model" },
  {
    value: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    description: "Best balance of speed and capability",
  },
  {
    value: "claude-opus-4",
    name: "Claude Opus 4",
    description: "Most powerful for complex architecture work",
  },
  {
    value: "claude-haiku-4",
    name: "Claude Haiku 4",
    description: "Fastest and most cost-efficient",
  },
  {
    value: "deepseek-r1",
    name: "DeepSeek R1",
    description: "Open weight reasoning model",
  },
  {
    value: "qwen-3",
    name: "Qwen 3",
    description: "Ultra-efficient for long coding sessions",
  },
];

/**
 * Available agents/modes in Kiro CLI.
 * Kiro supports custom agents and built-in modes.
 */
export const AGENTS: AgentOption[] = [
  { value: "default", name: "Default", description: "Standard coding agent" },
  { value: "architect", name: "Architect", description: "Design and plan without implementation" },
  { value: "ask", name: "Ask", description: "Answer questions without making changes" },
  { value: "code", name: "Code", description: "Write and modify code with full tool access" },
];

/**
 * Thinking/effort levels for Kiro CLI.
 * Controls how much reasoning the model applies.
 */
export const THINKING_LEVELS: ThinkingOption[] = [
  { value: "low", name: "Low", description: "Fast, shorter responses" },
  { value: "medium", name: "Medium", description: "Balanced reasoning and speed" },
  { value: "high", name: "High", description: "Deep analysis and multi-step reasoning" },
  { value: "max", name: "Max", description: "Maximum reasoning for complex tasks" },
];

/**
 * Default selections
 */
export const DEFAULT_MODEL = "auto";
export const DEFAULT_AGENT = "default";
export const DEFAULT_THINKING = "medium";
