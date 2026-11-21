import pc from 'picocolors';
import type { SkillClassification, SyncActionType } from '../core/types.js';

export function formatClassification(c: SkillClassification): string {
  switch (c) {
    case 'synced':
      return pc.green('synced');
    case 'unique':
      return pc.cyan('unique');
    case 'identical-scattered':
      return pc.blue('scattered');
    case 'diverged':
      return pc.yellow('diverged');
    case 'broken':
      return pc.red('broken');
    case 'canonical-only':
      return pc.magenta('canonical-only');
  }
}

export function formatActionType(t: SyncActionType): string {
  switch (t) {
    case 'create':
      return pc.green('+ create');
    case 'update':
      return pc.cyan('~ update');
    case 'pull-upstream':
      return pc.blue('← pull');
    case 'conflict':
      return pc.yellow('! conflict');
    case 'remove':
      return pc.red('- remove');
    case 'noop':
      return pc.dim('= synced');
    case 'skip':
      return pc.dim('· skip');
  }
}

export function padRight(str: string, width: number): string {
  // Strip ANSI escape codes when calculating visual width
  const stripped = str.replace(/\x1B\[[0-9;]*m/g, '');
  if (stripped.length >= width) {
    return str;
  }
  return str + ' '.repeat(width - stripped.length);
}

export function formatDateShort(mtimeMs: number): string {
  if (!mtimeMs) {
    return 'unknown';
  }
  return new Date(mtimeMs).toISOString().replace('T', ' ').slice(0, 16);
}

export function parseCsvOption(value?: string): string[] | undefined {
  if (!value) {
    return undefined;
  }
  const items = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}
