# SDK

The package root exports local SDK helpers:

```js
import {
  execute,
  createUserMessage,
  createPermission,
  threads,
} from "@opencoven/coven-code";
```

## CLI Install Helper

The `coven-code-sdk` binary installs or resolves a CLI for SDK-managed runs:

```sh
coven-code-sdk install
coven-code-sdk install --force
```

Resolution order includes:

- `COVEN_CODE_CLI_PATH`
- local npm package bins
- `COVEN_CODE_HOME` managed bin
- `coven-code` on `PATH`

## Execute

```js
for await (const message of execute({
  prompt: "what is 2+2?",
  options: {
    cwd: process.cwd(),
    visibility: "workspace",
  },
})) {
  console.log(message);
}
```

SDK execution streams the same JSONL events produced by:

```sh
coven-code --stream-json -x "prompt"
```

## Options

SDK options map to CLI arguments and environment:

- `cwd`
- `env`
- `mode`
- `reasoningEffort`
- `thinking`
- `labels`
- `visibility`
- `archive`
- `continue`
- `settingsFile`
- `toolbox`
- `skills`
- `mcpConfig`
- `permissions`
- `enabledTools`
- `systemPrompt`
- `logFile`
- `logLevel`
- permission bypass for trusted local harnesses

## User Messages

```js
const message = createUserMessage("summarize @README.md");
```

Structured image content is supported through the same stream JSON input path
that the CLI uses.

## Permissions

```js
const permission = createPermission("Bash", "delegate", {
  to: "local-policy",
  message: "This command is blocked in this workspace.",
});
```

Custom reject messages are preserved in CLI and SDK results.

## Threads

```js
const threadId = await threads.new({ visibility: "workspace" });
const markdown = await threads.markdown({ threadId });
```

Thread helpers operate on the same local persistence layer as the CLI.

## Abort Handling

SDK execution supports aborting while waiting on async input. Consumers should
wire cancellation from UI or server request lifecycles so long-running local
agent turns can be stopped promptly.
