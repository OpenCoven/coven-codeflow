const PLUGIN_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

export function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function removeFirst(entries, value) {
  const index = entries.indexOf(value);
  if (index >= 0) entries.splice(index, 1);
}

export function validatePluginToolName(name) {
  if (typeof name !== 'string' || !PLUGIN_TOOL_NAME_PATTERN.test(name)) {
    throw new Error(`plugin tool name must match ^[a-zA-Z0-9_-]+$: ${String(name ?? '')}`);
  }
}

export function validatePluginToolDefinition(tool) {
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

export function validatePluginCommand(name, metadata) {
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

export function validateCommandAvailability(commandName, availability) {
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

export function validatePluginSystemOpenTarget(target) {
  if (typeof target !== 'string' && !(target instanceof URL)) {
    throw new Error('plugin system open target must be a string or URL');
  }
}

export function validatePluginStatusItemValue(value) {
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

export function validatePluginConfirmOptions(options) {
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

export function validatePluginNotifyMessage(message) {
  if (typeof message !== 'string') {
    throw new Error('plugin notify message must be a string');
  }
  return message;
}

export function validatePluginInputOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('plugin input options must be an object');
  }
  for (const key of ['title', 'helpText', 'initialValue', 'submitButtonText']) {
    if (options[key] !== undefined && typeof options[key] !== 'string') {
      throw new Error(`plugin input ${key} must be a string`);
    }
  }
}

export function validatePluginSelectOptions(options) {
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
