# kiro-agent-acp

A **Zed ACP adapter** for [Kiro CLI](https://kiro.dev/docs/cli/) that adds model selection, agent switching, and thinking level control.

Since `kiro-cli acp` already implements the Agent Client Protocol natively, this adapter acts as a **transparent proxy** that intercepts specific ACP messages to inject UI configuration options — giving you dropdown selectors in Zed for:

- **Model** — Switch between Auto, Claude Sonnet 4.5, Claude Opus 4, Claude Haiku 4, DeepSeek R1, Qwen 3
- **Agent** — Switch between Default, Architect, Ask, Code modes
- **Thinking** — Control reasoning depth: Low, Medium, High, Max

All other ACP messages pass through transparently to `kiro-cli acp`.

## How It Works

```
┌──────────────┐      JSON-RPC/stdio       ┌───────────────────┐      JSON-RPC/stdio      ┌───────────────┐
│     Zed      │ ◄──────────────────────► │  kiro-agent-acp   │ ◄────────────────────► │  kiro-cli acp │
│  (ACP Client)│                           │  (this proxy)     │                         │  (ACP Agent)  │
└──────────────┘                           └───────────────────┘                         └───────────────┘
                                                    │
                                                    │ Intercepts:
                                                    │ • initialize → enhance capabilities
                                                    │ • session/new response → inject configOptions
                                                    │ • session/set_config_option → handle model/agent/thinking
                                                    │   then sends /model, /agent, /effort commands to kiro-cli
```

The proxy:
1. Spawns `kiro-cli acp` as a subprocess
2. Pipes ACP JSON-RPC messages between Zed and kiro-cli
3. Intercepts `session/new` responses to inject `configOptions` for model, agent, and thinking level
4. Handles `session/set_config_option` requests by translating them into Kiro slash commands (`/model`, `/effort`, `/agent`)
5. Passes everything else through unchanged

## Prerequisites

1. **Kiro CLI** installed and authenticated:
   ```bash
   # Install
   curl -fsSL https://kiro.dev/install.sh | bash

   # Authenticate
   kiro-cli auth login
   ```

2. **Node.js** >= 20

3. Verify:
   ```bash
   kiro-cli --version
   kiro-cli acp --help
   ```

## Installation

```bash
npm install -g kiro-agent-acp
```

Or use directly with npx (no install needed):

```bash
npx kiro-agent-acp
```

## Zed Editor Setup

Open Zed settings (`~/.config/zed/settings.json`) and add:

```json
{
  "agent": {
    "agent_servers": {
      "Kiro": {
        "type": "custom",
        "command": "npx",
        "args": ["kiro-agent-acp"],
        "env": {}
      }
    }
  }
}
```

Or if installed globally:

```json
{
  "agent": {
    "agent_servers": {
      "Kiro": {
        "type": "custom",
        "command": "kiro-agent-acp",
        "args": [],
        "env": {}
      }
    }
  }
}
```

To use a specific Kiro agent:

```json
{
  "agent": {
    "agent_servers": {
      "Kiro Architect": {
        "type": "custom",
        "command": "npx",
        "args": ["kiro-agent-acp", "--agent", "architect"],
        "env": {}
      }
    }
  }
}
```

After saving, open the Agent Panel (`Cmd+?` on macOS / `Ctrl+?` on Linux), click **+** to create a new thread, and select **Kiro** from the agent list.

## Usage in Zed

Once configured, you'll see dropdown selectors in the Zed Agent Panel for:

| Selector | Options | What it does |
|----------|---------|--------------|
| **Model** | Auto, Sonnet 4.5, Opus 4, Haiku 4, DeepSeek R1, Qwen 3 | Sends `/model <name>` to kiro-cli |
| **Agent** | Default, Architect, Ask, Code | Sends `/agent <name>` to kiro-cli |
| **Thinking** | Low, Medium, High, Max | Sends `/effort <level>` to kiro-cli |

These map to ACP's `SessionConfigOption` with categories `model`, `mode`, and `thought_level` respectively — Zed renders them as native UI elements.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `KIRO_CLI_PATH` | Override the path to the `kiro-cli` executable |
| `KIRO_AUTH_TOKEN` | Pass authentication token directly |

## CLI Options

```bash
kiro-agent-acp [--agent <name>]
```

| Flag | Description |
|------|-------------|
| `--agent <name>` | Pass `--agent` to kiro-cli acp (use a specific agent config) |

## Also Works With Other ACP Clients

While designed for Zed, this adapter works with any ACP client:

### JetBrains IDEs

`~/.jetbrains/acp.json`:
```json
{
  "agents": [
    {
      "name": "Kiro",
      "command": ["npx", "kiro-agent-acp"]
    }
  ]
}
```

### Neovim (ACP plugin)

```lua
require('acp').setup({
  agents = {
    { name = "Kiro", command = { "npx", "kiro-agent-acp" } },
  },
})
```

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run directly (will fail without a connected ACP client on stdin)
npm start

# Type check
npx tsc --noEmit
```

## Customizing Models & Agents

Edit `src/config.ts` to add/remove models, agents, or thinking levels. Then rebuild:

```bash
npm run build
```

## Troubleshooting

**"kiro-cli not found"**
- Run `which kiro-cli` and set `KIRO_CLI_PATH` to the full path
- Or ensure `~/.local/bin` is in your PATH

**"Authentication required"**
- Run `kiro-cli auth login` in your terminal

**Zed doesn't show the agent**
- Make sure the settings.json is valid JSON
- Restart Zed after changing settings
- Check `~/.config/zed/logs/` for errors

**Model/thinking selector not appearing**
- Make sure you're using a recent version of Zed that supports ACP `configOptions`
- The selectors appear after creating a new thread with the Kiro agent

## License

[Apache-2.0](LICENSE)
