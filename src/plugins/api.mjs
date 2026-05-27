import { pathToFileURL } from 'node:url';
import { latestActiveThread, readThread, writeThread } from '../threads/store.mjs';
import {
  createPluginConfigurationApi,
  createSubscription,
  validateObservableSubscriber,
} from './configuration.mjs';
import {
  filePathFromURI,
  filesModifiedByToolCall,
  isPluginUINotAvailableError,
  runPluginShell,
  toolCallsInMessages,
} from './helpers.mjs';

const PLUGIN_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

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

function createPluginLogger() {
  return {
    log() {},
  };
}

function removeFirst(entries, value) {
  const index = entries.indexOf(value);
  if (index >= 0) entries.splice(index, 1);
}

function validatePluginToolName(name) {
  if (typeof name !== 'string' || !PLUGIN_TOOL_NAME_PATTERN.test(name)) {
    throw new Error(`plugin tool name must match ^[a-zA-Z0-9_-]+$: ${String(name ?? '')}`);
  }
}

function validatePluginToolDefinition(tool) {
  const name = String(tool?.name ?? '');
  if (typeof tool?.description !== 'string' || tool.description.trim() === '') {
    throw new Error(`plugin tool description is required: ${name}`);
  }
  if (tool?.inputSchema?.type !== 'object') {
    throw new Error(`plugin tool inputSchema.type must be object: ${name}`);
  }
  if (
    tool.inputSchema.properties !== undefined &&
    (!isPlainObject(tool.inputSchema.properties) ||
      Object.values(tool.inputSchema.properties).some((property) => !isPlainObject(property)))
  ) {
    throw new Error(`plugin tool inputSchema.properties values must be objects: ${name}`);
  }
  if (
    tool.inputSchema.required !== undefined &&
    (!Array.isArray(tool.inputSchema.required) ||
      tool.inputSchema.required.some((propertyName) => typeof propertyName !== 'string'))
  ) {
    throw new Error(`plugin tool inputSchema.required must be strings: ${name}`);
  }
  if (typeof tool?.execute !== 'function') {
    throw new Error(`plugin tool execute handler is required: ${name}`);
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validatePluginCommand(name, metadata) {
  if (typeof metadata?.title !== 'string' || metadata.title.trim() === '') {
    throw new Error(`plugin command title is required: ${String(name ?? '')}`);
  }
  if (metadata.category !== undefined && typeof metadata.category !== 'string') {
    throw new Error(`plugin command category must be a string: ${String(name ?? '')}`);
  }
  if (metadata.description !== undefined && typeof metadata.description !== 'string') {
    throw new Error(`plugin command description must be a string: ${String(name ?? '')}`);
  }
}

function validateCommandAvailability(commandName, availability) {
  const type = availability?.type;
  if (type !== 'enabled' && type !== 'disabled' && type !== 'hidden') {
    throw new Error(`plugin command availability must be enabled, disabled, or hidden: ${String(commandName ?? '')}`);
  }
  if (type === 'disabled' && typeof availability.reason !== 'string') {
    throw new Error(`plugin command disabled availability reason is required: ${String(commandName ?? '')}`);
  }
  const keys = Object.keys(availability);
  const allowedKeys = type === 'disabled' ? ['reason', 'type'] : ['type'];
  if (keys.some((key) => !allowedKeys.includes(key))) {
    throw new Error(`plugin command availability fields must match the documented union: ${String(commandName ?? '')}`);
  }
  return availability;
}

function createPluginSystem(recordOpen = () => {}) {
  const covenCodeURL = pluginCovenCodeURL();
  return {
    open: async (target) => {
      validatePluginSystemOpenTarget(target);
      recordOpen(target);
    },
    covenCodeURL,
    executor: { kind: 'local' },
  };
}

function validatePluginSystemOpenTarget(target) {
  if (typeof target !== 'string' && !(target instanceof URL)) {
    throw new Error('plugin system open target must be a string or URL');
  }
}

function pluginCovenCodeURL() {
  try {
    return new URL(process.env.COVEN_CODE_URL || 'https://coven-code.local');
  } catch {
    return new URL('https://coven-code.local');
  }
}

function createPluginExperimentalApi(runtime) {
  return {
    createStatusItem(initial) {
      const item = { value: validatePluginStatusItemValue(initial) };
      runtime.statusItems.push(item);
      return {
        update(value) {
          item.value = validatePluginStatusItemValue(value);
        },
        ...createSubscription(() => {
          runtime.statusItems = runtime.statusItems.filter((entry) => entry !== item);
        }),
      };
    },
    activeThread: createActiveThreadObservable(),
  };
}

function validatePluginStatusItemValue(value) {
  if (value === undefined) return undefined;
  for (const key of Object.keys(value ?? {})) {
    if (key !== 'text' && key !== 'url') {
      throw new Error('plugin status item fields must be text or url');
    }
  }
  if (typeof value?.text !== 'string' || value.text.trim() === '') {
    throw new Error('plugin status item text is required');
  }
  if (value.url !== undefined && typeof value.url !== 'string') {
    throw new Error('plugin status item url must be a string');
  }
  return value;
}

function createActiveThreadObservable() {
  const subscribers = [];
  const observableSymbol = Symbol.observable ?? Symbol.for('observable');
  const observable = {
    get current() {
      const thread = latestActiveThread();
      return thread ? { id: thread.id } : null;
    },
    subscribe(observer) {
      validateObservableSubscriber(observer);
      subscribers.push(observer);
      return createSubscription(() => {
        const index = subscribers.indexOf(observer);
        if (index >= 0) subscribers.splice(index, 1);
      });
    },
    pipe(op) {
      return op(observable);
    },
    [observableSymbol]() {
      return observable;
    },
  };
  return observable;
}

function createPluginAI() {
  return {
    ask: async (question) => {
      if (typeof question !== 'string') {
        throw new Error('plugin ai.ask question must be a string');
      }
      return classifyPluginQuestion(question);
    },
  };
}

function classifyPluginQuestion(question = '') {
  const text = String(question).toLowerCase();
  const matches = [
    ['deploy', /\bdeploy(?:ment)?\b/],
    ['production', /\b(?:prod|production)\b/],
    ['destructive', /\b(?:destroy|delete|remove|reset|force push|drop)\b/],
    ['risky', /\b(?:risky|danger|unsafe|secret|password|token)\b/],
  ].filter(([, pattern]) => pattern.test(text)).map(([label]) => label);

  if (matches.length > 0) {
    return {
      result: 'yes',
      probability: 0.9,
      reason: `local keyword classifier matched: ${matches.join(', ')}`,
    };
  }

  if (/\b(?:maybe|unclear|uncertain|unknown|not sure)\b/.test(text)) {
    return {
      result: 'uncertain',
      probability: 0.5,
      reason: 'local keyword classifier found ambiguity markers',
    };
  }

  return {
    result: 'no',
    probability: 0.1,
    reason: 'local keyword classifier found no risky keywords',
  };
}

function createPluginThreadContext(threadId) {
  const thread = threadId ? readThread(threadId) ?? createPendingThread(threadId) : latestActiveThread();
  if (!thread) return undefined;
  return {
    id: thread.id,
    append: async (entries = []) => {
      const messages = pluginThreadEntriesToMessages(entries);
      if (messages.length === 0) return;
      thread.messages.push(...messages);
      thread.updatedAt = new Date().toISOString();
      await writeThread(thread);
    },
  };
}

function createPendingThread(threadId) {
  const now = new Date().toISOString();
  return {
    id: threadId,
    title: '(pending thread)',
    cwd: process.cwd(),
    mode: 'smart',
    visibility: 'private',
    labels: [],
    archived: false,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
}

function pluginThreadEntriesToMessages(entries) {
  if (!Array.isArray(entries)) {
    throw new Error('plugin thread append expects an array of user-message entries');
  }
  return entries.map((entry = {}) => {
    if (entry.type !== 'user-message') {
      throw new Error('plugin thread append only supports user-message entries');
    }
    if (typeof entry.content !== 'string') {
      throw new Error('plugin thread append content must be a string');
    }
    return { role: 'user', content: entry.content };
  });
}

function pluginEnvBoolean(name) {
  const value = process.env[name];
  if (!value) return false;
  return ['1', 'true', 'yes', 'y', 'allow', 'confirm', 'ok'].includes(value.toLowerCase());
}

function pluginEnvConfirm(options) {
  validatePluginConfirmOptions(options);
  return pluginEnvBoolean('COVEN_CODE_PLUGIN_CONFIRM');
}

function pluginEnvInput(inputOptions) {
  validatePluginInputOptions(inputOptions);
  const value = process.env.COVEN_CODE_PLUGIN_INPUT;
  if (value !== undefined && value !== '') return value;
  if (inputOptions.initialValue !== undefined) return inputOptions.initialValue;
  return value;
}

function pluginEnvSelection(selectOptions) {
  validatePluginSelectOptions(selectOptions);
  const requested = process.env.COVEN_CODE_PLUGIN_SELECT;
  if (!requested) return undefined;
  const options = selectOptions.options;
  for (const option of options) {
    if (typeof option === 'string' && option === requested) return option;
  }
  return requested;
}

function validatePluginConfirmOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('plugin confirm options must be an object');
  }
  if (typeof options?.title !== 'string' || options.title.trim() === '') {
    throw new Error('plugin confirm title is required');
  }
  for (const key of ['message', 'confirmButtonText']) {
    if (options[key] !== undefined && typeof options[key] !== 'string') {
      throw new Error(`plugin confirm ${key} must be a string`);
    }
  }
}

function validatePluginNotifyMessage(message) {
  if (typeof message !== 'string') {
    throw new Error('plugin notify message must be a string');
  }
  return message;
}

function validatePluginInputOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('plugin input options must be an object');
  }
  for (const key of ['title', 'helpText', 'initialValue', 'submitButtonText']) {
    if (options[key] !== undefined && typeof options[key] !== 'string') {
      throw new Error(`plugin input ${key} must be a string`);
    }
  }
}

function validatePluginSelectOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('plugin select options must be an object');
  }
  if (typeof options?.title !== 'string' || options.title.trim() === '') {
    throw new Error('plugin select title is required');
  }
  for (const key of ['message', 'initialValue']) {
    if (options[key] !== undefined && typeof options[key] !== 'string') {
      throw new Error(`plugin select ${key} must be a string`);
    }
  }
  if (!Array.isArray(options.options) || options.options.some((option) => typeof option !== 'string')) {
    throw new Error('plugin select options must be strings');
  }
}
