# Workspace Orchestration — Working Context

**Status:** Ongoing — 🔴 nightly sync job failing since Apr 10, needs attention
**Last session:** 2026-04-11

---

## Current State

The multi-workspace model is stable and in daily use. Each workspace maps to a person or organization, with an ai-knowledge repo serving as the orchestration layer.

## Key Convention

```
~/.claude/CLAUDE.md              → Global identity
~/workspaces/{name}/CLAUDE.md    → Workspace context
{repo}/CLAUDE.md                 → Repo-specific rules
```

Workspace contexts inherit from the root personal workspace. CLAUDE.md files auto-load at session start, providing the agent with full project awareness.

---

*This file follows the Tiered Context Architecture.*
