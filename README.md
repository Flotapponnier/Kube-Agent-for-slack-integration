# Kube-Agent 🤖

An AI-powered Kubernetes assistant for Slack. Ask questions about your cluster in natural language, or use the interactive command builder to execute kubectl commands with safety confirmations.

## Features

- **Natural Language Queries**: Ask questions like "Why is my pod crashing?" and get AI-powered diagnostics
- **Interactive Command Builder**: Build and execute kubectl commands with dropdown menus
- **Read Operations**: get, logs, describe, top, events, rollout-status, rollout-history
- **Write Operations**: delete, restart, scale (with confirmation prompts)
- **Safety First**: Write operations require explicit confirmation, AI cannot execute destructive commands
- **Conversation Memory**: Follow-up questions in threads maintain context

## Quick Start

### 1. Create a Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Click "Create New App" → "From scratch"
3. Name it (e.g., "Kube-Agent") and select your workspace

### 2. Configure Slack App

**OAuth & Permissions** - Add these Bot Token Scopes:
- `app_mentions:read`
- `chat:write`
- `im:history`
- `im:read`
- `im:write`

**Socket Mode**:
- Enable Socket Mode
- Generate an App-Level Token with `connections:write` scope

**Event Subscriptions**:
- Enable Events
- Subscribe to: `app_mention`, `message.im`

### 3. Install & Run

```bash
# Clone the repo
git clone https://github.com/YOUR_USERNAME/kube-agent.git
cd kube-agent

# Install dependencies
bun install

# Copy and configure environment
cp .env.example .env
# Edit .env with your tokens

# Run locally (uses your local kubeconfig)
bun run src/index.ts

# Or with Docker
docker build -t kube-agent .
docker run --env-file .env -v ~/.kube:/root/.kube:ro kube-agent
```

### 4. Deploy to Kubernetes

```bash
# Using Helm
helm install kube-agent ./helm-chart \
  --set slack.botToken=$SLACK_BOT_TOKEN \
  --set slack.appToken=$SLACK_APP_TOKEN \
  --set openai.apiKey=$OPENAI_API_KEY
```

## Usage

### Natural Language (AI)
```
@kube-agent why is the api pod crashing?
@kube-agent show me pods with high memory usage
@kube-agent what happened to listener-base in the last hour?
```

### Command Builder
```
@kube-agent command
```
Then use the interactive dropdowns to build your command.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SLACK_BOT_TOKEN` | Yes | Bot token starting with `xoxb-` |
| `SLACK_APP_TOKEN` | Yes | App token starting with `xapp-` |
| `OPENAI_API_KEY` | Yes | OpenAI API key |
| `OPENAI_MODEL` | No | Model to use (default: `gpt-4o`) |
| `LOG_LEVEL` | No | Logging level (default: `info`) |

## Security

- **Read-only by default**: AI can only read cluster information
- **Write confirmation**: Delete, restart, and scale require explicit confirmation
- **RBAC**: Uses ClusterRole with minimal required permissions
- **No secrets exposed**: AI cannot read secret values

## License

MIT
