import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BUILTIN_AGENTS } from './agents.js';
import { IGNORED_BUNDLE_ENTRIES } from './hash.js';
import type { Scope, SkillSyncConfig, SkillSyncState } from './types.js';

export const DEFAULT_TOKEN_BUDGET_WARNING = 4000;

export interface StoreLayout {
  rootDir: string;
  skillsDir: string;
  configPath: string;
  statePath: string;
  backupsDir: string;
  gitignorePath: string;
}

export function resolveStoreDir(options: {
  homeDir?: string;
  cwd?: string;
  scope?: Exclude<Scope, 'all'>;
  storeDir?: string;
} = {}): string {
  if (options.storeDir) {
    return path.resolve(options.storeDir);
  }
  const scope = options.scope ?? 'global';
  if (scope === 'project') {
    return path.resolve(options.cwd ?? process.cwd(), '.skill-sync');
  }
  return path.join(options.homeDir ?? os.homedir(), '.skill-sync');
}

export function getStoreLayout(storeDir: string): StoreLayout {
  const rootDir = path.resolve(storeDir);
  return {
    rootDir,
    skillsDir: path.join(rootDir, 'skills'),
    configPath: path.join(rootDir, 'config.json'),
    statePath: path.join(rootDir, 'state.json'),
    backupsDir: path.join(rootDir, '.backups'),
    gitignorePath: path.join(rootDir, '.gitignore'),
  };
}

export function createDefaultConfig(detectedAgentIds?: string[]): SkillSyncConfig {
  const detectedSet = detectedAgentIds ? new Set(detectedAgentIds) : null;
  const agents: SkillSyncConfig['agents'] = {};

  for (const agent of BUILTIN_AGENTS) {
    agents[agent.id] = {
      enabled: detectedSet ? detectedSet.has(agent.id) : false,
      mode: 'symlink',
      profiles: ['*'],
    };
  }

  return {
    version: 1,
    defaultMode: 'symlink',
    tokenBudgetWarning: DEFAULT_TOKEN_BUDGET_WARNING,
    agents,
  };
}

export function createEmptyState(): SkillSyncState {
  return {
    version: 1,
    agents: {},
  };
}

export function ensureStore(
  storeDir: string,
  options: { detectedAgentIds?: string[] } = {},
): StoreLayout {
  const layout = getStoreLayout(storeDir);
  fs.mkdirSync(layout.skillsDir, { recursive: true });
  fs.mkdirSync(layout.backupsDir, { recursive: true });

  if (!fs.existsSync(layout.configPath)) {
    const config = createDefaultConfig(options.detectedAgentIds);
    saveConfig(storeDir, config);
  }

  if (!fs.existsSync(layout.gitignorePath)) {
    fs.writeFileSync(
      layout.gitignorePath,
      ['# Machine-local sync state & backups', 'state.json', '.backups/', '.DS_Store', ''].join(
        '\n',
      ),
      'utf8',
    );
  }

  return layout;
}

export function loadConfig(storeDir: string): SkillSyncConfig | null {
  const layout = getStoreLayout(storeDir);
  if (!fs.existsSync(layout.configPath)) {
    return null;
  }
  const raw = fs.readFileSync(layout.configPath, 'utf8');
  const parsed = JSON.parse(raw) as Partial<SkillSyncConfig>;
  return {
    version: 1,
    defaultMode: parsed.defaultMode ?? 'symlink',
    tokenBudgetWarning: parsed.tokenBudgetWarning ?? DEFAULT_TOKEN_BUDGET_WARNING,
    agents: parsed.agents ?? {},
    customAgents: parsed.customAgents,
    rulesBridge: parsed.rulesBridge,
  };
}

export function saveConfig(storeDir: string, config: SkillSyncConfig): void {
  const layout = getStoreLayout(storeDir);
  fs.mkdirSync(layout.rootDir, { recursive: true });
  fs.writeFileSync(layout.configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

export function loadState(storeDir: string): SkillSyncState {
  const layout = getStoreLayout(storeDir);
  if (!fs.existsSync(layout.statePath)) {
    return createEmptyState();
  }
  try {
    const raw = fs.readFileSync(layout.statePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<SkillSyncState>;
    return {
      version: 1,
      agents: parsed.agents ?? {},
    };
  } catch {
    return createEmptyState();
  }
}

export function saveState(storeDir: string, state: SkillSyncState): void {
  const layout = getStoreLayout(storeDir);
  fs.mkdirSync(layout.rootDir, { recursive: true });
  fs.writeFileSync(layout.statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export function copyBundleDirectory(srcDir: string, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true });
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });

  for (const entry of entries) {
    if (IGNORED_BUNDLE_ENTRIES.has(entry.name)) {
      continue;
    }
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);

    const stat = fs.statSync(srcPath);
    if (stat.isDirectory()) {
      copyBundleDirectory(srcPath, destPath);
    } else if (stat.isFile()) {
      fs.copyFileSync(srcPath, destPath);
      fs.chmodSync(destPath, stat.mode);
    }
  }
}

/**
 * Atomically replace destDir with a fresh copy of srcDir using a temp staging directory.
 */
export function copyBundleAtomic(srcDir: string, destDir: string): void {
  const parentDir = path.dirname(destDir);
  fs.mkdirSync(parentDir, { recursive: true });

  const stagingDir = path.join(
    parentDir,
    `.${path.basename(destDir)}.skill-sync-tmp-${process.pid}-${Date.now()}`,
  );

  try {
    copyBundleDirectory(srcDir, stagingDir);
    if (fs.existsSync(destDir) || isSymlink(destDir)) {
      fs.rmSync(destDir, { recursive: true, force: true });
    }
    fs.renameSync(stagingDir, destDir);
  } catch (err) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    throw err;
  }
}

export function isSymlink(targetPath: string): boolean {
  try {
    return fs.lstatSync(targetPath).isSymbolicLink();
  } catch {
    return false;
  }
}

export function backupPath(
  storeDir: string,
  label: string,
  sourcePath: string,
): string | null {
  let lstat: fs.Stats;
  try {
    lstat = fs.lstatSync(sourcePath);
  } catch {
    return null;
  }

  // Symlinks are cheap pointers and don't contain unique user data.
  if (lstat.isSymbolicLink()) {
    return null;
  }

  const layout = getStoreLayout(storeDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeLabel = label.replace(/[^a-zA-Z0-9._-]/g, '_');
  const destPath = path.join(layout.backupsDir, stamp, safeLabel);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });

  if (lstat.isDirectory()) {
    copyBundleDirectory(sourcePath, destPath);
  } else {
    fs.copyFileSync(sourcePath, destPath);
  }

  return destPath;
}
