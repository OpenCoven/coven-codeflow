import {
  SETTINGS_PREFIX,
  readEffectiveSettings,
  readSettings,
  readSettingsFile,
  writeSettings,
  writeSettingsFile,
} from '../settings/load.mjs';
import { findProjectRoot, workspaceSettingsFile } from '../settings/paths.mjs';

export function createSubscription(dispose) {
  return {
    unsubscribe: dispose,
  };
}

export function createPluginConfigurationApi(cwd, runtime) {
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

export async function notifyObservableSubscriber(subscriber, value) {
  if (typeof subscriber === 'function') {
    await subscriber(value);
    return;
  }
  if (typeof subscriber?.next === 'function') {
    await subscriber.next(value);
  }
}

export function validateObservableSubscriber(subscriber) {
  if (typeof subscriber === 'function') return;
  if (subscriber && typeof subscriber === 'object' && !Array.isArray(subscriber)) return;
  throw new Error('plugin observable subscriber must be a function or observer object');
}
