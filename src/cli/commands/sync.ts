import * as p from '@clack/prompts';
import pc from 'picocolors';
import { diffSkillBundles } from '../../core/scanner.js';
import { applySync, planSync, syncRulesBridge } from '../../core/syncer.js';
import type { ConflictResolution, SyncMode } from '../../core/types.js';
import { formatActionType, padRight, parseCsvOption } from '../format.js';

export interface SyncCommandOptions {
  project?: boolean;
  agents?: string;
  store?: string;
  mode?: SyncMode;
  dryRun?: boolean;
  prune?: boolean;
  pull?: boolean;
  conflict?: ConflictResolution;
  bridgeRules?: boolean;
  yes?: boolean;
  json?: boolean;
  home?: string;
  cwd?: string;
}

export async function runSyncCommand(opts: SyncCommandOptions): Promise<void> {
  const scope = opts.project ? 'project' : 'global';
  const plan = planSync({
    scope,
    agentIds: parseCsvOption(opts.agents),
    storeDir: opts.store,
    modeOverride: opts.mode,
    includePrune: Boolean(opts.prune),
    homeDir: opts.home,
    cwd: opts.cwd,
  });

  const actionable = plan.actions.filter((a) => a.type !== 'noop');
  const interactive = !opts.yes && !opts.json && !opts.dryRun && Boolean(process.stdin.isTTY);
  const perActionResolution: Record<string, ConflictResolution> = {};

  if (!opts.json) {
    console.log('');
    console.log(
      pc.bold('skill-sync sync') +
        pc.dim(` (${plan.scope})`) +
        (opts.dryRun ? pc.yellow(' [dry-run]') : ''),
    );
    console.log(pc.dim(`Canonical store: ${plan.storeDir}`));
    console.log('');
  }

  if (actionable.length === 0 && !opts.bridgeRules) {
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ plan, applied: [] }, null, 2)}\n`);
      return;
    }
    console.log(
      pc.green(`Everything is up to date (${plan.summary.noop} synced skill link(s)).\n`),
    );
    return;
  }

  if (!opts.json && actionable.length > 0) {
    for (const action of actionable) {
      console.log(
        `  ${padRight(formatActionType(action.type), 14)} ${padRight(pc.bold(action.skillName), 26)} ${padRight(pc.cyan(action.agentId), 14)} ${pc.dim(`[${action.mode}] ${action.reason}`)}`,
      );
    }
    console.log('');
  }

  if (interactive) {
    for (const action of actionable) {
      if (action.type !== 'conflict' && action.type !== 'pull-upstream') {
        continue;
      }

      if (action.type === 'conflict' && opts.conflict) {
        perActionResolution[action.id] = opts.conflict;
        continue;
      }

      try {
        const diff = diffSkillBundles(action.sourcePath, action.targetPath, {
          left: 'canonical',
          right: action.agentId,
        });
        if (diff.skillMdPatch) {
          const preview = diff.skillMdPatch.split('\n').slice(0, 24).join('\n');
          p.note(preview, `${action.skillName} (${action.agentId})`);
        }
      } catch {
        // Ignore diff preview errors
      }

      const choice = await p.select({
        message:
          action.type === 'pull-upstream'
            ? `"${action.skillName}" was edited in ${action.agentName}. How should we sync it?`
            : `Conflict on "${action.skillName}" in ${action.agentName}. Which version wins?`,
        options: [
          {
            value: 'agent',
            label: `Pull from ${action.agentName} → canonical`,
            hint: 'Keep agent edits and update canonical store',
          },
          {
            value: 'canonical',
            label: `Push canonical → ${action.agentName}`,
            hint: 'Overwrite agent copy (backup saved automatically)',
          },
          {
            value: 'skip',
            label: 'Skip for now',
            hint: 'Leave both untouched',
          },
        ],
      });

      if (p.isCancel(choice)) {
        p.cancel('Sync cancelled.');
        process.exit(1);
      }

      perActionResolution[action.id] = choice as ConflictResolution;
    }
  }

  const result = applySync(plan, {
    dryRun: opts.dryRun,
    conflictStrategy: opts.conflict ?? 'skip',
    perActionResolution,
    pullUpstream: opts.pull ?? true,
    prune: Boolean(opts.prune),
  });

  const bridgeResult =
    opts.bridgeRules && scope === 'project'
      ? syncRulesBridge({
          cwd: opts.cwd,
          mode: opts.mode ?? 'copy',
          dryRun: opts.dryRun,
        })
      : null;

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify({ plan, result, rulesBridge: bridgeResult }, null, 2)}\n`,
    );
    if (result.conflictsRemaining.length > 0 || result.errors.length > 0) {
      process.exitCode = result.errors.length > 0 ? 1 : 2;
    }
    return;
  }

  const prefix = opts.dryRun ? pc.yellow('[dry-run] ') : '';
  console.log(
    `${prefix}` +
      [
        pc.green(`${result.applied.length} applied`),
        pc.blue(`${result.pulled.length} pulled upstream`),
        pc.dim(`${plan.summary.noop} unchanged`),
        result.skipped.length > 0 ? pc.dim(`${result.skipped.length} skipped`) : null,
        result.conflictsRemaining.length > 0
          ? pc.yellow(`${result.conflictsRemaining.length} unresolved conflict(s)`)
          : null,
        result.errors.length > 0 ? pc.red(`${result.errors.length} error(s)`) : null,
      ]
        .filter(Boolean)
        .join(pc.dim(' · ')),
  );

  if (result.backupsCreated.length > 0) {
    console.log(pc.dim(`Backups saved: ${result.backupsCreated.length}`));
  }

  if (bridgeResult) {
    if (bridgeResult.skipped) {
      console.log(pc.dim(`Rules bridge: ${bridgeResult.reason}`));
    } else if (bridgeResult.syncedTargets.length > 0) {
      console.log(
        `${prefix}${pc.green('✓')} Rules bridge synced AGENTS.md → ${bridgeResult.syncedTargets.join(', ')}`,
      );
    } else {
      console.log(pc.dim('Rules bridge: AGENTS.md and CLAUDE.md are already in sync.'));
    }
  }

  for (const err of result.errors) {
    console.error(pc.red(`Error (${err.action.id}): ${err.error}`));
  }

  if (result.conflictsRemaining.length > 0) {
    console.log(
      pc.yellow(
        '\nUnresolved conflicts were skipped. Re-run interactively or pass "--conflict canonical|agent".',
      ),
    );
    process.exitCode = 2;
  }
  if (result.errors.length > 0) {
    process.exitCode = 1;
  }
  console.log('');
}
