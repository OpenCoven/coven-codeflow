# Coven Dogfood Protocol

This protocol defines how Coven is used to build Coven and CastCodes every day.
The goal is to prove orchestration through repeated use: every meaningful task
should leave behind a clear packet, harness assignment, handoff, verification
record, retrospective note, and captured issue when the work exposes a product
gap.

## Operating Rules

- Use Coven as the default coordination surface for Coven and CastCodes work.
- Keep work packets small enough to finish, review, or hand off in one session.
- Assign the narrowest harness that can prove the task, then record why.
- Prefer evidence from the repo, runtime, tests, screenshots, logs, or GitHub.
- Treat dogfood friction as product evidence, not background annoyance.
- Keep public product docs, marketing copy, and visible product surfaces
  maintainer-authored and free of provider or generation credit.
- PR metadata, commit metadata, and required coauthor trailers remain allowed
  when project policy requires them.

## Artifact Location

Store dogfood packets where future maintainers can find the proof.

- For GitHub-attached work, put the task packet, handoff, verification record,
  retrospective, and issue capture in the relevant issue, PR comment, or review
  thread.
- For local or non-GitHub work, put the record in a dated local dogfood log or
  Coven session artifact. Use `.local/dogfood/YYYY-MM-DD.md` when the repo
  permits local-only artifacts.
- For sensitive or internal-only context, keep a minimal public summary in the
  normal artifact and store the sensitive detail in private memory or private
  notes.

## Daily Cadence

1. Open the day with a queue scan across Coven and CastCodes.
2. Select one task that improves the product or validates a current integration
   path.
3. Write a task packet before starting implementation or review.
4. Assign the task to the right harness and record the expected proof.
5. Execute the work through Coven wherever the current product surface allows.
6. Produce a handoff packet before switching context or requesting review.
7. Run the verification gate and attach exact commands plus results.
8. Capture any product gap discovered during the run as an issue or backlog
   entry.
9. Close with a short retrospective that names one protocol adjustment, product
   fix, or explicit no-change decision.

## Task Packet

Create a task packet before changing code, review state, docs, or release
metadata.

```markdown
## Task Packet

- Repo:
- Branch/worktree:
- Objective:
- Trigger:
- Current evidence:
- Scope:
- Out of scope:
- Harness:
- Required proof:
- Risk:
- Stop condition:
```

Field rules:

- `Repo`: `OpenCoven/coven-code`, `OpenCoven/coven`,
  `OpenCoven/cast-codes`, or another exact repo.
- `Branch/worktree`: current branch, detached worktree label, or canonical path.
- `Objective`: one sentence with the user-visible outcome.
- `Trigger`: issue, PR, release need, local failure, audit item, or direct ask.
- `Current evidence`: links, file paths, failing commands, screenshots, logs, or
  live state that justify the task.
- `Scope`: the smallest set of files, surfaces, or workflow steps expected to
  change.
- `Out of scope`: adjacent ideas that should not expand the task.
- `Harness`: the assigned execution harness from the table below.
- `Required proof`: commands or artifacts needed before handoff.
- `Risk`: what could regress if this is wrong.
- `Stop condition`: the point where the task is complete, blocked, or should be
  handed off.

## Harness Assignment

Assign one primary harness per task. Add a secondary harness only when the proof
requires a different runtime or interface.

| Harness | Use For | Required Output |
| --- | --- | --- |
| `coven-code execute` | Deterministic CLI, SDK, thread, tool, MCP, skill, plugin, and JSON-stream checks | Command, stdout summary, exit status |
| `coven-code panel` | Interactive panel behavior, keyboard flow, visible state, and operator ergonomics | Scripted path or screenshot plus observed result |
| `coven runtime` | Coven CLI/runtime, daemon, socket, TUI, harness launch, and local machine capability work | Command bundle, logs, and exact runtime state |
| `cast-codes app` | CastCodes desktop/app behavior, settings, LSP, indexing, browser panels, and UI flows | App/test command, focused screenshot or log, issue/PR link |
| `repo tests` | Narrow implementation or regression coverage | Exact test command and pass/fail result |
| `maintainer review` | PR review, conflict repair, release follow-through, and issue triage | Live GitHub state, review-thread state, and final blocker |

