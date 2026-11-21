import pc from 'picocolors';
import {
  getGitStatus,
  pullStore,
  pushStore,
  setGitRemote,
} from '../../core/git.js';
import { resolveStoreDir } from '../../core/store.js';
import { applySync, planSync } from '../../core/syncer.js';

export interface GitCommandOptions {
  project?: boolean;
  store?: string;
  remote?: string;
  branch?: string;
  message?: string;
  syncAfter?: boolean;
  dryRun?: boolean;
  json?: boolean;
  home?: string;
  cwd?: string;
}

function getStore(opts: GitCommandOptions): string {
  return resolveStoreDir({
    homeDir: opts.home,
    cwd: opts.cwd,
    scope: opts.project ? 'project' : 'global',
    storeDir: opts.store,
  });
}

export function runRemoteCommand(
  url: string | undefined,
  opts: GitCommandOptions,
): void {
  const storeDir = getStore(opts);
  const remoteName = opts.remote ?? 'origin';

  if (!url) {
    const status = getGitStatus(storeDir, remoteName);
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
      return;
    }
    console.log('');
    console.log(pc.bold('skill-sync remote'));
    console.log(pc.dim(`Store:  ${status.storeDir}`));
    console.log(
      pc.dim('Remote: ') +
        (status.remoteUrl ? pc.cyan(status.remoteUrl) : pc.dim('not configured')),
    );
    if (status.branch) {
      console.log(pc.dim('Branch: ') + status.branch);
    }
    if (status.lastCommit) {
      console.log(
        pc.dim('HEAD:   ') +
          `${pc.yellow(status.lastCommit.hash)} ${status.lastCommit.subject}`,
      );
    }
    console.log('');
    return;
  }

  const res = setGitRemote(storeDir, url, remoteName);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    return;
  }
  console.log(
    `${pc.green('✓')} Configured ${pc.bold(res.remoteName)} → ${pc.cyan(res.remoteUrl)}` +
      (res.initialized ? pc.dim(' (initialized git repo)') : ''),
  );
}

export function runPushCommand(opts: GitCommandOptions): void {
  const storeDir = getStore(opts);
  const res = pushStore(storeDir, {
    message: opts.message,
    remoteName: opts.remote ?? 'origin',
    branch: opts.branch,
    dryRun: opts.dryRun,
  });

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    return;
  }

  const prefix = opts.dryRun ? pc.yellow('[dry-run] ') : '';
  console.log(`${prefix}${pc.green('✓')} ${res.summary}`);
}

export function runPullCommand(opts: GitCommandOptions): void {
  const storeDir = getStore(opts);
  const pullRes = pullStore(storeDir, {
    remoteName: opts.remote ?? 'origin',
    branch: opts.branch,
  });

  let syncSummary = null;
  if (opts.syncAfter !== false) {
    const scope = opts.project ? 'project' : 'global';
    const plan = planSync({
      scope,
      storeDir,
      homeDir: opts.home,
      cwd: opts.cwd,
    });
    syncSummary = applySync(plan, { conflictStrategy: 'skip' });
  }

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify({ pull: pullRes, sync: syncSummary }, null, 2)}\n`,
    );
    return;
  }

  console.log(
    `${pc.green('✓')} Pulled from ${pc.cyan(pullRes.remoteUrl ?? 'origin')} (${pullRes.branch})`,
  );
  if (syncSummary) {
    console.log(
      pc.dim(
        `Synced agents: ${syncSummary.applied.length} updated, ${syncSummary.conflictsRemaining.length} conflict(s).`,
      ),
    );
  }
}
