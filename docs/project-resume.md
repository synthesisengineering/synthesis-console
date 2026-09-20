# Project resume

One prompt resumes any synthesis project in any harness on any
machine. The console is the launch surface; the
`synthesis-project-resume` skill (synthesis-skills) is the engine.
Normative requirements: R1–R10 in the skill's
`references/requirements.md`. This file documents the console half.

## What the console renders

- `/projects` lists recently-active-first by default. Recency is the
  newest session-file mtime per project, falling back to the index
  date fields (`last_session`, `completed_date`, `started_date`),
  falling back to last. `?sort=name` and `?sort=status` reorder
  within the existing groupings; unknown values fall back to recent.
- Every row shows a relative recency label ("2h ago") and a Resume
  button that copies the R1 prompt:
  `Resume synthesis project <id> (source <name>).` plus the
  skill-file line.
- The detail page shows the same prompt in a "Resume in any harness"
  block with a copy button, plus recency and newest session period.

## Skill-path resolution

The prompt's `Skill:` line is resolved live per request by
`resolveSkillFile("synthesis-project-resume", "SKILL.md")`, newest
install wins across the `~/.synthesis/skills` route, the Claude /
Codex / Muse plugin caches (including the Muse `package/`-nested
layout), and the user-skill dirs. When no install carries the skill
yet, the prompt names the skill and says to install synthesis-skills
instead of emitting a dead path.

## Paste it anywhere

The prompt works in Claude Code, Codex, and Muse (which resolve the
named skill natively) and in skill-less harnesses (which read the
absolute skill path). The skill classifies the session — continuing,
fresh, or wrong-project paste — and refuses to strand live work.

## Guarantees the console keeps

- Read-only: the console renders prompts, never writes to repos.
- No new dependencies for this surface.
- Graceful absence: missing sessions dirs, missing installs, and
  unknown sort modes all degrade to declared fallbacks.
