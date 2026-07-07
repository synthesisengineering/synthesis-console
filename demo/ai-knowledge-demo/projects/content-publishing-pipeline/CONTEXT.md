# Content Publishing Pipeline — Working Context

**Status:** Active — ⚠️ canonical-URL rollout waiting on DNS change
**Last session:** 2026-04-08

---

## Current State

Multi-site publishing workflow is operational. Articles authored in markdown, stored in per-site content repos, aggregated by the primary site via Astro glob loaders. Canonical URLs managed at the content level.

## Architecture

```
content-site-a/content/posts/   → site A renders directly
content-site-b/content/posts/   → site B renders directly
primary-site/                   → reads from both A and B via glob
```

No file duplication. Each article exists in exactly one repo.

## What's Next

1. [ ] Automated cross-site link validation
2. [ ] Pre-publish quality gate integration

---

*This file follows the Tiered Context Architecture.*
