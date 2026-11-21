import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveAgents } from './agents.js';
import { hashSkillBundle, IGNORED_BUNDLE_ENTRIES } from './hash.js';
import { parseSkillFile } from './parser.js';
import {
  backupPath,
  copyBundleAtomic,
  createDefaultConfig,
  ensureStore,
  getStoreLayout,
  isSymlink,
  loadConfig,
  loadState,
  resolveStoreDir,
  saveState,
} from './store.js';
import type {
  AgentConfig,
  ConflictResolution,
  ResolvedAgent,
  SkillSyncConfig,
  SkillSyncState,
  SyncAction,
  SyncActionType,
  SyncApplyResult,
  SyncMode,
  SyncPlan,
} from './types.js';

export interface CanonicalSkill {
  name: string;
  path: string;
  realPath: string;
  hash: string;
  tags: string[];
}

export function listCanonicalSkills(storeDir: string): CanonicalSkill[] {
  const layout = getStoreLayout(storeDir);
  if (!fs.existsSync(layout.skillsDir)) {
    return [];
  }

  const results: CanonicalSkill[] = [];
  const entries = fs.readdirSync(layout.skillsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (IGNORED_BUNDLE_ENTRIES.has(entry.name) || entry.name.startsWith('.')) {
      continue;
    }
    const skillPath = path.join(layout.skillsDir, entry.name);
    let realPath: string;
    try {
      realPath = fs.realpathSync(skillPath);
      if (!fs.statSync(realPath).isDirectory()) {
        continue;
      }
    } catch {
      continue;
    }

    if (!fs.existsSync(path.join(realPath, 'SKILL.md'))) {
      continue;
    }

    const { hash } = hashSkillBundle(realPath);
    const parsed = parseSkillFile(realPath, entry.name);
    const tags = parsed?.frontmatter?.tags ?? [];

    results.push({
      name: entry.name,
      path: skillPath,
      realPath,
      hash,
      tags,
    });
  }

  return results.sort((a, b) => a.name.localeCompare(b.name));
}

export function matchesAgentProfile(
  skill: CanonicalSkill,
  agentConfig: AgentConfig | undefined,
): boolean {
  if (!agentConfig) {
    return true;
  }

  if (agentConfig.exclude?.includes(skill.name)) {
    return false;
  }

  if (agentConfig.include?.length) {
    return agentConfig.include.includes(skill.name);
  }

  const profiles = agentConfig.profiles;
  if (!profiles || profiles.length === 0 || profiles.includes('*')) {
    return true;
  }

  const normalizedProfiles = new Set(profiles.map((p) => p.trim().toLowerCase()));
  if (normalizedProfiles.has(skill.name.toLowerCase())) {
    return true;
  }

  return skill.tags.some((tag) => normalizedProfiles.has(tag.toLowerCase()));
}

export interface PlanSyncOptions {
  homeDir?: string;
  cwd?: string;
  storeDir?: string;
  scope?: 'global' | 'project';
  config?: SkillSyncConfig | null;
  state?: SkillSyncState;
  agentIds?: string[];
  modeOverride?: SyncMode;
  includePrune?: boolean;
}

function createEmptySummary(): Record<SyncActionType, number> {
  return {
    create: 0,
    update: 0,
    'pull-upstream': 0,
    conflict: 0,
    remove: 0,
    noop: 0,
    skip: 0,
  };
}

function getTargetAgents(
  agents: ResolvedAgent[],
  config: SkillSyncConfig,
  explicitAgentIds?: string[],
): ResolvedAgent[] {
  const explicitSet = explicitAgentIds?.length ? new Set(explicitAgentIds) : null;

  return agents.filter((agent) => {
    if (explicitSet) {
      return explicitSet.has(agent.id);
    }
    const cfg = config.agents[agent.id];
    if (cfg !== undefined) {
      return cfg.enabled;
    }
    return agent.detected;
  });
}

