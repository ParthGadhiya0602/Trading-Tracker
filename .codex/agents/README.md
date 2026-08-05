# Codex sub-agent roster

These are project-local role prompts for Codex sub-agents. For a task that benefits from
delegation, the main Codex agent reads the applicable profile and spawns a focused agent
with that role. Profiles do not grant additional permissions or override repository safety
rules.

Use the smallest useful team. Spawn exploration, architecture, research, UI design, stream
diagnostics, and review roles with `gpt-5.6-sol`; spawn backend and frontend code-generation
roles with `gpt-5.6-terra`.

- `explorer.md` first for an unfamiliar request or bug report.
- `architect.md` turns the explorer map into a scoped feature plan. It may hand a narrow
  external-fact question to `researcher.md`.
- `ui-designer.md` turns UI work into an implementable design specification.
- `backend.md` and/or `frontend.md` receive only the architect's scoped tasks and the UI
  specification where applicable.
- `reviewer.md` after implementation.
- `stream-diagnostics.md` for WSS, SSE, REST-cache, or market-state issues.

Keep distinct agents on distinct files. The main agent owns integration, user communication,
and final verification.

## Feature workflow

1. Explorer maps the current code with file-and-line evidence.
2. Architect produces scope, risks, verification, and an explicit task split.
3. Researcher verifies only external facts that block the plan.
4. UI Designer produces the UI contract when frontend work is needed.
5. Backend and Frontend implement their independent task lists; run in parallel only when
   their files do not overlap.
6. Reviewer verifies the resulting diff; the appropriate engineer fixes confirmed issues.
