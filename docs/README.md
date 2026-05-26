# Coven Code Documentation

Coven Code is a local-first Node CLI for exercising agentic command, thread,
tool, MCP, skill, plugin, and SDK workflows without depending on a hosted
service. The package is intentionally small and deterministic so it can be used
as a harness for OpenCoven integration work, local demos, and regression tests.

## Contents

- [CLI reference](CLI.md)
- [Configuration](CONFIGURATION.md)
- [MCP, skills, and plugins](MCP-SKILLS-PLUGINS.md)
- [SDK](SDK.md)
- [Development](DEVELOPMENT.md)
- [Coven dogfood protocol](DOGFOOD-PROTOCOL.md)

## Core Ideas

- `coven-code` is the user-facing CLI.
- `coven-code-sdk` installs or resolves a CLI binary for SDK-driven workflows.
- Threads are persisted locally under Coven Code config/state paths.
- Execute mode is deterministic and suitable for tests and automation.
- Stream JSON mode mirrors the event-oriented shape expected by agent
  frontends and SDK integrations.
- Tools, MCP servers, skills, and plugins are local extension points.

## Local Smoke Test

From the repository root:

```sh
npm run coven-code -- --help
npm run coven-code -- -x "what is 2+2?"
npm test
```

Expected result: help prints, execute mode prints `4`, and the test suite exits
with no failures.
