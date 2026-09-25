import { defaultConfig, type Config } from './config.js';
import { FLEET_FIELDS } from './configFieldsFleet.js';
import { TRACKER_FIELDS } from './configFieldsTracker.js';
import { POLICY_FIELDS } from './configFieldsPolicy.js';
import { DEPLOYMENT_FIELDS } from './configFieldsDeployment.js';

// → docs/spec/02-configuration.md

export type ConfigFieldType = 'number' | 'boolean' | 'string' | 'text' | 'enum' | 'stringList' | 'json' | 'colourMap';

export type ConfigFieldAccess = 'plain' | 'advanced' | 'fileOnly';

export interface ConfigField {
  path: string;
  type: ConfigFieldType;
  options?: readonly string[];
  access: ConfigFieldAccess;
  why: string;
  env?: string;
  ms?: boolean;
  requiredWhen?: ConfigFieldRequirement;
  suggest?: ConfigFieldSuggestion;
}

export interface ConfigFieldRequirement {
  path: string;
  unless: string;
}

interface ConfigFieldSuggestion {
  join: readonly string[];
  with: string;
}

export const CONFIG_FIELDS: readonly ConfigField[] = [
  ...FLEET_FIELDS,
  ...TRACKER_FIELDS,
  ...POLICY_FIELDS,
  ...DEPLOYMENT_FIELDS,
];

const BY_PATH = new Map(CONFIG_FIELDS.map((field) => [field.path, field]));

export function configField(path: string): ConfigField | undefined {
  return BY_PATH.get(path);
}

export function readPath(config: Partial<Config>, path: string): unknown {
  let cursor: unknown = config;
  for (const segment of path.split('.')) {
    if (typeof cursor !== 'object' || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

export function suggestedValue(field: ConfigField, config: Partial<Config>): string | undefined {
  const suggest = field.suggest;
  if (!suggest) return undefined;
  const parts = suggest.join.map((path) => readPath(config, path));
  if (!parts.every((part) => typeof part === 'string' && part !== '')) return undefined;
  return parts.join(suggest.with);
}

export function envOverride(field: ConfigField): string | undefined {
  return field.env && process.env[field.env] ? field.env : undefined;
}

export function fieldValueRefusal(field: ConfigField, value: unknown): string | null {
  return acceptsValue(field, value) ? null : refusalFor(field);
}

function acceptsValue(field: ConfigField, value: unknown): boolean {
  switch (field.type) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'string':
    case 'text':
      return typeof value === 'string';
    case 'enum':
      return typeof value === 'string' && field.options?.includes(value) === true;
    case 'stringList':
      return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
    case 'json':
      return value !== undefined;
    case 'colourMap':
      return isColourMap(value);
  }
}

function refusalFor(field: ConfigField): string {
  switch (field.type) {
    case 'number':
      return `${field.path} must be a number`;
    case 'boolean':
      return `${field.path} must be true or false`;
    case 'string':
    case 'text':
      return `${field.path} must be a string`;
    case 'enum':
      return `${field.path} must be one of ${field.options?.join(', ')}`;
    case 'stringList':
      return `${field.path} must be a list of strings`;
    case 'json':
      return `${field.path} must be a value`;
    case 'colourMap':
      return `${field.path} must map a state to a #rrggbb colour`;
  }
}

const HEX_COLOUR = /^#[0-9a-f]{6}$/i;

function isColourMap(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((entry) => typeof entry === 'string' && HEX_COLOUR.test(entry));
}

export function declaredTopLevelKeys(): Set<string> {
  return new Set(CONFIG_FIELDS.map((field) => topSegment(field.path)));
}

export function topSegment(path: string): string {
  return path.split('.')[0] ?? path;
}

export function configTopLevelKeys(): Set<string> {
  return new Set(Object.keys(defaultConfig()));
}
