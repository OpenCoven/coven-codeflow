import { pathToFileURL } from 'node:url';
import { createPluginConfigurationApi } from './configuration.mjs';
import {
  filePathFromURI,
  filesModifiedByToolCall,
  isPluginUINotAvailableError,
  runPluginShell,
  toolCallsInMessages,
} from './helpers.mjs';
import {
  createPluginAI,
  createPluginExperimentalApi,
  createPluginLogger,
  createPluginSystem,
  createPluginThreadContext,
  pluginEnvConfirm,
  pluginEnvInput,
  pluginEnvSelection,
} from './subsystems.mjs';
import { createSubscription } from './configuration.mjs';
import {
  removeFirst,
  validateCommandAvailability,
  validatePluginCommand,
  validatePluginConfirmOptions,
  validatePluginInputOptions,
  validatePluginNotifyMessage,
  validatePluginSelectOptions,
  validatePluginToolDefinition,
  validatePluginToolName,
} from './validators.mjs';

export function createPluginApi({ cwd, runtime }) {
  return {
    registerTool(tool) {
      const summary = runtime.currentPlugin;
      validatePluginToolName(tool?.name);
      validatePluginToolDefinition(tool);
      const registeredTool = { ...tool };
      if (tool?.name) summary?.tools.push(tool.name);
      runtime.tools.push(registeredTool);
      return createSubscription(() => {
        runtime.tools = runtime.tools.filter((entry) => entry !== registeredTool);
        if (tool?.name && summary) removeFirst(summary.tools, tool.name);
      });
    },
    registerCommand(name, metadata = {}, handler = async () => undefined) {
      const summary = runtime.currentPlugin;
      validatePluginCommand(name, metadata);
      summary?.commands.push(name);
      const commandMetadata = {
        ...metadata,
        category: metadata.category ?? summary?.name,
      };
      const command = {
        name,
        metadata: commandMetadata,
        handler,
        availability: validateCommandAvailability(name, commandMetadata.availability ?? { type: 'enabled' }),
      };
      runtime.commands.push(command);
      return {
        setAvailability(availability) {
          command.availability = validateCommandAvailability(name, availability);
        },
        ...createSubscription(() => {
          runtime.commands = runtime.commands.filter((entry) => entry !== command);
          if (summary) removeFirst(summary.commands, name);
        }),
      };
    },
    on(eventName, handler) {
      const summary = runtime.currentPlugin;
      summary?.events.push(eventName);
      if (!runtime.handlers[eventName]) runtime.handlers[eventName] = [];
      runtime.handlers[eventName].push(handler);
      return createSubscription(() => {
        runtime.handlers[eventName] = (runtime.handlers[eventName] ?? []).filter((entry) => entry !== handler);
        if (summary) removeFirst(summary.events, eventName);
      });
    },
    configuration: createPluginConfigurationApi(cwd, runtime),
    ai: createPluginAI(),
    helpers: {
      shellCommandFromToolCall(event = {}) {
        if (event.tool !== 'Bash' && event.tool !== 'shell_command') return null;
        const command = event.input?.command ?? event.input?.cmd;
        if (typeof command !== 'string' || !command) return null;
        const dir = typeof event.input?.dir === 'string' && event.input.dir ? event.input.dir : undefined;
        return dir ? { command, dir } : { command };
      },
      toolCallsInMessages(messages = []) {
        return toolCallsInMessages(messages);
      },
      filesModifiedByToolCall(event = {}) {
        const files = filesModifiedByToolCall(event);
        return files ? files.map((filePath) => pathToFileURL(filePath)) : null;
      },
      filePathFromURI(uri) {
        return filePathFromURI(uri);
      },
      isPluginUINotAvailableError(error) {
        return isPluginUINotAvailableError(error);
      },
    },
    logger: createPluginLogger(),
    system: createPluginSystem((target) => {
      runtime.notifications.push(String(target));
    }),
    ui: {
      async notify(message) {
        runtime.notifications.push(validatePluginNotifyMessage(message));
      },
      confirm: async (options) => pluginEnvConfirm(options),
      input: async (options) => pluginEnvInput(options),
      select: async (options) => pluginEnvSelection(options),
    },
    $: (strings, ...values) => runPluginShell(cwd, strings, values),
    experimental: createPluginExperimentalApi(runtime),
  };
}

export function createPluginContext(event = {}) {
  return {
    logger: createPluginLogger(),
    $: (strings, ...values) => runPluginShell(process.cwd(), strings, values),
    ui: {
      async notify(message) {
        validatePluginNotifyMessage(message);
      },
      confirm: async (options) => {
        validatePluginConfirmOptions(options);
        return false;
      },
      input: async (options) => {
        validatePluginInputOptions(options);
        return undefined;
      },
      select: async (options) => {
        validatePluginSelectOptions(options);
        return undefined;
      },
    },
    ai: createPluginAI(),
    system: createPluginSystem(),
    thread: createPluginThreadContext(event.thread?.id),
  };
}

export function createPluginCommandContext(cwd = process.cwd()) {
  const notifications = [];
  const context = {
    ui: {
      async notify(message) {
        notifications.push(validatePluginNotifyMessage(message));
      },
      confirm: async (options) => pluginEnvConfirm(options),
      input: async (options) => pluginEnvInput(options),
      select: async (options) => pluginEnvSelection(options),
    },
    system: createPluginSystem((target) => {
      notifications.push(String(target));
    }),
    ai: createPluginAI(),
    $: (strings, ...values) => runPluginShell(cwd, strings, values),
    thread: createPluginThreadContext(),
  };
  Object.defineProperty(context, 'notifications', {
    value: notifications,
    enumerable: false,
  });
  return context;
}

export function createPluginToolContext() {
  return {
    ui: {
      notify: async (message) => {
        validatePluginNotifyMessage(message);
      },
      confirm: async (options) => pluginEnvConfirm(options),
      input: async (options) => pluginEnvInput(options),
      select: async (options) => pluginEnvSelection(options),
    },
    logger: createPluginLogger(),
  };
}
