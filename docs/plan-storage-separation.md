# Plan storage separation — fragments and the shell

**Status:** design documented; renderer support **not yet implemented**. The console
currently renders each `plans_dir` file as-is. This document specifies the model the
console is expected to adopt, and the config surface it will use, so that plans written
under the separated model are already correctly shaped when the renderer lands.

Companion doctrine: `synthesis-daily-rituals` v2.24.0 and its
`references/ritual-worker-contract.md` ("Plan storage separation"). This document is the
console-side view of the same design.

## The problem

A daily plan naturally wants to be one document — one person, one day, one list. But a
person who works across multiple organizations accumulates, in that one document, a mixed
record: this client's decisions beside that employer's meetings beside personal errands,
one day at a time, for years.

That mixing has a cost that only shows up at the end of a relationship. When an engagement
ends — a contract completes, an employment ends, a client parts ways — the organization's
data should leave the machine with it. In many environments that is not merely tidy, it is
mandatory: banks, government work, healthcare, and regulated contract work routinely
require that all of the organization's data be removed from a contributor's devices at
termination. If the daily plans have been accreting that organization's content into a
personal repository, then deleting the organization's folders does not achieve it, and the
residue is spread across hundreds of files with no clean way to find it.

The requirement, stated plainly: **deleting an organization's workspace folders must
remove that organization's data.** Everything else in this design follows from it.

## The model

Separate **storage** from **presentation**. They were only ever conflated because a single
file happened to serve both.

- **Fragment.** Each workspace's plan content — its decisions, its calendar
  contributions, its correspondence, its waiting-ons, its brief — lives in a file inside
  *that workspace's own private repository*. Under the ritual-worker contract this file
  already exists: it is the worker artifact (`ritual-workers/YYYY-MM-DD-<run_type>.md`).
  The artifact and the plan fragment are the same object; there is no second file and no
  copy.
- **Shell.** The person-scoped daily plan holds only what belongs to the person: the
  coverage line, the day's own timeline, cross-workspace conflicts stated at the minimum
  cross-reference needed, the permanent personal section, person-scoped carryover, and
  **pointer lines** to each fragment.
- **Display-time merge.** The console (and any other consumer) reads the shell, resolves
  its pointers, and renders one view. The reader still sees one brief for the day.

The slogan is *fan out execution, converge presentation* — and this adds: **separate
storage, converge presentation**. A converged view is a rendering decision. It never
required a converged file.

## Why the fragment belongs in the *private* repository

Workspaces commonly come in pairs: a shared repository that colleagues in the organization
can also read, and a private repository belonging to the individual. A daily plan fragment
is the individual's own working record of that engagement — their triage, their judgments,
their drafts, their read of what matters. It belongs in the **private** repository, beside
the other material that is theirs alone about that organization.

Both repositories sit under the same workspace directory, so both are removed by the same
deletion. The distinction matters for who can read the fragment while the engagement is
live, not for erasure.

## What erasure does and does not remove

State this honestly to anyone relying on it:

**Removed** with the workspace folders: all fragment content — every decision, meeting
note, correspondence record, and brief line that workspace ever contributed.

**Retained** person-side: the workspace's *name* where it appears as a reference, dangling
pointers in old shells, the person's own timeline entries, and the person repository's git
history of those shells.

For most people that boundary is the right one — a former employer's name is public
knowledge, and the person's own calendar is their own record. For regimes that treat
even event titles or the organization's identity as erasable data, the contract specifies
a **strict shell**: the timeline carries generic labels ("committed — see fragment") and
all titles resolve from fragments at display time, so a deleted fragment takes its titles
with it. That is a per-person policy set once, not a per-day decision.

## Config surface (planned)

Sources gain one optional key:

```yaml
sources:
  - name: personal
    root: ~/knowledge/personal
    plans_dir: daily-plans          # the shells
    default_active: true

  - name: example-client
    root: ~/workspaces/example-client/knowledge-example-client-private
    projects_dir: projects
    fragments_dir: ritual-workers   # this workspace's plan fragments
```

- `fragments_dir` — relative path to the workspace's ritual-worker artifacts (expects
  `YYYY-MM-DD-<run_type>.md`). Declaring it makes the source contribute fragments to the
  merged plan view for matching dates.
- A source may declare `fragments_dir` without `plans_dir`: it contributes content to the
  day without owning a plan file. That is the normal shape for a client or employer
  workspace.
- `plans_dir` continues to mean "this source owns plan files." In the separated model
  exactly one source (the person's) normally declares it.

## Renderer behavior (planned)

1. Load the shell for the date from the source owning `plans_dir`.
2. For each active source declaring `fragments_dir`, load the newest fragment per
   `run_type` for that date.
3. Render one page: the shell's sections, with each pointer expanded in place to its
   fragment's content, badged with the source it came from.
4. **A pointer whose fragment is missing renders as an explicit unresolved marker** —
   never silently omitted. A workspace that was deleted, or a worker that did not run,
   must be visible as such. The plan's coverage line already states this in text; the
   renderer should agree with it rather than quietly showing a shorter page.
5. Source selection still filters: deselecting a workspace hides its fragments, which is
   also the mechanism behind focus views and screen-share hiding.

## Relationship to focus and demo-hiding

Storage separation makes the console's workspace filters stronger than a display toggle.
When a workspace's content lives in its own files, hiding it is not a matter of the
renderer choosing to skip sections — the content simply is not loaded. That is the right
foundation for the demo-hiding requirement (suppressing selected workspaces while
screen-sharing), which must fail closed: if the console cannot determine what to hide, it
hides rather than reveals.

## Migration

Plans written before adoption are mixed by construction and stay as they are; splitting
them is a deliberate migration, not something a renderer should attempt. The console
should therefore treat a shell-less plan file (no coverage line, no pointers) as a
complete legacy plan and render it as it does today. Both shapes coexist indefinitely.
