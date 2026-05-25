# Shared Workspace and Agent Memory TODO

Date: 2026-05-25

## TODO

Design a memory system that works at two levels:

1. **Workspace memory** — durable context attached to a Paperclip workspace/project so future runs can recall decisions, constraints, local setup, and gotchas.
2. **Shared agent memory** — cross-agent memory within a company so agents can share relevant lessons, artifacts, and state without leaking secrets or stale transient details.

## Initial questions

- What memory is company-scoped vs project-scoped vs workspace-scoped vs agent-private?
- What should be automatically captured, and what requires explicit operator approval?
- How should memories decay, be corrected, or be deleted?
- How do agents cite memories in work output so operators can audit stale context?
- How do we prevent secrets, credentials, and private customer data from being stored?

## Notes

Keep this as a product/design TODO until there is a concrete spec.
