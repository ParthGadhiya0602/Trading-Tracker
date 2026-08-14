# Codex agent workflow

Use smallest team and shortest handoff that can safely finish work. Never read local `.env`,
legacy configuration, `CLAUDE.md`, `CLAUDE.local.md`, or `.claude/**`.

Sol owns investigation, architecture, research, UI design, diagnostics, and review. Terra owns
backend/frontend code. Use medium reasoning by default; use high only for hard R&D, security,
or genuinely ambiguous cross-cutting design. Every subagent uses `fork_turns: "none"` and a
narrow manifest. Main thread is Integrator and owns root/docs/shared integration, verification,
staging, and user communication. It never commits or pushes.

## Lean delivery flow

```text
INTAKE -> optional INVESTIGATE or ARCHITECT -> BUILD -> VERIFY
       -> optional REVIEW -> STAGE -> USER REVIEW/COMMIT
```

- Do not run Explorer and Architect automatically. Use Explorer only when code location/flow
  is unclear. Use Architect only when API, state, persistence, security, or lifecycle choices
  need a contract. Explorer may escalate to Architect only after finding real ambiguity.
- Backend is staged, reviewed, and committed by the user before dependent UI work starts.
  UI-only work may skip backend when no API/state/permission/persistence/config change exists.
- Use UI Designer only for a new or materially changed interaction, not routine CSS fixes.
- Use Reviewer only for risky or cross-cutting behavior: auth/RBAC, persistence, alerts,
  market/feed state, concurrency, security, shared contracts, or large responsive UI changes.
  Integrator self-reviews small docs, copy, and obvious local edits.
- Maximum two subagents per phase: one working role and one independent reviewer. Parallel
  investigators are allowed only when search areas do not overlap.

## Routing

| Task | Route |
|---|---|
| Trivial/root/docs/local fix | Integrator |
| Clear non-trivial backend/frontend | one Terra engineer |
| Unknown code location | one compressed Sol Explorer |
| Contract decision | one Sol Architect, no Explorer unless needed |
| Narrow external fact | one Sol Researcher |
| WSS/SSE/feed diagnosis | one Sol Stream Diagnostics |
| Risky completed diff | one compressed Sol Reviewer |

Prefer cavecrew investigator/builder/reviewer presets for narrow locate/edit/review work.
Subagents return facts, not prose. Output limits:

- Explorer, Researcher, Diagnostics, Reviewer: 250 tokens.
- Architect and UI Designer: 400 tokens.
- Backend and Frontend: 200 tokens.

If output would exceed its limit, write only blockers, decisions, changed files, and checks.
Never dump full files, diffs, logs, or repeated acceptance criteria into handoffs.

## Compact manifest

```text
Goal:
Acceptance:
Files owned:
Protected dirty files:
Checks:
Known limits:
```

Builders edit only owned files and never stage. Integrator preserves unrelated changes. A
thread keeps one role; reuse it only for substantive same-role corrections. Integrator fixes
small obvious review findings directly. After edits, re-run affected checks and re-review only
the changed findings. After two failed correction rounds, ask Architect; after three, ask user.

If an agent gives no useful update for 60 seconds, request status once, wait 90 seconds, then
interrupt. Allow one same-role replacement only.

## Engineering rules

New backend domains use focused classes, constructor dependency injection, encapsulated state,
composition, typed errors, and explicit cleanup. Do not mass-convert stable modules. Extract a
shared utility only for two consumers or one stable cross-cutting rule; keep one-use helpers
private and stateless helpers as functions. Follow DRY, KISS, and SOLID.

New unit tests are not required unless user requests them. Use proportional syntax, focused
API/module, existing-test, smoke, screenshot, responsive, or authorized-live checks.

## Staging and user review

After implementation and required review pass, Integrator immediately stages only manifest
files and verifies staged names. User reviews staged diff and performs commit. Integrator never
runs `git commit`, sets `--author`, stages whole worktree, or pushes.
