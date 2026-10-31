# Regenerating README screenshots

The PNGs in this directory come from demo mode, captured by
`scripts/capture-screenshots.ts` with a local headless Chrome.

## Capture the README set

```bash
cd /path/to/synthesis-console
PORT=5577 bun run demo &          # bundled sample data only; any free port works
SYNTHESIS_TEST_CHROMIUM="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  bun run scripts/capture-screenshots.ts --base http://localhost:5577 --out screenshots --readme
```

`--readme` writes the files below at 1440 × 900, light theme. `SYNTHESIS_TEST_CHROMIUM` is the
same variable the browser accessibility test reads; any Chrome or Chromium binary works.

| Filename | URL | What it shows |
|----------|-----|---------------|
| `today.png` | `/` | Today: the plan card (the latest demo plan stands in for today's), system health note, portfolio, ledger digest, recently active projects |
| `dashboard.png` | `/projects` | Projects grouped by initiative: one-line toolbar, status chips with counts, cards |
| `filtered.png` | `/projects?status=active&group=status` | The same list narrowed to one status, grouped by status |
| `project-detail.png` | `/projects/demo/synthesis-console` | Working memory (CONTEXT.md) beside the rail: resume prompt, details, session logs |
| `initiatives.png` | `/initiatives` | Initiative cards with health and member-status rollups |
| `lessons.png` | `/lessons` | Lessons by month with the filter field |
| `plans-calendar.png` | `/plans` | Month calendar with plan days marked; recent plans and carried tasks in the rail |
| `plan-detail.png` | `/plans/demo/2026-07-06` | The plan page: the day at a glance, NEEDS YOU, header lines, the context rail |
| `ledger.png` | `/ledger` | Catch-up ledger: open counts, then the state-grouped tables |
| `people.png` | `/people` | Commitments and touchpoints (demo data read as of its newest plan) |

## Review every view in light, dark and phone

```bash
SYNTHESIS_TEST_CHROMIUM=... bun run scripts/capture-screenshots.ts \
  --base http://localhost:5577 --out /tmp/console-shots --modes light,dark,phone --full
```

This writes `<view>-<mode>.png` for every demo view, full page. Point `--base` at a
Console running your own sources and add `--live` for the views that do not exist in
demo mode (conformance, context, sync, conversations); keep those captures private,
since they show your repositories and projects. `--only today,projects` limits the set.

## After capturing

```bash
ls -lh screenshots/        # each README image is usually 100–400 KB
git add screenshots/*.png
git commit -m "Refresh README screenshots"
```
