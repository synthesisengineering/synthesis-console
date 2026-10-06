# Project resume

One prompt resumes any synthesis project in any harness on any
machine. The console is the launch surface; the
`synthesis-project-resume` skill (synthesis-skills) is the engine.
Normative requirements: R1–R10 in the skill's
`references/requirements.md`. This file documents the console half.

## The prompt shape (R1)

```
Use the skill synthesis-project-resume to resume the synthesis
project with id <id> in the synthesis project management
workspace <name>.
```

The prompt names the project-management workspace (not the console
source key) and the skill by name. It never embeds a filesystem
path, so it is identical on every machine: no client name, no
release version. Native harnesses (Claude Code, Codex, Muse)
invoke the skill by name; skill-less harnesses locate the skill
file via the lookup order in the skill's §1.

## What the console renders

- `/projects` lists recently-active-first by default. Recency is the
  newest session-file mtime per project, falling back to the index
  date fields (`last_session`, `completed_date`, `started_date`),
  falling back to last. `?sort=name` and `?sort=status` reorder
  within the existing groupings; unknown values fall back to recent.
- Every row shows a relative recency label ("2h ago") and a "Copy
  resume prompt" button that copies the R1 prompt.
- The detail page shows the same prompt in a "Resume in any coding
  agent" block with a one-line how-to and a copy button, plus recency
  and newest session period.

## Workspace resolution

The `workspace` line comes from the source's `workspace` field in
`console.yaml`, defaulting to the parent directory of the source
root (the workspace in the standard
`~/workspaces/<name>/ai-knowledge-*` layout). The receiving agent
resolves it per the skill: `ai-knowledge-{workspace}` under the
workspace roots.

## Skill-presence detection

The console checks for any install of `synthesis-project-resume`
via `resolveSkillFile` (the synthesis v5 runtime at
`$SYNTHESIS_HOME/current/skills`, then the Claude Code / Codex /
Muse plugin caches including the Muse `package/`-nested layout,
counting only plugin versions that carry the v5 runtime package)
purely to decide whether to warn. When no install carries the skill yet, the
prompt gains a second sentence saying to install synthesis-skills.
No filesystem path is ever emitted.

## Guarantees the console keeps

- Read-only: the console renders prompts, never writes to repos.
- No new dependencies for this surface.
- Graceful absence: missing sessions dirs, missing installs, and
  unknown sort modes all degrade to declared fallbacks.
