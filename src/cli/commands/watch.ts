import pc from 'picocolors';
import { startWatch } from '../../core/watcher.js';
import type { SyncMode } from '../../core/types.js';
import { parseCsvOption } from '../format.js';

export interface WatchCommandOptions {
  project?: boolean;
  agents?: string;
  store?: string;
  mode?: SyncMode;
  pull?: boolean;
  debounce?: string;
  home?: string;
  cwd?: string;
}

export async function runWatchCommand(opts: WatchCommandOptions): Promise<void> {
  const scope = opts.project ? 'project' : 'global';
  const debounceMs = opts.debounce ? Number(opts.debounce) : 300;

  console.log('');
  console.log(pc.bold('skill-sync watch') + pc.dim(` (${scope})`));

  const handle = startWatch({
    scope,
    agentIds: parseCsvOption(opts.agents),
    storeDir: opts.store,
    modeOverride: opts.mode,
    pullUpstream: opts.pull ?? true,
    debounceMs: Number.isFinite(debounceMs) ? debounceMs : 300,
    homeDir: opts.home,
    cwd: opts.cwd,
    onEvent: (event) => {
      const ts = pc.dim(new Date().toTimeString().slice(0, 8));
      if (event.type === 'ready') {
        console.log(
          `${ts} ${pc.green('●')} Watching ${event.watchedDirs?.length ?? 0} director(ies):`,
        );
        for (const dir of event.watchedDirs ?? []) {
          console.log(`         ${pc.dim(dir)}`);
        }
        console.log(pc.dim('\nPress Ctrl+C to stop.\n'));
      } else if (event.type === 'synced' && event.result) {
        const r = event.result;
        const parts = [
          r.applied.length > 0 ? pc.green(`${r.applied.length} synced`) : null,
          r.pulled.length > 0 ? pc.blue(`${r.pulled.length} pulled upstream`) : null,
          r.conflictsRemaining.length > 0
            ? pc.yellow(`${r.conflictsRemaining.length} conflict(s) skipped`)
            : null,
        ].filter(Boolean);
        if (parts.length > 0) {
          console.log(`${ts} ${parts.join(pc.dim(' · '))}`);
        }
      } else if (event.type === 'error') {
        console.error(`${ts} ${pc.red('error')} ${event.error}`);
      }
    },
  });

  await handle.ready;

  const shutdown = async () => {
    console.log(pc.dim('\nStopping watcher...'));
    await handle.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
