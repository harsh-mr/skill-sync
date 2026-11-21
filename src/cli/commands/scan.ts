import pc from 'picocolors';
import { scanSkills } from '../../core/scanner.js';
import type { Scope } from '../../core/types.js';
import { formatClassification, padRight, parseCsvOption } from '../format.js';

export interface ScanCommandOptions {
  project?: boolean;
  all?: boolean;
  agents?: string;
  store?: string;
  json?: boolean;
  home?: string;
  cwd?: string;
}

export function runScanCommand(opts: ScanCommandOptions): void {
  const scope: Scope = opts.all ? 'all' : opts.project ? 'project' : 'global';
  const report = scanSkills({
    scope,
    agentIds: parseCsvOption(opts.agents),
    storeDir: opts.store,
    homeDir: opts.home,
    cwd: opts.cwd,
  });

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  console.log('');
  console.log(pc.bold(`skill-sync scan`) + pc.dim(` (${report.scope})`));
  console.log(pc.dim(`Canonical store: ${report.storeDir}`));
  console.log('');

  const detectedAgents = report.agents.filter((a) => a.detected);
  console.log(pc.bold(`Detected Agents (${detectedAgents.length}/${report.agents.length})`));
  if (detectedAgents.length === 0) {
    console.log(pc.dim('  No coding agents detected in this scope.'));
  } else {
    for (const agent of detectedAgents) {
      const budget = report.tokenBudgets.find(
        (b) => b.agentId === agent.id && b.scope === agent.scope,
      );
      const countLabel = `${budget?.skillCount ?? 0} skills`;
      const tokenLabel = `~${budget?.frontmatterTokens ?? 0} frontmatter tok`;
      const warnTag = budget?.exceedsBudget ? pc.yellow(' [OVER BUDGET]') : '';
      console.log(
        `  ${pc.green('●')} ${padRight(agent.name, 20)} ${padRight(pc.dim(agent.id), 14)} ${padRight(countLabel, 12)} ${pc.dim(tokenLabel)}${warnTag}`,
      );
    }
  }

  console.log('');
  console.log(pc.bold(`Discovered Skills (${report.summary.totalSkills})`));
  if (report.skills.length === 0) {
    console.log(pc.dim('  No skills found across canonical store or agent folders.'));
  } else {
    for (const group of report.skills) {
      const locations = [
        ...(group.canonical ? [pc.bold('canonical')] : []),
        ...group.instances.map((i) =>
          i.isBrokenSymlink
            ? pc.red(`${i.agentId}(broken)`)
            : i.isSymlink
              ? pc.dim(`${i.agentId}→`)
              : i.agentId,
        ),
      ].join(', ');

      const tokens = pc.dim(`${group.frontmatterTokens} tok`);
      const tagText =
        group.tags.length > 0 ? pc.dim(` [${group.tags.join(', ')}]`) : '';

      console.log(
        `  ${padRight(pc.bold(group.skillName), 28)} ${padRight(formatClassification(group.classification), 16)} ${padRight(tokens, 10)} ${locations}${tagText}`,
      );
    }
  }

  console.log('');
  const s = report.summary;
  console.log(
    pc.dim('Summary: ') +
      [
        pc.green(`${s.synced} synced`),
        pc.cyan(`${s.unique} unique`),
        pc.blue(`${s.identicalScattered} scattered`),
        s.diverged > 0 ? pc.yellow(`${s.diverged} diverged`) : pc.dim('0 diverged'),
        s.broken > 0 ? pc.red(`${s.broken} broken`) : pc.dim('0 broken'),
        s.canonicalOnly > 0
          ? pc.magenta(`${s.canonicalOnly} canonical-only`)
          : pc.dim('0 canonical-only'),
      ].join(pc.dim(' · ')),
  );

  if (s.unique + s.identicalScattered + s.diverged > 0) {
    console.log(
      pc.dim('\nNext step: run ') +
        pc.bold('skill-sync adopt') +
        pc.dim(' to consolidate discovered skills into your canonical store.'),
    );
  } else if (s.canonicalOnly > 0) {
    console.log(
      pc.dim('\nNext step: run ') +
        pc.bold('skill-sync sync') +
        pc.dim(' to distribute canonical skills to your agents.'),
    );
  }
  console.log('');
}
