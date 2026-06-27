# kiro-agent-acp

ACP Registry entry point for [Kiro CLI](https://kiro.dev/docs/cli/).

This is a **transparent wrapper** around `kiro-cli acp` — it exists purely to provide a convenient `npx`-installable package for the [ACP Registry](https://agentclientprotocol.com/get-started/registry), so editors like Zed and JetBrains can install Kiro with one click.

## What it does

`kiro-cli acp` already implements the full ACP protocol natively, including:
- **Model selection** — configOptions with real model list from your Kiro account
- **Agent switching** — switch between your configured agents
- **Thinking/effort level** — control reasoning depth
- **Session management** — load, resume, list, close sessions
- **Tool calls** — file edits, terminal, search, etc.
- **Slash commands** — /help, /compact, /model, /effort, etc.
- **MCP servers** — forwarded from the editor

This package simply spawns `kiro-cli acp` and pipes all JSON-RPC messages through transparently. **No hardcoded models or agents** — everything comes directly from kiro-cli.

## Prerequisites

1. **Kiro CLI** installed and authenticated:
   ```bash
   curl -fsSL https://kiro.dev/install.sh | bash
   kiro-cli auth login
   ```

2. **Node.js** >= 20

## Installation

```bash
npm install -g kiro-agent-acp
```

Or use directly with npx:
```bash
npx kiro-agent-acp
```

## Zed Editor Setup

```json
{
  "agent_servers": {
    "Kiro": {
      "type": "custom",
      "command": "npx",
      "args": ["kiro-agent-acp"],
      "env": {}
    }
  }
}
```

With a specific agent:
```json
{
  "agent_servers": {
    "Kiro Architect": {
      "type": "custom",
      "command": "npx",
      "args": ["kiro-agent-acp", "--agent", "architect"],
      "env": {}
    }
  }
}
```

Trusting all tools (no per-tool confirmation prompts):
```json
{
  "agent_servers": {
    "Kiro": {
      "type": "custom",
      "command": "npx",
      "args": ["kiro-agent-acp", "--trust-all-tools"],
      "env": {}
    }
  }
}
```

## JetBrains IDEs

`~/.jetbrains/acp.json`:
```json
{
  "agents": [
    { "name": "Kiro", "command": ["npx", "kiro-agent-acp"] }
  ]
}
```

## CLI Options

```bash
kiro-agent-acp [--agent <name>] [<extra-kiro-args>...] [-- <extra-kiro-args>]
```

| Flag | Description |
|------|-------------|
| `--agent <name>` | Use a specific Kiro agent |
| `<extra-kiro-args>` | Any other flags (e.g. `--trust-all-tools`) are forwarded to `kiro-cli acp` |
| `-- <args>` | Everything after `--` is also forwarded to `kiro-cli acp` |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `KIRO_CLI_PATH` | Override the path to `kiro-cli` |

## Architecture

```
Editor (Zed/JetBrains)  ←→  kiro-agent-acp (pipe)  ←→  kiro-cli acp
       stdin/stdout              transparent              stdin/stdout
```

All ACP protocol messages — `initialize`, `session/new`, `session/prompt`, `session/set_config_option`, etc. — pass through unchanged. The model/agent/thinking selectors you see in the editor come directly from `kiro-cli acp`.

## Why not use kiro-cli acp directly?

You can! If kiro-cli is in your PATH, just configure your editor to run `kiro-cli acp` directly. This package exists for:

1. **ACP Registry distribution** — one-click install in Zed/JetBrains
2. **npx convenience** — no global install needed
3. **Future enhancements** — a place to add editor-specific features on top

## Development

```bash
npm install
npm run build
npm start
```

## License

[Apache-2.0](LICENSE)
