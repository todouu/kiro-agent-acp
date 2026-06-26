import type {
  ContentBlock,
  ToolCallContent,
  ToolCallLocation,
  ToolKind,
} from "@agentclientprotocol/sdk";
import type { KiroMessage } from "./kiro-process.js";
import * as path from "node:path";

/**
 * Information about a tool call for display in ACP clients.
 */
export interface ToolInfo {
  title: string;
  kind: ToolKind;
  content: ToolCallContent[];
  locations?: ToolCallLocation[];
}

/**
 * Update to an existing tool call.
 */
export interface ToolUpdate {
  title?: string;
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
}

/**
 * Convert an absolute file path to a project-relative path for display.
 */
export function toDisplayPath(filePath: string, cwd?: string): string {
  if (!cwd) return filePath;
  const resolvedCwd = path.resolve(cwd);
  const resolvedFile = path.resolve(filePath);
  if (resolvedFile.startsWith(resolvedCwd + path.sep) || resolvedFile === resolvedCwd) {
    return path.relative(resolvedCwd, resolvedFile);
  }
  return filePath;
}

/**
 * Infer tool info from a kiro-cli tool_use message.
 * Maps Kiro tool names to ACP tool kinds and display info.
 */
export function toolInfoFromKiroToolUse(
  name: string,
  input: Record<string, unknown> | undefined,
  cwd?: string,
): ToolInfo {
  switch (name) {
    case "read_file":
    case "Read": {
      const filePath = (input?.path ?? input?.file_path ?? "") as string;
      const displayPath = filePath ? toDisplayPath(filePath, cwd) : "File";
      return {
        title: `Read ${displayPath}`,
        kind: "read",
        locations: filePath ? [{ path: filePath }] : [],
        content: [],
      };
    }

    case "write_file":
    case "fs_write":
    case "Write": {
      const filePath = (input?.path ?? input?.file_path ?? "") as string;
      const content = (input?.content ?? input?.text ?? "") as string;
      const displayPath = filePath ? toDisplayPath(filePath, cwd) : undefined;
      return {
        title: displayPath ? `Write ${displayPath}` : "Write",
        kind: "edit",
        content: filePath
          ? [{ type: "diff", path: filePath, oldText: null, newText: content }]
          : [],
        locations: filePath ? [{ path: filePath }] : [],
      };
    }

    case "str_replace":
    case "edit_file":
    case "Edit": {
      const filePath = (input?.path ?? input?.file_path ?? "") as string;
      const oldStr = (input?.oldStr ?? input?.old_string ?? "") as string;
      const newStr = (input?.newStr ?? input?.new_string ?? "") as string;
      const displayPath = filePath ? toDisplayPath(filePath, cwd) : undefined;
      return {
        title: displayPath ? `Edit ${displayPath}` : "Edit",
        kind: "edit",
        content:
          filePath && (oldStr || newStr)
            ? [{ type: "diff", path: filePath, oldText: oldStr || null, newText: newStr }]
            : [],
        locations: filePath ? [{ path: filePath }] : [],
      };
    }

    case "execute_bash":
    case "Bash": {
      const command = (input?.command ?? "") as string;
      return {
        title: command || "Terminal",
        kind: "execute",
        content: command
          ? [{ type: "content", content: { type: "text", text: `\`\`\`bash\n${command}\n\`\`\`` } }]
          : [],
      };
    }

    case "grep_search":
    case "Grep": {
      const query = (input?.query ?? input?.pattern ?? "") as string;
      return {
        title: query ? `grep "${query}"` : "Search",
        kind: "search",
        content: [],
      };
    }

    case "file_search":
    case "Glob": {
      const pattern = (input?.query ?? input?.pattern ?? "") as string;
      return {
        title: pattern ? `Find \`${pattern}\`` : "Find",
        kind: "search",
        content: [],
      };
    }

    case "web_fetch":
    case "WebFetch": {
      const url = (input?.url ?? "") as string;
      return {
        title: url ? `Fetch ${url}` : "Fetch",
        kind: "fetch",
        content: [],
      };
    }

    case "web_search":
    case "remote_web_search":
    case "WebSearch": {
      const query = (input?.query ?? "") as string;
      return {
        title: query ? `Search "${query}"` : "Web search",
        kind: "fetch",
        content: [],
      };
    }

    case "list_directory": {
      const dirPath = (input?.path ?? "") as string;
      return {
        title: dirPath ? `List ${toDisplayPath(dirPath, cwd)}` : "List directory",
        kind: "read",
        content: [],
      };
    }

    case "todo_list": {
      return {
        title: "Update TODOs",
        kind: "think",
        content: [],
      };
    }

    case "invoke_sub_agent": {
      const description = (input?.explanation ?? input?.prompt ?? "") as string;
      return {
        title: description ? description.slice(0, 80) : "Sub-agent task",
        kind: "think",
        content: description
          ? [{ type: "content", content: { type: "text", text: description } }]
          : [],
      };
    }

    default:
      return {
        title: name || "Unknown Tool",
        kind: "other",
        content: [],
      };
  }
}

/**
 * Build a tool update from a tool result message.
 */
export function toolUpdateFromKiroResult(
  toolName: string,
  output: string | undefined,
  isError: boolean,
): ToolUpdate {
  if (!output || output.trim() === "") {
    return {};
  }

  switch (toolName) {
    case "execute_bash":
    case "Bash": {
      return {
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: `\`\`\`console\n${output.trimEnd()}\n\`\`\``,
            },
          },
        ],
      };
    }

    case "read_file":
    case "Read": {
      return {
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: markdownEscape(output),
            },
          },
        ],
      };
    }

    case "str_replace":
    case "edit_file":
    case "Edit":
    case "write_file":
    case "fs_write":
    case "Write": {
      // Edits are usually shown via diff in the tool_call
      return {};
    }

    default: {
      if (isError) {
        return {
          content: [
            {
              type: "content",
              content: { type: "text", text: `\`\`\`\n${output}\n\`\`\`` },
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "content",
            content: { type: "text", text: output },
          },
        ],
      };
    }
  }
}

/**
 * Escape text content within markdown code fences, ensuring no fence collision.
 */
export function markdownEscape(text: string): string {
  let escape = "```";
  for (const [m] of text.matchAll(/^```+/gm)) {
    while (m.length >= escape.length) {
      escape += "`";
    }
  }
  return escape + "\n" + text + (text.endsWith("\n") ? "" : "\n") + escape;
}
