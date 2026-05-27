import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  SETTINGS_PREFIX,
  readEffectiveSettings,
  readSettings,
  readSettingsFile,
  writeSettings,
  writeSettingsFile,
} from '../settings/load.mjs';
import { configDir, findProjectRoot, workspaceSettingsFile } from '../settings/paths.mjs';
import { latestActiveThread, readThread, writeThread } from '../threads/store.mjs';
import { shellQuote } from '../util/shell.mjs';

const PLUGIN_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

export function discoverPluginFiles(cwd) {
  const projectRoot = findProjectRoot(cwd);
  return [
    ...readPluginDir(path.join(projectRoot, '.coven-code', 'plugins'), 'project'),
    ...readPluginDir(path.join(configDir(), 'coven-code', 'plugins'), 'user'),
  ];
}

function readPluginDir(dir, source) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => entry.endsWith('.ts'))
    .sort((a, b) => a.localeCompare(b))
    .map((entry) => ({
      name: path.basename(entry, '.ts'),
      source,
      path: path.join(dir, entry),
    }));
}

export async function loadPlugins(cwd) {
  const runtime = {
    tools: [],
    commands: [],
    handlers: {},
    configurationSubscribers: [],
    notifications: [],
    statusItems: [],
    pluginSummaries: [],
    currentPlugin: undefined,
  };
  const seen = new Set();
  const api = createPluginApi({ cwd, runtime });
  for (const plugin of discoverPluginFiles(cwd)) {
    const module = await import(pathToFileURL(plugin.path).href);
    const summary = {
      name: plugin.name,
      source: plugin.source,
      path: plugin.path,
      tools: [],
      commands: [],
      events: [],
    };
    runtime.currentPlugin = summary;
    if (typeof module.default === 'function') await module.default(api);
    runtime.pluginSummaries.push(summary);
    runtime.currentPlugin = undefined;
  }
  runtime.tools = runtime.tools.filter((tool) => {
    if (!tool?.name || seen.has(tool.name)) return false;
    seen.add(tool.name);
    return true;
  });
  runtime.commands = runtime.commands.filter((command) => command?.name);
  return runtime;
}

export async function listPluginTools(cwd) {
  return (await loadPlugins(cwd)).tools;
}

