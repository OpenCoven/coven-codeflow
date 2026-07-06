# AGENTS.md — coven-codeflow

Guidance for **AI agents** (Codex, Claude Code, and any Coven familiar) opening
pull requests against this repo. Humans: your canonical guide is
[`CONTRIBUTING.md`](CONTRIBUTING.md) — this is the agent-specific layer on top.

> **Read first:** [`README.md`](README.md) for what this repo is, and
> [`CONTRIBUTING.md`](CONTRIBUTING.md) for the full contribution bar — including
> the **DCO sign-off requirement**, which is mandatory here.

---

## What this repo is (one line)

A small **Node CLI/TUI** for local Coven Code workflows — it runs deterministic
local agent workflows. Keep it dependency-light and deterministic.

## DCO — every commit must be signed off (mandatory)

This repo uses the **Developer Certificate of Origin**. Every commit needs a
`Signed-off-by` trailer or merge will block it:

```sh
git commit -s -m "type: summary"
```

Use a real GitHub-linked identity. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for
the full DCO text.

## Branch & PR workflow (all agents)

- **The default branch is `master`.** Never push to it directly — every change
  lands via a PR with green CI. Branch from current `origin/master`.
- **Fresh branch per task**; use a worktree if multiple sessions may touch this
  repo:
  ```sh
  git fetch origin master
  git worktree add -b <branch> /tmp/codeflow-<branch> origin/master
  ```
- Keep the diff scoped to one concern; conventional-commit subjects (`feat:`,
  `fix:`, `docs:`, `chore:`, `refactor:`).
- After merge: delete the remote branch, remove your local worktree/branch.

## Checks — run locally before opening the PR

CI (`.github/workflows/test.yml`) runs the Node test suite. Run it first:

```sh
npm test        # node --test across the test/ suite
```

Add or update tests alongside behavior changes. Fix failures rather than
skipping them.

## Repo-specific invariants (don't break these)

- Keep the CLI **deterministic and local-first** — no surprise network calls in
  the core workflow paths.
- Keep it dependency-light; prefer the Node standard library and the existing
  patterns over adding new dependencies.

## Attribution — credit contributors correctly

When you re-land or build on someone else's work (a fork PR, an issue author's
proposal, a co-author), **credit the human contributor with a working
GitHub-linked trailer** so they appear in the contributors graph:

```
Co-authored-by: Full Name <ID+username@users.noreply.github.com>
```

- Use the **numeric-id no-reply form**. Get the id with `gh api users/<login> --jq .id`.
- **Never** use a machine or `.local` email in a co-author trailer — it links to
  no account and gives **zero** credit.
- A commit can carry **both** `Signed-off-by:` (DCO, required) and
  `Co-authored-by:` (attribution) trailers — include both when re-landing a
  contributor's work.
- Credit **people**, not AI tools.

## Secrets & safety

- Never commit secrets, tokens, or private emails. Use `*.noreply.github.com`
  for attribution.
- Don't disable CI gates or branch protection to land a change; surface the
  blocker instead.

## Claude Code

`CLAUDE.md` points here — this file is the source of truth for both.
