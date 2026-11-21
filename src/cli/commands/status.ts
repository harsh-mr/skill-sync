import pc from 'picocolors';
import { scanSkills } from '../../core/scanner.js';
import { planSync } from '../../core/syncer.js';
import { parseCsvOption } from '../format.js';

export interface StatusCommandOptions {
  project?: boolean;
  agents?: string;
  store?: string;
  json?: boolean;
  home?: string;
  cwd?: string;
}

export function runStatusCommand(opts: StatusCommandOptions): void {
  const scope = opts.project ? 'project' : 'global';
  const agentIds = parseCsvOption(opts.agents);

  const scan = scanSkills({
    scope,
    agentIds,
    storeDir: opts.store,
    homeDir: opts.home,
    cwd: opts.cwd,
  });

  const plan = planSync({
    scope,
    agentIds,
    storeDir: opts.store,
    homeDir: opts.home,
    cwd: opts.cwd,
  });

  const payload = {
    scope,
    storeDir: scan.storeDir,
    detectedAgents: scan.agents.filter((a) => a.detected).map((a) => a.id),
    scanSummary: scan.summary,
    pendingSync: plan.summary,
  };

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  console.log('');
  console.log(pc.bold('skill-sync status') + pc.dim(` (${scope})`));
  console.log(pc.dim(`Store:  ${scan.storeDir}`));
  console.log(
    pc.dim('Agents: ') +
      (payload.detectedAgents.length > 0
        ? payload.detectedAgents.join(', ')
        : pc.dim('none detected')),
  );
  console.log(
    pc.dim('Skills: ') +
      `${scan.summary.totalSkills} total (` +
      `${pc.green(`${scan.summary.synced} synced`)}, ` +
      `${pc.cyan(`${scan.summary.unique + scan.summary.identicalScattered} unadopted`)}, ` +
      `${scan.summary.diverged > 0 ? pc.yellow(`${scan.summary.diverged} diverged`) : '0 diverged'})`,
  );

  const pendingChanges =
    plan.summary.create +
    plan.summary.update +
    plan.summary['pull-upstream'] +
    plan.summary.conflict;

  console.log(
    pc.dim('Sync:   ') +
      (pendingChanges === 0
        ? pc.green(`up to date (${plan.summary.noop} active link(s))`)
        : `${pc.cyan(`${pendingChanges} pending`)} (` +
          `${plan.summary.create} create, ${plan.summary.update} update, ` +
          `${plan.summary['pull-upstream']} pull, ${plan.summary.conflict} conflict)`),
  );
  console.log('');
}