export async function runPluginEventHandlers(handlers = [], event = {}, validateResult = () => {}) {
  let decision;
  for (const handler of handlers) {
    const result = await handler(event, createPluginContext(event));
    if (result) validateResult(result);
    if (!result || result.action === 'allow') continue;
    decision ??= result;
  }
  return decision ?? { action: 'allow' };
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

function createPluginApi({ cwd, runtime }) {
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

function createSubscription(dispose) {
  return {
    unsubscribe: dispose,
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

function createPluginConfigurationApi(cwd, runtime) {
  const observableSymbol = Symbol.observable ?? Symbol.for('observable');
  const api = {
    async get() {
      return pluginConfiguration(readEffectiveSettings());
    },
    async update(patch = {}, scope = 'workspace') {
      const normalizedPatch = normalizePluginConfigurationPatch(patch);
      const target = normalizePluginConfigurationTarget(scope);
      if (target === 'workspace') {
        const filePath = workspaceSettingsFile(findProjectRoot(cwd));
        await writeSettingsFile(filePath, { ...readSettingsFile(filePath), ...normalizedPatch });
      } else {
        await writeSettings({ ...readSettings(), ...normalizedPatch });
      }
      await notifyConfigurationSubscribers(runtime);
    },
    async delete(key, scope = 'workspace') {
      const normalizedKey = normalizePluginConfigurationKey(key);
      const target = normalizePluginConfigurationTarget(scope);
      if (target === 'workspace') {
        const filePath = workspaceSettingsFile(findProjectRoot(cwd));
        const settings = readSettingsFile(filePath);
        delete settings[normalizedKey];
        await writeSettingsFile(filePath, settings);
      } else {
        const settings = readSettings();
        delete settings[normalizedKey];
        await writeSettings(settings);
      }
      await notifyConfigurationSubscribers(runtime);
    },
    subscribe(handler) {
      validateObservableSubscriber(handler);
      runtime.configurationSubscribers.push(handler);
      return createSubscription(() => {
        runtime.configurationSubscribers = runtime.configurationSubscribers.filter((entry) => entry !== handler);
      });
    },
    pipe(op) {
      return op(api);
    },
    [observableSymbol]() {
      return api;
    },
  };
  return api;
}

function pluginConfiguration(settings = {}) {
  const config = { ...settings };
  for (const [key, value] of Object.entries(settings)) {
    if (key.startsWith(SETTINGS_PREFIX) && !Object.hasOwn(config, key.slice(SETTINGS_PREFIX.length))) {
      config[key.slice(SETTINGS_PREFIX.length)] = value;
    }
  }
  return config;
}

function normalizePluginConfigurationPatch(patch = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('plugin configuration update patch must be an object');
  }
  return Object.fromEntries(Object.entries(patch).map(([key, value]) => [
    normalizePluginConfigurationKey(key),
    value,
  ]));
}

function normalizePluginConfigurationKey(key) {
  if (typeof key !== 'string') {
    throw new Error('plugin configuration key must be a string');
  }
  const text = String(key);
  if (text.startsWith(SETTINGS_PREFIX)) return text;
  return `${SETTINGS_PREFIX}${text}`;
}

function normalizePluginConfigurationTarget(target = 'workspace') {
  if (target !== 'workspace' && target !== 'global') {
    throw new Error(`plugin configuration target must be workspace or global: ${String(target)}`);
  }
  return target;
}

async function notifyConfigurationSubscribers(runtime) {
  if (runtime.configurationSubscribers.length === 0) return;
  const config = pluginConfiguration(readEffectiveSettings());
  for (const subscriber of runtime.configurationSubscribers) {
    await notifyObservableSubscriber(subscriber, config);
  }
}

async function notifyObservableSubscriber(subscriber, value) {
  if (typeof subscriber === 'function') {
    await subscriber(value);
    return;
  }
  if (typeof subscriber?.next === 'function') {
    await subscriber.next(value);
  }
}

function validateObservableSubscriber(subscriber) {
  if (typeof subscriber === 'function') return;
  if (subscriber && typeof subscriber === 'object' && !Array.isArray(subscriber)) return;
  throw new Error('plugin observable subscriber must be a function or observer object');
}

function createPluginContext(event = {}) {
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

function filesModifiedByToolCall(event = {}) {
  const input = event.input ?? {};
  if ((event.tool === 'edit_file' || event.tool === 'create_file' || event.tool === 'undo_edit') && input.path) {
    return [path.resolve(process.cwd(), String(input.path))];
  }
  if (event.tool === 'apply_patch' && typeof input.patch === 'string') {
    return applyPatchModifiedFiles(input.patch);
  }
  const shellCommand = event.tool === 'Bash' || event.tool === 'shell_command'
    ? input.command ?? input.cmd
    : undefined;
  if (typeof shellCommand === 'string') {
    const files = sedInPlaceModifiedFiles(shellCommand);
    return files.length > 0 ? files : null;
  }
  return null;
}

function applyPatchModifiedFiles(patch) {
  return [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)]
    .map((match) => path.resolve(process.cwd(), match[1].trim()))
    .filter(Boolean);
}

function sedInPlaceModifiedFiles(command) {
  const tokens = shellWords(command);
  if (tokens[0] !== 'sed') return [];
  const files = [];
  let sawInPlace = false;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '-i') {
      sawInPlace = true;
      if (tokens[index + 1] === '' || (tokens[index + 1] && !tokens[index + 1].startsWith('-') && !looksLikeSedScript(tokens[index + 1]))) {
        index += 1;
      }
      continue;
    }
    if (token.startsWith('-i')) {
      sawInPlace = true;
      continue;
    }
    if (!sawInPlace || token.startsWith('-') || looksLikeSedScript(token)) continue;
    files.push(path.resolve(process.cwd(), token));
  }
  return files;
}

function looksLikeSedScript(token = '') {
  return /^[a-zA-Z][^/|,;]*[\/|,;]/.test(token);
}

function shellWords(command) {
  const words = [];
  let current = '';
  let quote = '';
  let escaping = false;
  let tokenStarted = false;
  for (const char of command) {
    if (escaping) {
      current += char;
      escaping = false;
      tokenStarted = true;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaping = true;
      tokenStarted = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = '';
      else {
        current += char;
        tokenStarted = true;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (tokenStarted) {
        words.push(current);
        current = '';
        tokenStarted = false;
      }
      continue;
    }
    current += char;
    tokenStarted = true;
  }
  if (tokenStarted) words.push(current);
  return words;
}

function toolCallsInMessages(messages = []) {
  const calls = [];
  const resultsById = new Map();
  for (const message of messages) {
    const blocks = Array.isArray(message.content) ? message.content : [];
    for (const block of blocks) {
      if (block?.type === 'tool_use') {
        calls.push({
          toolUseID: block.id,
          tool: block.name,
          input: block.input ?? {},
        });
        continue;
      }
      if (block?.type !== 'tool_result') continue;
      const toolUseID = block.toolUseID ?? block.tool_use_id;
      if (typeof toolUseID !== 'string' || !toolUseID) continue;
      const status = normalizeToolResultStatus(block);
      if (!status) continue;
      resultsById.set(toolUseID, {
        toolUseID,
        status,
        output: normalizeToolResultOutput(block),
        ...(status === 'error' && typeof block.content === 'string' ? { error: block.content } : {}),
      });
    }
  }

  return calls.flatMap((call) => {
    const result = resultsById.get(call.toolUseID);
    if (!result) return [];
    return [{
      call,
      result: {
        ...result,
        tool: call.tool,
        input: call.input,
      },
    }];
  });
}

function normalizeToolResultStatus(block = {}) {
  if (block.status === 'done' || block.status === 'error' || block.status === 'cancelled') return block.status;
  if (typeof block.is_error === 'boolean') return block.is_error ? 'error' : 'done';
  if (typeof block.isError === 'boolean') return block.isError ? 'error' : 'done';
  return undefined;
}

function normalizeToolResultOutput(block = {}) {
  if (Object.hasOwn(block, 'output')) return block.output;
  if (Object.hasOwn(block, 'content')) return block.content;
  return undefined;
}

function filePathFromURI(uri) {
  if (!uri) return undefined;
  try {
    return fileURLToPath(String(uri));
  } catch {
    return undefined;
  }
}

function isPluginUINotAvailableError(error) {
  if (!error || typeof error !== 'object') return false;
  if (error.name === 'PluginUINotAvailableError') return true;
  if (error.code === 'PLUGIN_UI_NOT_AVAILABLE') return true;
  return /\b(?:no|plugin)\s+plugin\s+ui\s+(?:is\s+)?available\b/i.test(String(error.message ?? ''))
    || /\bplugin\s+ui\s+(?:is\s+)?not\s+available\b/i.test(String(error.message ?? ''));
}

function runPluginShell(cwd, strings, values) {
  const command = strings.reduce((text, part, index) => {
    return `${text}${part}${index < values.length ? shellQuote(values[index]) : ''}`;
  }, '');
  const result = spawnSync(command, { cwd, shell: true, encoding: 'utf8' });
  return {
    exitCode: result.status ?? 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? 0,
  };
}
