---
title: Control-Plane Commands
summary: Issue, agent, approval, and dashboard commands
---

Client-side commands for managing issues, agents, approvals, and more.

## Issue Commands

```sh
# List issues
pnpm paperclipai issue list [--status todo,in_progress] [--assignee-agent-id <id>] [--match text]

# Get issue details
pnpm paperclipai issue get <issue-id-or-identifier>

# Create issue
pnpm paperclipai issue create --title "..." [--description "..."] [--status todo] [--priority high]

# Update issue
pnpm paperclipai issue update <issue-id> [--status in_progress] [--comment "..."]

# Add comment
pnpm paperclipai issue comment <issue-id> --body "..." [--reopen]

# Checkout task
pnpm paperclipai issue checkout <issue-id> --agent-id <agent-id>

# Release task
pnpm paperclipai issue release <issue-id>

# Delete issue
pnpm paperclipai issue delete <issue-id> [--yes]

# Inspect compact heartbeat context
pnpm paperclipai issue heartbeat-context <issue-id>

# Comments
pnpm paperclipai issue comments-list <issue-id>
pnpm paperclipai issue comment-get <issue-id> <comment-id>

# Extended issue resources
pnpm paperclipai issue create-child <parent-issue-id> --payload '{...}'
pnpm paperclipai issue document --help
pnpm paperclipai issue work-product --help
pnpm paperclipai issue interaction --help
pnpm paperclipai issue feedback --help
```

There is no `issue attachment-upload` command in the current CLI build. Run
`pnpm paperclipai issue --help` before documenting or scripting a niche issue
subcommand.

## Company Commands

```sh
pnpm paperclipai company list
pnpm paperclipai company get <company-id>

# Export to portable folder package (writes manifest + markdown files)
pnpm paperclipai company export <company-id> --out ./exports/acme --include company,agents

# Preview import (no writes)
pnpm paperclipai company import \
  <owner>/<repo>/<path> \
  --target existing \
  --company-id <company-id> \
  --ref main \
  --collision rename \
  --dry-run

# Apply import
pnpm paperclipai company import \
  ./exports/acme \
  --target new \
  --new-company-name "Acme Imported" \
  --include company,agents
```

## Agent Commands

```sh
pnpm paperclipai agent list
pnpm paperclipai agent get <agent-id>
pnpm paperclipai agent local-cli <agent-id-or-shortname> --company-id <company-id>
```

`agent local-cli` creates a long-lived agent key, installs local Paperclip skills
for Claude/Codex, and prints `PAPERCLIP_*` shell exports for manual local agent
runs.

## Approval Commands

```sh
# List approvals
pnpm paperclipai approval list [--status pending]

# Get approval
pnpm paperclipai approval get <approval-id>

# Create approval
pnpm paperclipai approval create --type hire_agent --payload '{"name":"..."}' [--issue-ids <id1,id2>]

# Approve
pnpm paperclipai approval approve <approval-id> [--decision-note "..."]

# Reject
pnpm paperclipai approval reject <approval-id> [--decision-note "..."]

# Request revision
pnpm paperclipai approval request-revision <approval-id> [--decision-note "..."]

# Resubmit
pnpm paperclipai approval resubmit <approval-id> [--payload '{"..."}']

# Comment
pnpm paperclipai approval comment <approval-id> --body "..."
```

## Activity Commands

```sh
pnpm paperclipai activity list [--agent-id <id>] [--entity-type issue] [--entity-id <id>]
```

## Dashboard

```sh
pnpm paperclipai dashboard get
```

## Heartbeat

```sh
pnpm paperclipai heartbeat run --agent-id <agent-id> [--api-base http://localhost:3100]
```
