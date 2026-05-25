# MCP, Skills, and Plugins

## MCP Servers

Add a user or workspace MCP server:

```sh
coven-code mcp add local-tools -- node ./tools/server.mjs
coven-code mcp add --workspace local-tools -- node ./tools/server.mjs
```

Inspect and approve servers:

```sh
coven-code mcp list
coven-code mcp doctor
coven-code mcp approve local-tools
```

Remote MCP servers can use headers, OAuth credentials, Streamable HTTP session
reuse, and SSE fallback. Configured servers can also filter exposed tools.

Workspace MCP servers require approval before their tools appear in stream JSON
or tool discovery.

## MCP Registry Enforcement

`covenCode.mcpRegistry.url` can point to a registry of approved remote servers.
When enabled, unlisted servers are blocked. If the registry is unreachable, MCP
activation fails closed.

This behavior is intentional: local projects should not silently connect to new
tool endpoints when a registry policy is present.

## Skills

List and inspect skills:

```sh
coven-code skill list
coven-code skill show building-skills
```

Skill discovery checks configured roots, project roots, `.agents/skills`,
legacy `.claude/skills`, and built-in skills. Project skills take precedence
over user-wide or legacy roots with the same name.

Add one-run skill roots:

```sh
coven-code --skills ./skills -x "use the data-map skill"
```

Skill-bundled MCP tools stay hidden until the skill is referenced.

## Plugins

Project plugins live under:

```text
.coven-code/plugins/*.ts
```

User plugins live under:

```text
${XDG_CONFIG_HOME:-~/.config}/coven-code/plugins/*.ts
```

Inspect plugins:

```sh
coven-code plugins list
coven-code plugins reload
```

Plugins can register:

- tools
- commands
- `session.start` handlers
- `agent.start` handlers
- `agent.end` handlers
- `tool.call` handlers
- `tool.result` handlers
- status items
- configuration subscriptions
- UI fallbacks for prompts, selects, confirms, and notifications

## Tool Lifecycle Hooks

Plugin `tool.call` handlers can:

- allow execution
- reject and continue with a message
- modify input
- synthesize a result
- stop execution with an error

Plugin `tool.result` handlers can:

- preserve results
- replace results
- mark results as errors

The helper APIs classify shell commands, modified files, unavailable UI, and
paired tool call/result messages.

## Toolbox Tools

Toolbox tools are discovered from:

- `COVEN_CODE_TOOLBOX`
- `--toolbox <path>`
- `${XDG_CONFIG_HOME:-~/.config}/coven-code/tools`

Common flow:

```sh
coven-code tools make --bash my-tool
coven-code tools list
coven-code tools show tb__my-tool
coven-code tools use tb__my-tool
```

Toolbox executions receive `AGENT=coven-code` and
`COVEN_CODE_THREAD_ID=<thread-id>` in their environment.
