/**
 * Turns EmberDebug messages into compact text for an AI agent.
 * Object ids show as `[ember123]`; `inspect_object` takes them.
 */

const MAX_VALUE_LENGTH = 120;

export function formatTabs(tabs) {
  if (tabs.length === 0) {
    return 'No tab is running an Ember app. Open the app, or reload its tab.';
  }

  return tabs
    .map((tab) =>
      [
        `- tabId ${tab.tabId}${tab.active ? ' (focused)' : ''}: ${tab.title}`,
        `  url: ${tab.url}`,
        `  libraries: ${formatLibraries(tab.libraries)}`,
        `  inspector panel open: ${tab.devtoolsOpen ? 'yes' : 'no'}`,
      ].join('\n'),
    )
    .join('\n');
}

export function formatAppInfo({ tab, libraries, currentRoute, config }) {
  let lines = [
    `App: ${libraries.applicationName ?? '(unknown)'} [${libraries.applicationId}]`,
    `Tab: ${tab.tabId} — ${tab.title}`,
    `Page URL: ${tab.url}`,
    `Current route: ${currentRoute.name} (url: ${currentRoute.url || '/'})`,
    'Libraries:',
    ...(libraries.libraries ?? []).map((lib) => `- ${lib.name} ${lib.version}`),
  ];

  if (config) {
    lines.push(
      'Config (config/environment.js):',
      JSON.stringify(config.emberCliConfig ?? null, null, 2),
    );
  }

  return lines.join('\n');
}

export function formatCurrentRoute(currentRoute) {
  return `${currentRoute.name} (url: ${currentRoute.url || '/'})`;
}

export function formatRouteTree({ tree, error }, currentRouteName) {
  if (error) return `EmberDebug could not read the routes: ${error}`;

  let lines = [];

  let walk = (node, depth) => {
    let value = node.value;

    if (value) {
      let parts = [`${'  '.repeat(depth)}${value.name}`];
      if (value.type === 'resource') parts.push('(resource)');
      if (value.url !== undefined) parts.push(`url: ${value.url || '/'}`);
      if (value.routeHandler)
        parts.push(`route: ${value.routeHandler.className}`);
      if (value.controller) {
        parts.push(
          `controller: ${value.controller.className}` +
            (value.controller.exists ? '' : ' (generated)'),
        );
      }
      if (value.template) parts.push(`template: ${value.template.name}`);
      if (value.name === currentRouteName) parts.push('← current');

      lines.push(parts.join('  '));
    }

    for (let child of node.children ?? []) {
      walk(child, value ? depth + 1 : depth);
    }
  };

  walk(tree, 0);

  return lines.join('\n');
}

/**
 * Hidden node types still show their children, one level up.
 */
const ELEMENT_TYPES = new Set(['html-element', 'modifier']);

export function formatComponentTree(
  roots,
  {
    filter,
    maxDepth = Infinity,
    includeArgs = true,
    includeElements = false,
    maxNodes = 400,
  } = {},
) {
  let lines = [];
  let omitted = 0;
  let needle = filter?.toLowerCase();

  let matches = (node) => node.name?.toLowerCase().includes(needle);

  // Whether a node or a node below it matches the filter.
  let relevant = new Map();
  let markRelevant = (node) => {
    let found = !needle || matches(node);
    for (let child of node.children ?? []) {
      if (markRelevant(child)) found = true;
    }
    relevant.set(node, found);
    return found;
  };
  roots.forEach(markRelevant);

  let walk = (node, depth, insideMatch) => {
    if (!insideMatch && !relevant.get(node)) return;

    let isMatch = needle && matches(node);
    let shown = includeElements || !ELEMENT_TYPES.has(node.type);
    let childDepth = depth;

    if (shown) {
      if (depth > maxDepth) {
        omitted += countNodes(node);
        return;
      }

      if (lines.length >= maxNodes) {
        omitted += 1;
      } else {
        lines.push(
          '  '.repeat(depth) +
            formatRenderNode(node, includeArgs) +
            (isMatch ? '  ← match' : ''),
        );
      }
      childDepth = depth + 1;
    }

    for (let child of node.children ?? []) {
      walk(child, childDepth, insideMatch || isMatch);
    }
  };

  roots.forEach((root) => walk(root, 0, false));

  if (lines.length === 0) {
    return needle
      ? `No component matches "${filter}".`
      : 'The render tree is empty.';
  }

  if (omitted > 0) {
    lines.push(
      `… ${omitted} more nodes not shown. Use filter, maxDepth or maxNodes to see them.`,
    );
  }

  return lines.join('\n');
}