export function planSync(options: PlanSyncOptions = {}): SyncPlan {
  const homeDir = options.homeDir ?? os.homedir();
  const cwd = options.cwd ?? process.cwd();
  const scope = options.scope ?? 'global';
  const storeDir = resolveStoreDir({
    homeDir,
    cwd,
    scope,
    storeDir: options.storeDir,
  });

  const allAgents = resolveAgents({
    homeDir,
    cwd,
    scope,
    config: options.config ?? loadConfig(storeDir),
    agentIds: options.agentIds,
  });

  const config =
    options.config ??
    loadConfig(storeDir) ??
    createDefaultConfig(allAgents.filter((a) => a.detected).map((a) => a.id));

  const state = options.state ?? loadState(storeDir);
  const canonicalSkills = listCanonicalSkills(storeDir);
  const targetAgents = getTargetAgents(allAgents, config, options.agentIds);

  const actions: SyncAction[] = [];
  const summary = createEmptySummary();

  for (const agent of targetAgents) {
    const agentConfig = config.agents[agent.id];
    const mode: SyncMode =
      options.modeOverride ?? agentConfig?.mode ?? config.defaultMode ?? 'symlink';
    const agentState = state.agents[agent.id] ?? {};
    const plannedNames = new Set<string>();

    for (const skill of canonicalSkills) {
      if (!matchesAgentProfile(skill, agentConfig)) {
        continue;
      }

      plannedNames.add(skill.name);
      const targetPath = path.join(agent.skillsDir, skill.name);
      const record = agentState[skill.name];
      const lastSyncedHash = record?.syncedHash;
      const actionId = `${agent.id}:${skill.name}`;

      let lstat: fs.Stats | null = null;
      try {
        lstat = fs.lstatSync(targetPath);
      } catch {
        lstat = null;
      }

      // Target does not exist yet
      if (!lstat) {
        actions.push({
          id: actionId,
          agentId: agent.id,
          agentName: agent.name,
          scope,
          skillName: skill.name,
          sourcePath: skill.realPath,
          targetPath,
          mode,
          type: 'create',
          reason: `Create ${mode} in ${agent.name}`,
          canonicalHash: skill.hash,
          lastSyncedHash,
        });
        summary.create += 1;
        continue;
      }

      const targetIsSymlink = lstat.isSymbolicLink();
      let targetRealPath: string | null = null;
      let targetBroken = false;
      try {
        targetRealPath = fs.realpathSync(targetPath);
      } catch {
        targetBroken = true;
      }

      // Broken symlink at target -> safe to recreate
      if (targetIsSymlink && targetBroken) {
        actions.push({
          id: actionId,
          agentId: agent.id,
          agentName: agent.name,
          scope,
          skillName: skill.name,
          sourcePath: skill.realPath,
          targetPath,
          mode,
          type: 'update',
          reason: `Repair broken symlink in ${agent.name}`,
          canonicalHash: skill.hash,
          lastSyncedHash,
        });
        summary.update += 1;
        continue;
      }

      // Symlink already pointing straight to canonical
      if (targetIsSymlink && targetRealPath === skill.realPath) {
        if (mode === 'symlink') {
          actions.push({
            id: actionId,
            agentId: agent.id,
            agentName: agent.name,
            scope,
            skillName: skill.name,
            sourcePath: skill.realPath,
            targetPath,
            mode,
            type: 'noop',
            reason: 'Already symlinked to canonical store',
            canonicalHash: skill.hash,
            targetHash: skill.hash,
            lastSyncedHash,
          });
          summary.noop += 1;
        } else {
          actions.push({
            id: actionId,
            agentId: agent.id,
            agentName: agent.name,
            scope,
            skillName: skill.name,
            sourcePath: skill.realPath,
            targetPath,
            mode,
            type: 'update',
            reason: 'Convert symlink to copy mode',
            canonicalHash: skill.hash,
            targetHash: skill.hash,
            lastSyncedHash,
          });
          summary.update += 1;
        }
        continue;
      }

      // Compute current target bundle hash
      const targetHash =
        targetRealPath && fs.statSync(targetRealPath).isDirectory()
          ? hashSkillBundle(targetRealPath).hash
          : undefined;

      if (targetHash === skill.hash) {
        if (mode === 'copy' && !targetIsSymlink) {
          actions.push({
            id: actionId,
            agentId: agent.id,
            agentName: agent.name,
            scope,
            skillName: skill.name,
            sourcePath: skill.realPath,
            targetPath,
            mode,
            type: 'noop',
            reason: 'Copy already matches canonical store',
            canonicalHash: skill.hash,
            targetHash,
            lastSyncedHash,
          });
          summary.noop += 1;
        } else {
          actions.push({
            id: actionId,
            agentId: agent.id,
            agentName: agent.name,
            scope,
            skillName: skill.name,
            sourcePath: skill.realPath,
            targetPath,
            mode,
            type: 'update',
            reason:
              mode === 'symlink'
                ? 'Replace identical copy with symlink to canonical store'
                : 'Replace external symlink with managed copy',
            canonicalHash: skill.hash,
            targetHash,
            lastSyncedHash,
          });
          summary.update += 1;
        }
        continue;
      }

      // Hashes differ — perform 3-way check using state.json baseline
      if (lastSyncedHash && targetHash === lastSyncedHash) {
        actions.push({
          id: actionId,
          agentId: agent.id,
          agentName: agent.name,
          scope,
          skillName: skill.name,
          sourcePath: skill.realPath,
          targetPath,
          mode,
          type: 'update',
          reason: 'Canonical skill updated since last sync',
          canonicalHash: skill.hash,
          targetHash,
          lastSyncedHash,
        });
        summary.update += 1;
      } else if (lastSyncedHash && skill.hash === lastSyncedHash) {
        actions.push({
          id: actionId,
          agentId: agent.id,
          agentName: agent.name,
          scope,
          skillName: skill.name,
          sourcePath: skill.realPath,
          targetPath,
          mode,
          type: 'pull-upstream',
          reason: `Modified directly in ${agent.name} since last sync`,
          canonicalHash: skill.hash,
          targetHash,
          lastSyncedHash,
        });
        summary['pull-upstream'] += 1;
      } else {
        actions.push({
          id: actionId,
          agentId: agent.id,
          agentName: agent.name,
          scope,
          skillName: skill.name,
          sourcePath: skill.realPath,
          targetPath,
          mode,
          type: 'conflict',
          reason: lastSyncedHash
            ? `Both canonical store and ${agent.name} changed since last sync`
            : `Existing directory in ${agent.name} differs from canonical store`,
          canonicalHash: skill.hash,
          targetHash,
          lastSyncedHash,
        });
        summary.conflict += 1;
      }
    }

    // Track skills previously synced to this agent that are no longer matched/present in canonical
    if (options.includePrune) {
      for (const prevSkillName of Object.keys(agentState)) {
        if (plannedNames.has(prevSkillName)) {
          continue;
        }
        const targetPath = path.join(agent.skillsDir, prevSkillName);
        if (fs.existsSync(targetPath) || isSymlink(targetPath)) {
          actions.push({
            id: `${agent.id}:${prevSkillName}`,
            agentId: agent.id,
            agentName: agent.name,
            scope,
            skillName: prevSkillName,
            sourcePath: '',
            targetPath,
            mode,
            type: 'remove',
            reason: 'Skill removed from canonical store or excluded by agent profile',
            lastSyncedHash: agentState[prevSkillName]?.syncedHash,
          });
          summary.remove += 1;
        }
      }
    }
  }

  return {
    scope,
    storeDir,
    actions,
    summary,
  };
}

