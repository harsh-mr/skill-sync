import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { resolveAgents } from './agents.js';
import { IGNORED_BUNDLE_ENTRIES } from './hash.js';
import {
  createDefaultConfig,
  ensureStore,
  getStoreLayout,
  loadConfig,
  resolveStoreDir,
} from './store.js';
import { applySync, planSync } from './syncer.js';
import type { SyncApplyResult, SyncMode, SyncPlan } from './types.js';

export interface WatchEvent {
  type: 'ready' | 'change' | 'synced' | 'error';
  changedPaths?: string[];
  plan?: SyncPlan;
  result?: SyncApplyResult;
  error?: string;
  watchedDirs?: string[];
}

export interface WatchOptions {
  homeDir?: string;
  cwd?: string;
  storeDir?: string;
  scope?: 'global' | 'project';
  agentIds?: string[];
  modeOverride?: SyncMode;
  pullUpstream?: boolean;
  debounceMs?: number;
  onEvent?: (event: WatchEvent) => void;
}

export interface WatchHandle {
  watchedDirs: string[];
  ready: Promise<void>;
  triggerSyncNow: () => SyncApplyResult;
  stop: () => Promise<void>;
}

export function startWatch(options: WatchOptions = {}): WatchHandle {
  const homeDir = options.homeDir ?? os.homedir();
  const cwd = options.cwd ?? process.cwd();
  const scope = options.scope ?? 'global';
  const storeDir = resolveStoreDir({
    homeDir,
    cwd,
    scope,
    storeDir: options.storeDir,
  });
  const debounceMs = options.debounceMs ?? 300;
  const pullUpstream = options.pullUpstream ?? true;

  ensureStore(storeDir);
  const layout = getStoreLayout(storeDir);

  const allAgents = resolveAgents({
    homeDir,
    cwd,
    scope,
    config: loadConfig(storeDir),
    agentIds: options.agentIds,
  });

  const config =
    loadConfig(storeDir) ??
    createDefaultConfig(allAgents.filter((a) => a.detected).map((a) => a.id));

  const watchedDirs: string[] = [layout.skillsDir];

  for (const agent of allAgents) {
    const enabled = options.agentIds?.length
      ? options.agentIds.includes(agent.id)
      : config.agents[agent.id]?.enabled ?? agent.detected;
    if (!enabled) {
      continue;
    }
    if (fs.existsSync(agent.skillsDir)) {
      watchedDirs.push(agent.skillsDir);
    }
  }

  let syncing = false;
  let suppressUntil = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingPaths = new Set<string>();

  const executeSync = (): SyncApplyResult => {
    syncing = true;
    const changed = [...pendingPaths];
    pendingPaths.clear();

    try {
      const plan = planSync({
        homeDir,
        cwd,
        storeDir,
        scope,
        agentIds: options.agentIds,
        modeOverride: options.modeOverride,
      });

      const hasActionable = plan.actions.some((a) => a.type !== 'noop');
      const result = applySync(plan, {
        pullUpstream,
        conflictStrategy: 'skip',
      });

      if (hasActionable) {
        options.onEvent?.({
          type: 'synced',
          changedPaths: changed,
          plan,
          result,
        });
      }
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      options.onEvent?.({
        type: 'error',
        changedPaths: changed,
        error: message,
      });
      return {
        applied: [],
        skipped: [],
        pulled: [],
        conflictsRemaining: [],
        backupsCreated: [],
        errors: [],
      };
    } finally {
      syncing = false;
      suppressUntil = Date.now() + 250;
    }
  };

  const scheduleSync = (filePath: string) => {
    if (syncing || Date.now() < suppressUntil) {
      return;
    }
    const base = path.basename(filePath);
    if (IGNORED_BUNDLE_ENTRIES.has(base) || base.includes('.skill-sync-tmp-')) {
      return;
    }

    pendingPaths.add(filePath);
    options.onEvent?.({ type: 'change', changedPaths: [filePath] });

    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      executeSync();
    }, debounceMs);
  };

  const watcher: FSWatcher = chokidar.watch(watchedDirs, {
    ignoreInitial: true,
    persistent: true,
    followSymlinks: false,
    ignored: (watchedPath) => {
      const base = path.basename(watchedPath);
      return (
        IGNORED_BUNDLE_ENTRIES.has(base) ||
        base.includes('.skill-sync-tmp-') ||
        watchedPath.includes(`${path.sep}.backups${path.sep}`)
      );
    },
  });

  const ready = new Promise<void>((resolve) => {
    watcher.on('ready', () => {
      options.onEvent?.({ type: 'ready', watchedDirs });
      resolve();
    });
  });

  watcher.on('add', scheduleSync);
  watcher.on('change', scheduleSync);
  watcher.on('unlink', scheduleSync);
  watcher.on('addDir', scheduleSync);
  watcher.on('unlinkDir', scheduleSync);
  watcher.on('error', (err) => {
    options.onEvent?.({
      type: 'error',
      error: err instanceof Error ? err.message : String(err),
    });
  });

  return {
    watchedDirs,
    ready,
    triggerSyncNow: executeSync,
    stop: async () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await watcher.close();
    },
  };
}
