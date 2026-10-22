# NOVA — AI Workspace

[![OpenRepos](https://img.shields.io/endpoint?url=https://openrepos.org/status/ghostlord.openrepos.org.json&style=flat-square)](https://ghostlord.openrepos.org/)

NOVA is a no-framework Node.js web app with five specialist agent personas, persistent SQLite conversations, a memory vault, and a usage dashboard. It runs locally for free and includes a Render free-tier deployment blueprint.

## Run locally (Termux / Node.js 22.5+)
```sh
cd ~/projects/nova-agent
npm start
``
Open http://127.0.0.1:3000. SQLite is created at `data/nova.sqlite`.

## Real AI (optional)
Install Ollama and download a model that fits your device:
```sh
ollama serve
# in another terminal
ollama pull qwen2.5:0.5b
``
Then restart NOVA. Server settings:
- `OLLAMA_HOST` defaults to `http://127.0.0.1:11434`
- `OLLAMA_MODEL` defaults to `qwen2.5:0.5b`

The model runs on the machine hosting NOVA. If Ollama is offline, the API returns a clearly labelled demo fallback. Never expose Ollama directly to the public internet without strong access controls.

## Features
- Responsive dashboard, chat, agent studio, and memory vault
- NOVA, Researcher, CodePilot, Wordsmith, and Strategist role prompts
- SQLite-persisted conversations, messages, and explicit memories
- Memory context added to local-model prompts
- Anonymous browser sessions isolate each visitor's chats and memories using HttpOnly, SameSite cookies
- JSON APIs: `/api/health`, `/api/dashboard`, `/api/chats`, `/api/memory`, `/api/chat`
- No paid AI API, frontend framework, or third-party runtime package

## Public free-tier deployment (Render)
1. Push this folder to a Git repository you control.
2. Create a Render Web Service from the repository; Render can use the included `render.yaml`.
3. The service is configured for Render's free plan and public HTTPS.
4. Render free instances can sleep and their filesystem is ephemeral. SQLite data can be lost on redeploy/restart. Durable storage may require a paid disk or a separate hosted database.
5. The Termux phone's `127.0.0.1` is not reachable from Render. Unless a model is separately hosted and securely configured, the public deployment will use demo fallback responses rather than real LLM inference.

## Limitations
- No user accounts or password recovery; workspace identity lives in an anonymous browser cookie. Clearing browser cookies loses access to that anonymous workspace.
- No per-session rate limiting, web search, tool execution, or automatic memory extraction yet.
- Agent routing is specialist prompt routing to one model, not an autonomous multi-agent swarm.
- For production with sensitive data, add stronger authentication, rate limiting, monitoring, backups, and durable storage.
