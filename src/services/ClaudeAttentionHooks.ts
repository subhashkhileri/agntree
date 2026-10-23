import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ATTENTION_HOOK_COMMAND } from './attentionLog';

/** Claude notification types that mean "a human is needed". */
export const ATTENTION_NOTIFICATION_MATCHER =
  'permission_prompt|idle_prompt|elicitation_dialog';

/** The events Agntree's hooks own; Stop needs no matcher, Notification does. */
const HOOK_EVENTS = ['Stop', 'Notification'] as const;
type HookEvent = (typeof HOOK_EVENTS)[number];

const ADDED_GROUP: Record<HookEvent, { matcher?: string }> = {
  Stop: {},
  Notification: { matcher: ATTENTION_NOTIFICATION_MATCHER },
};

export type ClaudeSettings = Record<string, unknown>;

interface HookCommand {
  type?: string;
  command?: string;
  [key: string]: unknown;
}

interface HookGroup {
  matcher?: string;
  hooks?: HookCommand[];
  [key: string]: unknown;
}

export interface ApplyResult {
  path: string;
  changed: boolean;
  error?: string;
}

export function claudeSettingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** True when this group runs Agntree's attention hook. */
function isAttentionGroup(group: HookGroup): boolean {
  return (
    Array.isArray(group?.hooks) &&
    group.hooks.some((hook) => hook?.command === ATTENTION_HOOK_COMMAND)
  );
}

function hookGroups(settings: ClaudeSettings, event: string): HookGroup[] {
  if (!isPlainObject(settings.hooks)) {
    return [];
  }
  const list = settings.hooks[event];
  return Array.isArray(list) ? (list as HookGroup[]) : [];
}

/**
 * Refuse to touch a settings file whose hook shapes we do not understand, so a
 * malformed config can never be replaced by an unexpected structure.
 */
export function validateHookShape(settings: ClaudeSettings): string | null {
  if (settings.hooks === undefined) {
    return null;
  }
  if (!isPlainObject(settings.hooks)) {
    return 'settings.json has an unexpected "hooks" value (expected an object)';
  }
  for (const event of HOOK_EVENTS) {
    const list = settings.hooks[event];
    if (list !== undefined && !Array.isArray(list)) {
      return `settings.json has an unexpected "hooks.${event}" value (expected an array)`;
    }
  }
  return null;
}

export function hasAttentionHooks(settings: ClaudeSettings): boolean {
  return HOOK_EVENTS.some((event) =>
    hookGroups(settings, event).some(isAttentionGroup)
  );
}

/** Whether the settings file on disk currently carries Agntree's hooks. */
export function attentionHooksInstalled(
  settingsPath: string = claudeSettingsPath()
): boolean {
  try {
    if (!fs.existsSync(settingsPath)) {
      return false;
    }
    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    return isPlainObject(parsed) && hasAttentionHooks(parsed);
  } catch {
    return false;
  }
}

/**
 * Add the Stop and Notification hook groups, leaving every other key and every
 * existing hook untouched. Pure: the input is never mutated.
 */
export function mergeAttentionHooks(settings: ClaudeSettings): ClaudeSettings {
  const next = JSON.parse(JSON.stringify(settings)) as ClaudeSettings;

  if (!isPlainObject(next.hooks)) {
    next.hooks = {};
  }
  const hooks = next.hooks as Record<string, unknown>;

  for (const event of HOOK_EVENTS) {
    if (!Array.isArray(hooks[event])) {
      hooks[event] = [];
    }
    const groups = hooks[event] as HookGroup[];
    if (!groups.some(isAttentionGroup)) {
      groups.push({
        ...ADDED_GROUP[event],
        hooks: [{ type: 'command', command: ATTENTION_HOOK_COMMAND }],
      });
    }
  }

  return next;
}

/**
 * Remove only the hook groups Agntree added. Empty event arrays are dropped;
 * unrelated hooks are left exactly as they were.
 */
export function removeAttentionHooks(settings: ClaudeSettings): ClaudeSettings {
  const next = JSON.parse(JSON.stringify(settings)) as ClaudeSettings;
  if (!isPlainObject(next.hooks)) {
    return next;
  }

  const hooks = next.hooks as Record<string, unknown>;
  for (const event of HOOK_EVENTS) {
    if (!Array.isArray(hooks[event])) {
      continue;
    }
    const kept = (hooks[event] as HookGroup[]).filter(
      (group) => !isAttentionGroup(group)
    );
    if (kept.length === 0) {
      delete hooks[event];
    } else {
      hooks[event] = kept;
    }
  }

  return next;
}

export function applyAttentionHooks(
  settingsPath: string = claudeSettingsPath()
): ApplyResult {
  return updateSettings(settingsPath, mergeAttentionHooks);
}

export function revertAttentionHooks(
  settingsPath: string = claudeSettingsPath()
): ApplyResult {
  return updateSettings(settingsPath, removeAttentionHooks);
}

function updateSettings(
  settingsPath: string,
  update: (settings: ClaudeSettings) => ClaudeSettings
): ApplyResult {
  let settings: ClaudeSettings = {};

  if (fs.existsSync(settingsPath)) {
    let raw: string;
    try {
      raw = fs.readFileSync(settingsPath, 'utf-8');
    } catch (error) {
      return {
        path: settingsPath,
        changed: false,
        error: `could not read the file (${String(error)})`,
      };
    }

    if (raw.trim()) {
      try {
        const parsed = JSON.parse(raw);
        if (!isPlainObject(parsed)) {
          return {
            path: settingsPath,
            changed: false,
            error: 'the file is not a JSON object',
          };
        }
        settings = parsed;
      } catch {
        return {
          path: settingsPath,
          changed: false,
          error: 'the file is not valid JSON, so it was left untouched',
        };
      }
    }
  }

  const shapeError = validateHookShape(settings);
  if (shapeError) {
    return { path: settingsPath, changed: false, error: shapeError };
  }

  const next = update(settings);
  if (JSON.stringify(next) === JSON.stringify(settings)) {
    return { path: settingsPath, changed: false };
  }

  try {
    if (fs.existsSync(settingsPath)) {
      const backup = `${settingsPath}.agntree-backup`;
      // Keep the first pre-Agntree copy; later runs must not overwrite it.
      if (!fs.existsSync(backup)) {
        fs.copyFileSync(settingsPath, backup);
      }
    }
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      `${JSON.stringify(next, null, 2)}\n`,
      'utf-8'
    );
  } catch (error) {
    return {
      path: settingsPath,
      changed: false,
      error: `could not write the file (${String(error)})`,
    };
  }

  return { path: settingsPath, changed: true };
}
