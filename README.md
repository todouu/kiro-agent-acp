# Kiro Agent ACP

Use [Kiro CLI](https://kiro.dev/docs/cli/) from [ACP-compatible](https://agentclientprotocol.com) clients!

This package implements an ACP agent by wrapping the official [Kiro CLI](https://kiro.dev/docs/cli/), supporting:

- Context @-mentions
- Images
- Tool calls (file edits, terminal execution, search, etc.)
- Streaming responses
- Session management
- Slash commands (`/help`, `/compact`, `/clear`, `/tools`, `/mcp`, `/cost`)
- MCP server integration

Learn more about the [Agent Client Protocol](https://agentclientprotocol.com/).

## Prerequisites

1. **Kiro CLI** must be installed and authenticated. Follow the [Kiro CLI installation guide](https://kiro.dev/docs/cli/).

2. **Node.js** >= 20

3. Verify kiro-cli is working:
   ```bash
   kiro-cli --version
   ```

## Installation

```bash
npm install -g @anthropic-ai/kiro-agent-acp
```

Or use directly with npx:

```bash
npx @anthropic-ai/kiro-agent-acp
```

## Usage

Run as an ACP agent (communicates over stdin/stdout with JSON-RPC):

```bash
kiro-agent-acp
```

To use a specific Kiro agent configuration:

```bash
kiro-agent-acp --agent my-agent
```

## Editor Setup

### Zed

Add the following to your Zed settings (`~/.config/zed/settings.json`):

```json
{
  "agent": {
    "custom_agents": [
      {
        "id": "kiro",
        "name": "Kiro Agent",
        "command": {
          "command": "npx",
          "args": ["@anthropic-ai/kiro-agent-acp"]
        }
      }
    ]
  }
}
```

Or if you installed globally:

```json
{
  "agent": {
    "custom_agents": [
      {
        "id": "kiro",
        "name": "Kiro Agent",
        "command": {
          "command": "kiro-agent-acp",
          "args": []
        }
      }
    ]
  }
}
```

### JetBrains IDEs (IntelliJ, WebStorm, DataGrip, etc.)

1. Open the AI Chat tool window
2. Click the menu button (three dots) in the upper-right corner
3. Select "Add Custom Agent"
4. This opens or creates `~/.jetbrains/acp.json`
5. Add the Kiro agent configuration:

```json
{
  "agents": [
    {
      "name": "Kiro Agent",
      "command": ["npx", "@anthropic-ai/kiro-agent-acp"]
    }
  ]
}
```

Or with a globally installed binary:

```json
{
  "agents": [
    {
      "name": "Kiro Agent",
      "command": ["kiro-agent-acp"]
    }
  ]
}
```

6. Save the file — Kiro should appear in the AI Chat dropdown immediately.

### Neovim (with ACP plugin)

If using an ACP-compatible Neovim plugin, configure in your `init.lua`:

```lua
require('acp').setup({
  agents = {
    {
      name = "Kiro",
      command = { "npx", "@anthropic-ai/kiro-agent-acp" },
    },
  },
})
```

### Eclipse

Configure via your Eclipse ACP settings to spawn:

```
npx @anthropic-ai/kiro-agent-acp
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `KIRO_CLI_PATH` | Override the path to the `kiro-cli` executable |
| `KIRO_AUTH_TOKEN` | Pass authentication token directly |
| `KIRO_NON_INTERACTIVE` | Set to `1` to force non-interactive mode (set automatically) |

## Architecture

```
┌──────────────────┐         JSON-RPC/stdio        ┌──────────────────────┐
│   ACP Client     │◄────────────────────────────►  │  kiro-agent-acp      │
│   (Zed, IDEA)    │                                │  (this package)      │
└──────────────────┘                                └──────────┬───────────┘
                                                               │
                                                               │ stdin/stdout
                                                               ▼
                                                    ┌──────────────────────┐
                                                    │     kiro-cli         │
                                                    │  (subprocess)        │
                                                    └──────────────────────┘
```

The adapter:
1. Receives ACP protocol messages from the editor (JSON-RPC over stdio)
2. Manages `kiro-cli` subprocesses — one per session
3. Translates Kiro's output into ACP `session/update` notifications (message chunks, tool calls, diffs)
4. Maps slash commands to ACP available commands

## Supported ACP Methods

| Method | Support |
|--------|---------|
| `initialize` | ✅ |
| `session/new` | ✅ |
| `session/prompt` | ✅ |
| `session/cancel` | ✅ |
| `session/close` | ✅ |
| `session/list` | ✅ |
| `session/load` | ❌ (planned) |
| `session/resume` | ❌ (planned) |
| `session/set_mode` | ❌ (planned) |

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run directly
npm start

# Run in dev mode (build + run)
npm run dev

# Type check
npx tsc --noEmit

# Run tests
npm test
```

## How It Works

1. **Initialization**: When an ACP client connects, the agent advertises its capabilities (image support, embedded context, session management).

2. **Session creation**: Each `session/new` request spawns a dedicated `kiro-cli` subprocess in the requested working directory.

3. **Prompt handling**: User messages are sent to kiro-cli's stdin. The agent parses kiro-cli's JSON output stream and emits appropriate ACP notifications:
   - Text → `agent_message_chunk`
   - Thinking → `agent_thought_chunk`
   - Tool calls → `tool_call` / `tool_call_update`
   - Errors → `agent_message_chunk` with error formatting

4. **Cancellation**: Sends SIGINT to the kiro-cli process to interrupt the current operation.

5. **Cleanup**: When a session is closed, the subprocess is terminated gracefully.

## Library Usage

You can also use this package as a library to build custom integrations:

```typescript
import { KiroAcpAgent, KiroProcess } from "@anthropic-ai/kiro-agent-acp";

// Create a standalone kiro process
const proc = new KiroProcess({ cwd: "/my/project", logger: console });
await proc.start();
proc.onMessage((msg) => console.log(msg));
await proc.sendPrompt("Hello, Kiro!");
```

## License

[Apache-2.0](LICENSE)