export interface ApplySyncOptions {
  dryRun?: boolean;
  conflictStrategy?: ConflictResolution;
  perActionResolution?: Record<string, ConflictResolution>;
  pullUpstream?: boolean;
  prune?: boolean;
  state?: SkillSyncState;
}

function writeTarget(action: SyncAction): void {
  fs.mkdirSync(path.dirname(action.targetPath), { recursive: true });

  if (action.mode === 'symlink') {
    if (fs.existsSync(action.targetPath) || isSymlink(action.targetPath)) {
      fs.rmSync(action.targetPath, { recursive: true, force: true });
    }
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    fs.symlinkSync(action.sourcePath, action.targetPath, linkType);
  } else {
    copyBundleAtomic(action.sourcePath, action.targetPath);
  }
}

export function applySync(
  plan: SyncPlan,
  options: ApplySyncOptions = {},
): SyncApplyResult {
  const {
    dryRun = false,
    conflictStrategy = 'skip',
    perActionResolution = {},
    pullUpstream = true,
    prune = false,
  } = options;

  const state = options.state ?? loadState(plan.storeDir);
  const result: SyncApplyResult = {
    applied: [],
    skipped: [],
    pulled: [],
    conflictsRemaining: [],
    backupsCreated: [],
    errors: [],
  };

  if (!dryRun) {
    ensureStore(plan.storeDir);
  }

  const nowIso = new Date().toISOString();

  function recordState(agentId: string, skillName: string, hash: string, mode: SyncMode): void {
    state.agents[agentId] ??= {};
    state.agents[agentId][skillName] = {
      syncedHash: hash,
      syncedAt: nowIso,
      mode,
    };
  }

  for (const action of plan.actions) {
    try {
      if (action.type === 'noop') {
        if (!dryRun && action.canonicalHash) {
          recordState(action.agentId, action.skillName, action.canonicalHash, action.mode);
        }
        continue;
      }

      if (action.type === 'skip') {
        result.skipped.push(action);
        continue;
      }

      if (action.type === 'remove') {
        if (!prune) {
          result.skipped.push(action);
          continue;
        }
        if (!dryRun) {
          const bk = backupPath(
            plan.storeDir,
            `prune-${action.agentId}-${action.skillName}`,
            action.targetPath,
          );
          if (bk) {
            result.backupsCreated.push(bk);
          }
          fs.rmSync(action.targetPath, { recursive: true, force: true });
          delete state.agents[action.agentId]?.[action.skillName];
        }
        result.applied.push(action);
        continue;
      }

      if (action.type === 'pull-upstream') {
        const chosen = perActionResolution[action.id];
        const shouldPull = chosen ? chosen === 'agent' : pullUpstream;

        if (chosen === 'skip') {
          result.skipped.push(action);
          continue;
        }

        if (shouldPull) {
          if (!dryRun) {
            const bk = backupPath(
              plan.storeDir,
              `canonical-${action.skillName}`,
              action.sourcePath,
            );
            if (bk) {
              result.backupsCreated.push(bk);
            }
            const realTarget = fs.realpathSync(action.targetPath);
            copyBundleAtomic(realTarget, action.sourcePath);
            const newHash = hashSkillBundle(action.sourcePath).hash;
            if (action.mode === 'symlink') {
              writeTarget(action);
            }
            recordState(action.agentId, action.skillName, newHash, action.mode);
          }
          result.pulled.push(action);
        } else {
          // Overwrite agent with canonical
          if (!dryRun) {
            const bk = backupPath(
              plan.storeDir,
              `${action.agentId}-${action.skillName}`,
              action.targetPath,
            );
            if (bk) {
              result.backupsCreated.push(bk);
            }
            writeTarget(action);
            if (action.canonicalHash) {
              recordState(action.agentId, action.skillName, action.canonicalHash, action.mode);
            }
          }
          result.applied.push(action);
        }
        continue;
      }

      if (action.type === 'conflict') {
        const resolution = perActionResolution[action.id] ?? conflictStrategy;
        if (resolution === 'skip') {
          result.conflictsRemaining.push(action);
          result.skipped.push(action);
          continue;
        }
        if (resolution === 'agent') {
          if (!dryRun) {
            const bk = backupPath(
              plan.storeDir,
              `canonical-${action.skillName}`,
              action.sourcePath,
            );
            if (bk) {
              result.backupsCreated.push(bk);
            }
            const realTarget = fs.realpathSync(action.targetPath);
            copyBundleAtomic(realTarget, action.sourcePath);
            const newHash = hashSkillBundle(action.sourcePath).hash;
            if (action.mode === 'symlink') {
              writeTarget(action);
            }
            recordState(action.agentId, action.skillName, newHash, action.mode);
          }
          result.pulled.push(action);
          continue;
        }
        // resolution === 'canonical'
        if (!dryRun) {
          const bk = backupPath(
            plan.storeDir,
            `${action.agentId}-${action.skillName}`,
            action.targetPath,
          );
          if (bk) {
            result.backupsCreated.push(bk);
          }
          writeTarget(action);
          if (action.canonicalHash) {
            recordState(action.agentId, action.skillName, action.canonicalHash, action.mode);
          }
        }
        result.applied.push(action);
        continue;
      }

      // create or update
      if (!dryRun) {
        if (
          action.type === 'update' &&
          fs.existsSync(action.targetPath) &&
          !isSymlink(action.targetPath) &&
          action.targetHash !== action.canonicalHash
        ) {
          const bk = backupPath(
            plan.storeDir,
            `${action.agentId}-${action.skillName}`,
            action.targetPath,
          );
          if (bk) {
            result.backupsCreated.push(bk);
          }
        }
        writeTarget(action);
        if (action.canonicalHash) {
          recordState(action.agentId, action.skillName, action.canonicalHash, action.mode);
        }
      }
      result.applied.push(action);
    } catch (err) {
      result.errors.push({
        action,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (!dryRun) {
    saveState(plan.storeDir, state);
  }

  return result;
}

export interface RulesBridgeResult {
  sourcePath: string;
  syncedTargets: string[];
  skipped: boolean;
  reason?: string;
}

/**
 * Keeps a single source rules file (e.g. AGENTS.md) mirrored to target files (e.g. CLAUDE.md).
 */
export function syncRulesBridge(options: {
  cwd?: string;
  source?: string;
  targets?: string[];
  mode?: SyncMode;
  dryRun?: boolean;
}): RulesBridgeResult {
  const cwd = options.cwd ?? process.cwd();
  const source = options.source ?? 'AGENTS.md';
  const targets = options.targets ?? ['CLAUDE.md'];
  const mode = options.mode ?? 'copy';
  const dryRun = options.dryRun ?? false;

  const sourcePath = path.resolve(cwd, source);
  if (!fs.existsSync(sourcePath)) {
    return {
      sourcePath,
      syncedTargets: [],
      skipped: true,
      reason: `Source rules file not found: ${source}`,
    };
  }

  const sourceContent = fs.readFileSync(sourcePath, 'utf8');
  const syncedTargets: string[] = [];

  for (const relTarget of targets) {
    const targetPath = path.resolve(cwd, relTarget);
    if (targetPath === sourcePath) {
      continue;
    }

    if (mode === 'symlink') {
      const alreadyLinked =
        isSymlink(targetPath) &&
        fs.existsSync(targetPath) &&
        fs.realpathSync(targetPath) === fs.realpathSync(sourcePath);
      if (alreadyLinked) {
        continue;
      }
      if (!dryRun) {
        if (fs.existsSync(targetPath) || isSymlink(targetPath)) {
          fs.rmSync(targetPath, { force: true });
        }
        fs.symlinkSync(source, targetPath);
      }
      syncedTargets.push(relTarget);
    } else {
      const existing = fs.existsSync(targetPath)
        ? fs.readFileSync(targetPath, 'utf8')
        : null;
      if (existing === sourceContent) {
        continue;
      }
      if (!dryRun) {
        fs.writeFileSync(targetPath, sourceContent, 'utf8');
      }
      syncedTargets.push(relTarget);
    }
  }

  return {
    sourcePath,
    syncedTargets,
    skipped: false,
  };
}
