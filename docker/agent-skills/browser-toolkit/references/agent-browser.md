# agent-browser

Source before consolidation: `/Users/luke/.agents/skills/agent-browser`

---
name: agent-browser
disable-model-invocation: true
description: Sub-skill of /browser-toolkit. Browser automation CLI via Chrome CDP — navigation, forms, clicks, screenshots, scraping, QA. Also automates Electron apps (Slack, Discord, VS Code, Notion) and Vercel Sandbox / Bedrock AgentCore cloud browsers. Loaded by /browser-toolkit; do not invoke directly.
allowed-tools: Bash(agent-browser:*), Bash(npx agent-browser:*)
---

# agent-browser

Browser automation CLI for AI agents. Uses Chrome/Chromium via CDP directly.

Install: `npm i -g agent-browser && agent-browser install`

## Command Reference

Use the installed CLI as the source of truth for syntax:

```bash
agent-browser --help
agent-browser <command> --help
```

This browser-toolkit child reference is already the loaded workflow. The local CLI
does not need a separate skill-loading command before browser automation.

## Core Workflow

1. Reuse or name a session with `--session <name>` / `AGENT_BROWSER_SESSION`.
2. Navigate with `agent-browser open <url>`.
3. Inspect structure with `agent-browser snapshot`; prefer returned refs for actions.
4. Use targeted primitives (`find`, `click`, `fill`, `type`, `press`, `scroll`) for interaction.
5. For visual/CSS debugging, combine `screenshot`, `get box`, `get styles`, and `eval <js>`.
6. Check console/network state with `errors`, `console`, and `network requests` when debugging app behavior.

## Why agent-browser

- Fast native Rust CLI, not a Node.js wrapper
- Works with any AI agent (Cursor, Claude Code, Codex, Continue, Windsurf, etc.)
- Chrome/Chromium via CDP with no Playwright or Puppeteer dependency
- Accessibility-tree snapshots with element refs for reliable interaction
- Sessions, authentication vault, state persistence, video recording
- Specialized skills for Electron apps, Slack, exploratory testing, cloud providers
