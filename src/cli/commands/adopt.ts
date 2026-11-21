import * as p from '@clack/prompts';
import pc from 'picocolors';
import {
  adoptSkills,
  getAdoptableGroups,
  pickNewestInstance,
  type AdoptSelection,
} from '../../core/adopt.js';
import { diffSkillBundles, scanSkills } from '../../core/scanner.js';
import type { DiscoveredSkillInstance } from '../../core/types.js';
import { formatDateShort, parseCsvOption } from '../format.js';

export interface AdoptCommandOptions {
  project?: boolean;
  agents?: string;
  store?: string;
  yes?: boolean;
  strategy?: 'newest' | 'skip';
  dryRun?: boolean;
  json?: boolean;
  home?: string;
  cwd?: string;
}

export async function runAdoptCommand(opts: AdoptCommandOptions): Promise<void> {
  const scope = opts.project ? 'project' : 'global';
  const report = scanSkills({
    scope,
    agentIds: parseCsvOption(opts.agents),
    storeDir: opts.store,
    homeDir: opts.home,
    cwd: opts.cwd,
  });

  const { autoAdoptable, needsChoice, broken } = getAdoptableGroups(report);
  const detectedAgentIds = report.agents.filter((a) => a.detected).map((a) => a.id);

  if (autoAdoptable.length === 0 && needsChoice.length === 0) {
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ adopted: [], skipped: [] }, null, 2)}\n`);
      return;
    }
    console.log(pc.green('Nothing to adopt — all discovered skills are already in your canonical store.'));
    if (broken.length > 0) {
      console.log(
        pc.yellow(
          `Note: ${broken.length} broken skill(s) skipped. Run "skill-sync doctor" for details.`,
        ),
      );
    }
    return;
  }

  const selections: AdoptSelection[] = [];

  for (const group of autoAdoptable) {
    const chosen = pickNewestInstance(group.instances);
    if (chosen) {
      selections.push({
        skillName: group.skillName,
        sourceInstance: chosen,
      });
    }
  }

  const interactive = !opts.yes && !opts.json && Boolean(process.stdin.isTTY);

  if (interactive) {
    p.intro(pc.bold('skill-sync adopt'));
    if (autoAdoptable.length > 0) {
      p.log.info(
        `Ready to consolidate ${pc.bold(String(autoAdoptable.length))} non-conflicting skill(s) into ${pc.dim(report.storeDir)}`,
      );
    }
  }

  for (const group of needsChoice) {
    const candidates: DiscoveredSkillInstance[] = [
      ...(group.canonical ? [group.canonical] : []),
      ...group.instances,
    ].filter((c) => !c.isBrokenSymlink && c.realPath && c.hasSkillMd);

    if (candidates.length === 0) {
      continue;
    }

    if (!interactive) {
      const strategy = opts.strategy ?? 'skip';
      if (strategy === 'newest') {
        const newest = pickNewestInstance(candidates);
        if (newest) {
          selections.push({
            skillName: group.skillName,
            sourceInstance: newest,
          });
        }
      }
      continue;
    }

    // Show quick diff between first two distinct-hash candidates if available
    const first = candidates[0];
    const second = candidates.find((c) => c.hash !== first?.hash);
    if (first?.realPath && second?.realPath) {
      const diff = diffSkillBundles(first.realPath, second.realPath, {
        left: first.agentId,
        right: second.agentId,
      });
      if (diff.skillMdPatch) {
        const previewLines = diff.skillMdPatch.split('\n').slice(0, 24).join('\n');
        p.note(previewLines, `Diverged skill: ${group.skillName}`);
      }
    }

    const choice = await p.select({
      message: `Choose canonical source for diverged skill "${group.skillName}"`,
      options: [
        ...candidates.map((cand, idx) => ({
          value: String(idx),
          label: `${cand.agentName} (${cand.agentId})`,
          hint: `${cand.files.length} files · updated ${formatDateShort(cand.mtimeMs)}`,
        })),
        { value: 'skip', label: 'Skip for now', hint: 'Leave untouched' },
      ],
    });

    if (p.isCancel(choice)) {
      p.cancel('Adoption cancelled.');
      process.exit(1);
    }

    if (choice !== 'skip') {
      const picked = candidates[Number(choice)];
      if (picked) {
        selections.push({
          skillName: group.skillName,
          sourceInstance: picked,
        });
      }
    }
  }

  if (interactive && selections.length > 0 && !opts.dryRun) {
    const ok = await p.confirm({
      message: `Import ${selections.length} skill(s) into ${report.storeDir}/skills?`,
      initialValue: true,
    });
    if (p.isCancel(ok) || !ok) {
      p.cancel('Adoption cancelled.');
      return;
    }
  }

  const result = adoptSkills({
    storeDir: report.storeDir,
    selections,
    enableDetectedAgents: detectedAgentIds,
    dryRun: opts.dryRun,
  });

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  const prefix = opts.dryRun ? pc.yellow('[dry-run] ') : '';
  for (const item of result.adopted) {
    console.log(
      `  ${prefix}${pc.green('✓')} Adopted ${pc.bold(item.skillName)} from ${pc.cyan(item.fromAgent)}` +
        (item.backupCreated ? pc.dim(` (backup: ${item.backupCreated})`) : ''),
    );
  }
  for (const item of result.skipped) {
    console.log(`  ${pc.dim('·')} Skipped ${item.skillName}: ${pc.dim(item.reason)}`);
  }

  if (needsChoice.length > 0 && !interactive && (opts.strategy ?? 'skip') === 'skip') {
    console.log(
      pc.yellow(
        `\n${needsChoice.length} diverged skill(s) were skipped. Run interactively or pass "--strategy newest" to auto-pick the most recently modified copy.`,
      ),
    );
  }

  if (result.adopted.length > 0 && !opts.dryRun) {
    console.log(
      pc.dim('\nNext step: run ') +
        pc.bold(`skill-sync sync${opts.project ? ' --project' : ''}`) +
        pc.dim(' to sync canonical skills across all enabled agents.'),
    );
  }

  if (interactive) {
    p.outro('Done');
  }
}
