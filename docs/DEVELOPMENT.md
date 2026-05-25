# Development

## Requirements

- Node.js 20 or newer
- npm for this package's current lockfile and scripts

The runtime is dependency-free beyond Node built-ins. Keep it that way unless
a dependency removes meaningful complexity and is worth the supply-chain cost.

## Repository Layout

```text
bin/                    CLI entrypoints
docs/                   User-facing documentation
src/agent/              Local deterministic agent behavior
src/cli/                Argument parsing, REPL, references, stream helpers
src/commands/           Top-level command implementations
src/mcp/                MCP discovery, permissions, probing, registry checks
src/plugins/            Project/user plugin discovery and lifecycle
src/settings/           Settings paths and merge logic
src/skills/             Skill discovery and built-in skills
src/threads/            Local thread persistence
src/tools/              Built-in and toolbox tool surfaces
test/                   Node test suite
```

## Local Verification

Run this before every commit:

```sh
git diff --check
node ./bin/coven-code.mjs --help
node ./bin/coven-code.mjs -x "what is 2+2?"
npm test
```

Expected result:

- no whitespace errors
- help renders
- execute mode prints `4`
- test suite exits with zero failures

## Isolated Demo State

Use temporary state when demonstrating the CLI so the run does not write to the
operator's normal config or REPL history:

```sh
COVEN_CODE_HOME="$(mktemp -d)" \
XDG_CONFIG_HOME="$(mktemp -d)" \
COVEN_CODE_REPL_HISTORY=0 \
COVEN_CODE_SKIP_UPDATE_CHECK=1 \
npm run coven-code -- -x "what is 2+2?"
```

## Testing Expectations

Add or update tests in `test/cli.test.mjs` for any CLI behavior change.
Prefer deterministic local tests over network calls. When a feature integrates
with MCP, plugins, skills, or toolbox tools, test both discovery and execution
paths.

## Safety

- Do not commit secrets, tokens, generated credentials, or local config state.
- Keep examples deterministic and local.
- Keep docs and command help aligned.
- Do not rely on hosted services for default behavior.
- Keep private workspace paths and machine-specific URLs out of docs.

## Release Notes

The package currently uses version `0.0.0` while the CLI surface is rebuilt.
Before publishing, update versioning deliberately and verify:

```sh
npm test
npm pack --dry-run
```

The `.npmignore` file excludes internal superpowers planning notes while
including the user-facing docs in this directory.
