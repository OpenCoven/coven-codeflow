import { latestActiveThread, readThread, writeThread } from '../threads/store.mjs';
import { createSubscription, validateObservableSubscriber } from './configuration.mjs';
import {
  validatePluginConfirmOptions,
  validatePluginInputOptions,
  validatePluginSelectOptions,
  validatePluginStatusItemValue,
  validatePluginSystemOpenTarget,
} from './validators.mjs';

export function createPluginLogger() {
  return {
    log() {},
  };
}

export function createPluginSystem(recordOpen = () => {}) {
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

function pluginCovenCodeURL() {
  try {
    return new URL(process.env.COVEN_CODE_URL || 'https://coven-code.local');
  } catch {
    return new URL('https://coven-code.local');
  }
}

export function createPluginAI() {
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

export function createPluginExperimentalApi(runtime) {
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

export function createPluginThreadContext(threadId) {
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

export function pluginEnvConfirm(options) {
  validatePluginConfirmOptions(options);
  return pluginEnvBoolean('COVEN_CODE_PLUGIN_CONFIRM');
}

export function pluginEnvInput(inputOptions) {
  validatePluginInputOptions(inputOptions);
  const value = process.env.COVEN_CODE_PLUGIN_INPUT;
  if (value !== undefined && value !== '') return value;
  if (inputOptions.initialValue !== undefined) return inputOptions.initialValue;
  return value;
}

export function pluginEnvSelection(selectOptions) {
  validatePluginSelectOptions(selectOptions);
  const requested = process.env.COVEN_CODE_PLUGIN_SELECT;
  if (!requested) return undefined;
  const options = selectOptions.options;
  for (const option of options) {
    if (typeof option === 'string' && option === requested) return option;
  }
  return requested;
}
