---
name: paperclip-git-identity
description: >
  Configure git commit identity so commits made during a heartbeat are
  attributed to the acting agent, not "node@<pod-name>". Use before any git
  commit in the paperclip pod. Env-var pattern that survives the run boundary
  and reads cleanly in git log + GitHub.
---

# Paperclip git identity

**Trigger:** any heartbeat that will make a git commit (workspace edits, repo bumps, infra config changes).

## Why this exists

The paperclip pod runs as `node@<pod-name>`. Without configuration, `git commit` produces commits like:

```
Author: node <node@paperclip-5df49f477-w4kmx>
```

That's untraceable. Multiple agents share the pod; the author should be the **agent**, not the pod.

## The convention

Set git author + committer identity from the agent's facts at the start of any commit work. Format:

| Field | Value |
|---|---|
| `user.name` | The agent's display name. E.g. `Smiles - CEO`, `Bondy - CTO`, `Naledi - CFO`. |
| `user.email` | The agent's mailbox address. E.g. `smiles@myhorizon.co.za`, `bondy@myhorizon.co.za`. If the agent has no mailbox, use the role-keyed pseudo-address: `<role>@<company-domain>` (e.g. `cto@smilerite.co.za`). |

The agent's name + mailbox are available from `GET /api/agents/me` (the same call that drives the heartbeat). You already have them in context.

## Set per-run, not globally

Per-run because multiple agents share the pod and global config would collide. Set via env vars (cleanest) or per-repo config (when env vars aren't viable).

### Option A — env vars (preferred)

```bash
export GIT_AUTHOR_NAME="Bondy - CTO"
export GIT_AUTHOR_EMAIL="bondy@myhorizon.co.za"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME"
export GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
```

git honors these for the duration of the shell session. No pod state mutated. Multi-agent safe.

### Option B — per-repo config

When you must (e.g. a long-lived workspace clone shared across runs), set the repo-local config:

```bash
git -C <repo-path> config user.name "Bondy - CTO"
git -C <repo-path> config user.email "bondy@myhorizon.co.za"
```

Avoid this when possible — it leaves persistent state on the PVC.

## Embed in a commit-prep helper

For agents that commit frequently, wrap the setup in one line at run start:

```bash
git_identity_from_paperclip() {
  local me
  me=$(curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" "$PAPERCLIP_API_URL/api/agents/me")
  export GIT_AUTHOR_NAME="$(echo "$me" | jq -r '.name')"
  export GIT_AUTHOR_EMAIL="$(echo "$me" | jq -r '.mailbox // (.role + "@" + (.company.domain // "agent.local"))')"
  export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME"
  export GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
  echo "git identity: $GIT_AUTHOR_NAME <$GIT_AUTHOR_EMAIL>"
}
```

Call `git_identity_from_paperclip` once at the start of any heartbeat that will commit.

## Trailers for run traceability

Commits made by an agent should carry a `Co-authored-by` or `Run-id` trailer so the audit trail links back to the Paperclip run:

```
feat: add BobGo international address mapping

Closes SMI-179.

Co-authored-by: Paperclip Run <run-${PAPERCLIP_RUN_ID}@paperclip.local>
```

Or, terser:

```
Run-Id: ${PAPERCLIP_RUN_ID}
Issue: SMI-179
```

The exact trailer format is per-repo convention. Pick one and stick with it. The trailer is what makes `git log` traceable to specific heartbeats.

## When committing on behalf of a peer

You sometimes carry an edit produced by another agent (e.g. a CTO commit applied by COO during a freeze window — rare but possible). Use the **Co-authored-by** trailer for the originator, but `GIT_AUTHOR_*` still names the committer:

```
fix: <thing>

Co-authored-by: Bondy - CTO <bondy@myhorizon.co.za>
Run-Id: ${PAPERCLIP_RUN_ID}
```

Author = you (the agent running the commit), Co-authored-by = whose work it actually is.

## GitHub attribution

GitHub matches the `user.email` field to GitHub accounts. To make commits show up correctly on GitHub:

- If the agent has a corresponding GitHub account (rare today, but planned for OpenClaw-side agents), use that account's verified email.
- Otherwise, the `@myhorizon.co.za` (or per-company) email is fine; GitHub shows it as a "no avatar" commit, which is honest and correct — these are agent commits.

## Don't

- Don't use `node@<pod-name>` — the default committer. It's untraceable.
- Don't use your **personal** email (Luke's, Nadya's). Agents are not humans; the audit trail breaks if commits look like they came from the owners.
- Don't set git identity globally on the pod. Multi-agent safe = per-run only.
- Don't omit the run-id trailer — it's the only way `git log` traces back to a Paperclip run.
- Don't sign-off commits as a human (no `Signed-off-by: Luke Seeber`) unless the human actually reviewed the commit.

## See also

- `paperclip` — the canonical Paperclip API skill (where `/api/agents/me` comes from).
- `how-we-communicate` — voice for commit messages.
- `resource-access` — when you need access to a private repo you can't push to.