Assignment rules:

- Prefer `coven-code execute` for deterministic orchestration checks.
- Prefer `coven-code panel` when operator experience is the thing being tested.
- Prefer `coven runtime` when the task touches Coven's own Rust runtime,
  daemon, socket, local machine capabilities, or harness launch behavior.
- Prefer `cast-codes app` when the proof depends on the CastCodes application
  rather than a library or CLI unit.
- Prefer `repo tests` for the smallest code-level regression proof.
- Prefer `maintainer review` when the task is primarily GitHub state, PR
  cleanup, merge readiness, or issue accuracy.

## Handoff Packet

Produce a handoff packet before requesting review, switching harnesses, pausing,
or closing the task.

```markdown
## Handoff Packet

- Outcome:
- Changed files:
- Verification:
- Product gaps found:
- Issues captured:
- Remaining risk:
- Next action:
```

Field rules:

- `Outcome`: shipped, reviewed, blocked, no actionable bug, or follow-up needed.
- `Changed files`: exact paths or `none`.
- `Verification`: exact commands and result summaries.
- `Product gaps found`: dogfood friction observed while using Coven.
- `Issues captured`: issue links, draft titles, or `none`.
- `Remaining risk`: what was not proven.
- `Next action`: the one concrete action another maintainer can take.

## Verification Gate

Every dogfood task needs proof proportional to the change.

Minimum docs-only gate:

```sh
git diff --check
```

Minimum Coven Code gate:

```sh
git diff --check
node ./bin/coven-code.mjs --help
node ./bin/coven-code.mjs -x "what is 2+2?"
npm test
```

Minimum Coven runtime gate:

```sh
cargo test
```

Add focused runtime commands that exercise the touched Coven surface, such as a
daemon launch, socket call, TUI smoke path, or harness command construction
check.

Minimum CastCodes gate:

```sh
./script/check_ai_attribution
./script/check_rebrand
git diff --check
```

Add the narrow CastCodes command that proves the touched surface, such as a
focused test target, `rustfmt --check` on changed Rust files, an app launch, or
a screenshot-backed UI check.

Run `./script/check_rebrand` when touching public docs, UI, settings,
templates, release notes, marketing, or other user-visible surfaces. This
protects the CastCodes product and Coven runtime framing.

Verification rules:

- Run the narrowest command that can fail for the changed behavior.
- Record the exact command, result, and any known baseline noise.
- If a broad suite fails from unrelated drift, keep the failure in the handoff
  and add a focused passing command for the touched behavior.
- Never mark a handoff complete when the required proof was skipped.

## Retrospective

End each day or substantial task with a short retrospective.

```markdown
## Retrospective

- What Coven made easier:
- What Coven made harder:
- Missing product affordance:
- Protocol adjustment:
- Follow-up:
```

Retrospective rules:

- Keep it concrete and tied to the day's packets.
- Record one product gap at most unless multiple gaps blocked the work.
- Use `none` when no issue is warranted.
- Do not rewrite the protocol unless repeated evidence supports the change.

## Issue Capture

Capture an issue when dogfood use exposes a reproducible product gap, missing
affordance, confusing handoff, unreliable harness path, or verification hole.

Issue packet:

```markdown
## Dogfood Issue

- Title:
- Repo:
- Surface:
- Reproduction:
- Expected:
- Actual:
- Evidence:
- Severity:
- Suggested owner:
```

Severity:

- `P0`: blocks daily Coven or CastCodes work.
- `P1`: forces a manual workaround or makes proof unreliable.
- `P2`: slows handoff, review, or issue capture.
- `P3`: polish, naming, or ergonomics with a clear fix path.

Capture rules:

- File issues from evidence, not speculation.
- Link the task packet and handoff packet when available.
- Keep implementation suggestions separate from the reproduction.
- If the gap is actually a docs or protocol mismatch, patch the protocol instead
  of opening a product issue.

## Daily Closeout

Use this checklist before ending a dogfood run:

- Task packet exists.
- Harness assignment is recorded.
- Handoff packet exists or the task is explicitly still active.
- Verification commands and results are recorded.
- Product gaps were captured or marked `none`.
- Retrospective note exists.
- Next action is one concrete maintainer step.
