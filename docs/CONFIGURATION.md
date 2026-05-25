# Configuration

## Settings Files

Coven Code reads settings from these places:

- user settings: `${XDG_CONFIG_HOME:-~/.config}/coven-code/settings.json`
- workspace settings: `.coven-code/settings.json`
- explicit settings file: `--settings-file <path>`
- managed settings used by tests and embedding environments

Settings use the `covenCode.*` namespace.

Workspace settings override user settings where both define the same key.
Managed settings override both. Explicit command-line flags override settings
for the current run.

## Editing Settings

```sh
coven-code config edit
coven-code config edit --workspace
```

Settings files may use JSONC syntax, including comments and trailing commas.

## Common Settings

```jsonc
{
  "covenCode.tools.disable": ["web_search"],
  "covenCode.tools.enable": ["Bash", "Read", "Grep"],
  "covenCode.commands.allowlist": ["git", "npm", "node"],
  "covenCode.permissions": [
    {
      "effect": "allow",
      "tool": "Bash",
      "match": {
        "command.name": "git"
      }
    }
  ],
  "covenCode.mcpServers": {
    "local-tools": {
      "command": "node",
      "args": ["./tools/server.mjs"]
    }
  },
  "covenCode.mcpPermissions": [],
  "covenCode.mcpRegistry.url": "https://example.invalid/registry.json",
  "covenCode.notifications.enabled": true,
  "covenCode.updates.mode": "skip",
  "covenCode.defaultVisibility": "workspace",
  "covenCode.showCosts": true
}
```

## Environment Variables

```sh
COVEN_CODE_API_KEY
COVEN_CODE_HOME
COVEN_CODE_CLI_PATH
COVEN_CODE_TOOLBOX
COVEN_CODE_REPL_HISTORY
COVEN_CODE_REPL_HISTORY_FILE
COVEN_CODE_SKIP_UPDATE_CHECK
COVEN_CODE_FORCE_BEL
COVEN_CODE_URL
```

`COVEN_CODE_HOME` controls the local state root used by SDK-managed installs
and tests. `COVEN_CODE_CLI_PATH` points SDK execution at a specific CLI binary.

Use isolated state for demos and tests:

```sh
COVEN_CODE_HOME="$(mktemp -d)" \
XDG_CONFIG_HOME="$(mktemp -d)" \
COVEN_CODE_REPL_HISTORY=0 \
COVEN_CODE_SKIP_UPDATE_CHECK=1 \
npm run coven-code -- -x "what is 2+2?"
```

## Visibility

Thread visibility accepts:

- `private`
- `public`
- `workspace`
- `group`
- `unlisted`

SDK compatibility maps documented team visibility to workspace visibility.

## Permissions Model

Permission rules are evaluated before tool execution. Built-in defaults can be
listed with:

```sh
coven-code permissions list --builtin
```

Workspace permission settings override user settings. This keeps repository
policy close to the project under test.
