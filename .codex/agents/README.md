# Codex agent workflow

These project-local profiles define the Codex team for Trading Tracker. Profiles do not grant
extra permissions or override repository safety rules. Never read local `.env`, legacy
configuration files, `CLAUDE.md`, `CLAUDE.local.md`, or `.claude/**`.

Use `gpt-5.6-sol` for Explorer, Architect, Researcher, UI Designer, Reviewer, and Stream
Diagnostics. Use `gpt-5.6-terra` for Backend and Frontend implementation. The main Codex
thread is the Integrator: it owns task intake, the manifest, root/tooling/docs changes,
integration, user communication, final verification, and commits. Do not create Planner,
Builder, or Integrator sub-agent profiles.

## Delivery order

Backend is decided and delivered before UI:

```text
INTAKE -> DISCOVERY -> BACKEND DESIGN -> BACKEND BUILD -> VERIFY -> REVIEW
       -> USER REVIEW -> APPROVAL -> BACKEND COMMIT
       -> UI DESIGN -> FRONTEND BUILD -> VERIFY -> REVIEW
       -> USER REVIEW -> APPROVAL -> UI COMMIT -> DONE
```

- Skip the backend lane only for a genuinely UI-only change with no API, state, permission,
  persistence, configuration, or payload impact.
- UI Designer and Frontend consume the committed backend contract. They must not invent API
  fields, states, permissions, or error behavior.
- A later phase cannot start until the current phase has Reviewer `PASS` and, when files
  changed, a user-approved commit.
- Reviewer `CHANGES_REQUIRED` returns work to the same-role engineer, followed by verification
  and mandatory re-review.

## Task routing and slots

Use the smallest useful team. The platform budget is the main thread plus at most three agent
threads; reserve one slot for an independent Reviewer.

| Work | Route |
|---|---|
| Small, clear, <=2 files | Integrator implements, verifies, then Reviewer when behavior changes |
| Backend feature | Explorer if unclear -> Architect -> Backend -> Reviewer |
| UI feature | Confirm backend contract -> UI Designer -> Frontend -> Reviewer |
| Cross-cutting feature | Explorer -> Architect -> backend lane/commit -> UI lane/commit |
| External fact | Researcher receives one narrow question from Architect |
| WSS/SSE/feed incident | Stream Diagnostics -> Architect/Backend only if a fix is approved |

Each thread keeps one role for its lifetime. Never turn an Explorer into an Architect or
Reviewer. Reuse a thread only for follow-up in the same role, such as a Backend engineer fixing
its reviewed patch. If an agent gives no useful update for 60 seconds, request status once and
allow a two-minute grace period, then interrupt it. Spawn at most one fresh same-role
replacement; repeated failure is escalated to the user.

## Task manifest

The Integrator maintains this compact manifest in the working plan:

```text
Objective:
Acceptance criteria:
Current phase:
In-scope files:
Protected/unrelated dirty files:
Owners:
Required checks:
Active agent slots:
Review iteration:
User approval: pending|confirmed
Commit: pending|hash
Known exceptions:
```

Builders edit only assigned files. The Integrator owns repository-root configuration,
tooling, documentation, shared-file integration, and any file not assigned to a specialist.
All agents preserve unrelated dirty changes.

## Backend design rules

For new backend domains, prefer class-based design with clear responsibilities:

- constructor dependency injection; no hidden environment, network, clock, or storage access;
- encapsulated state and explicit lifecycle methods such as `start`, `stop`, and `dispose`;
- composition over inheritance and one responsibility per provider, service, store, or
  controller class;
- typed domain/provider errors and stable public contracts;
- no mass conversion of stable functional modules merely for consistency.

Extract a common utility when at least two modules use it or it represents a stable shared
rule such as date parsing, numeric normalization, safe HTTP handling, or SSE writing. Keep a
single-use helper private. Stateless helpers remain functions; do not create utility classes
only to appear object-oriented. Follow DRY, KISS, and SOLID without premature abstraction.

## Verification and review

New unit tests are not required. Do not add unit tests unless the user explicitly requests
them. Use proportional verification: syntax checks, focused module/API checks, safe server
smoke checks, existing tests when useful, browser screenshots for visual work, and authorized
live-feed checks only when necessary. Document anything that could not be verified safely.

Reviewer reads the manifest-scoped diff and necessary surrounding code, distinguishing
task-introduced defects from unrelated dirty changes and optional improvements. A review ends
only with `PASS` or `CHANGES_REQUIRED`. After two unsuccessful correction rounds, Architect
reopens the contract; after a third, stop and ask the user for direction.

## User review and commit gate

Only the Integrator may stage or commit. After Reviewer `PASS`, tell the user the changes are
ready in their editor without dumping the diff into chat. Wait for explicit approval. Any
subsequent edit invalidates approval and returns to verification and review.

After approval, stage only manifest files, inspect the staged file list, and create a normal
local commit using the user's configured Git identity. Never set `--author`, auto-push, stage
the whole dirty worktree, or include unrelated files. Report the commit hash and exact scoped
file set.