function formatRenderNode(node, includeArgs) {
  let parts = [
    `${node.type} ${node.type === 'html-element' ? `<${node.name}>` : node.name}`,
  ];

  if (node.instance && typeof node.instance === 'object') {
    parts.push(`[${node.instance.id}]`);
  }

  if (includeArgs) {
    let args = formatArgs(node.args);
    if (args) parts.push(args);
  }

  if (node.template && node.type !== 'html-element') {
    parts.push(`template: ${node.template}`);
  }

  return parts.join('  ');
}

function formatArgs(args) {
  if (!args) return '';

  let parts = [];

  for (let value of args.positional ?? []) {
    parts.push(formatSerializedItem(value));
  }

  for (let [name, value] of Object.entries(args.named ?? {})) {
    parts.push(`@${name}=${formatSerializedItem(value)}`);
  }

  return parts.join(' ');
}

function formatSerializedItem(item) {
  if (item && typeof item === 'object') {
    return `${truncate(item.inspect)} [${item.id}]`;
  }

  if (typeof item === 'string') return truncate(JSON.stringify(item));

  return String(item);
}

function countNodes(node) {
  return (
    1 + (node.children ?? []).reduce((sum, child) => sum + countNodes(child), 0)
  );
}

export function formatObject(message, { path = [], allMixins = false } = {}) {
  let title = path.length
    ? `${path.join('.')} → ${message.name} [${message.objectId}]`
    : `${message.name} [${message.objectId}]`;

  let lines = [title];

  for (let mixin of message.details ?? []) {
    let properties = mixin.properties ?? [];

    if (!allMixins && !mixin.expand) {
      lines.push(
        '',
        `## ${mixin.name} — ${properties.length} properties (collapsed)`,
      );
      continue;
    }

    lines.push('', `## ${mixin.name}`);

    if (properties.length === 0) lines.push('(no properties)');

    for (let property of properties) {
      lines.push(formatProperty(property));
    }
  }

  if (message.errors?.length) {
    lines.push(
      '',
      `Reading these properties threw an error: ${message.errors
        .map((error) => error.property)
        .join(', ')}`,
    );
  }

  return lines.join('\n');
}

function formatProperty(property) {
  let value = property.value ?? {};
  let flags = [value.type?.replace(/^type-/, '')];

  if (property.isService) flags.push('service');
  if (property.isComputed) flags.push('computed');
  if (property.isGetter) flags.push('getter');
  if (property.isTracked) flags.push('tracked');
  if (property.readOnly) flags.push('read-only');
  if (
    property.isComputed &&
    !value.isCalculated &&
    value.type === 'type-descriptor'
  ) {
    flags.push('not calculated');
  }
  if (property.dependentKeys?.length) {
    let keys = property.dependentKeys.map((key) => key.name ?? key);
    flags.push(`depends on: ${keys.join(', ')}`);
  }

  return `- ${property.name}: ${truncate(value.inspect)}  (${flags.filter(Boolean).join(', ')})`;
}

function formatLibraries(libraries) {
  if (!libraries?.length) return '(unknown)';
  return libraries.map((lib) => `${lib.name} ${lib.version}`).join(', ');
}

function truncate(value) {
  let string = String(value);
  return string.length > MAX_VALUE_LENGTH
    ? `${string.slice(0, MAX_VALUE_LENGTH - 1)}…`
    : string;
}
