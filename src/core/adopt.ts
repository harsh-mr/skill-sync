import fs from 'node:fs';
import path from 'node:path';
import {
  backupPath,
  copyBundleAtomic,
  ensureStore,
  getStoreLayout,
  loadConfig,
  saveConfig,
} from './store.js';
import type { DiscoveredSkillInstance, ScanReport, ScannedSkillGroup } from './types.js';

export interface AdoptSelection {
  skillName: string;
  sourceInstance: DiscoveredSkillInstance;
  targetSkillName?: string;
}

export interface AdoptResult {
  adopted: Array<{
    skillName: string;
    fromAgent: string;
    fromPath: string;
    canonicalPath: string;
    backupCreated: string | null;
  }>;
  skipped: Array<{
    skillName: string;
    reason: string;
  }>;
}

export function getAdoptableGroups(report: ScanReport): {
  autoAdoptable: ScannedSkillGroup[];
  needsChoice: ScannedSkillGroup[];
  broken: ScannedSkillGroup[];
} {
  const autoAdoptable: ScannedSkillGroup[] = [];
  const needsChoice: ScannedSkillGroup[] = [];
  const broken: ScannedSkillGroup[] = [];

  for (const group of report.skills) {
    if (group.classification === 'unique' || group.classification === 'identical-scattered') {
      autoAdoptable.push(group);
    } else if (group.classification === 'diverged') {
      needsChoice.push(group);
    } else if (group.classification === 'broken') {
      broken.push(group);
    }
  }

  return { autoAdoptable, needsChoice, broken };
}

export function pickNewestInstance(
  instances: DiscoveredSkillInstance[],
): DiscoveredSkillInstance | null {
  const valid = instances.filter((i) => !i.isBrokenSymlink && i.realPath && i.hasSkillMd);
  if (valid.length === 0) {
    return null;
  }
  return [...valid].sort((a, b) => b.mtimeMs - a.mtimeMs)[0] ?? null;
}

export function adoptSkills(params: {
  storeDir: string;
  selections: AdoptSelection[];
  enableDetectedAgents?: string[];
  dryRun?: boolean;
}): AdoptResult {
  const { storeDir, selections, enableDetectedAgents, dryRun = false } = params;
  const layout = getStoreLayout(storeDir);
  const result: AdoptResult = { adopted: [], skipped: [] };

  if (!dryRun) {
    ensureStore(storeDir, { detectedAgentIds: enableDetectedAgents });
    if (enableDetectedAgents?.length) {
      const config = loadConfig(storeDir);
      if (config) {
        for (const agentId of enableDetectedAgents) {
          const existing = config.agents[agentId];
          if (!existing) {
            config.agents[agentId] = {
              enabled: true,
              mode: config.defaultMode,
              profiles: ['*'],
            };
          } else {
            existing.enabled = true;
          }
        }
        saveConfig(storeDir, config);
      }
    }
  }

  for (const selection of selections) {
    const { sourceInstance } = selection;
    const finalName = selection.targetSkillName ?? selection.skillName;

    if (!sourceInstance.realPath || sourceInstance.isBrokenSymlink) {
      result.skipped.push({
        skillName: finalName,
        reason: `Source instance at ${sourceInstance.path} is broken or unreadable`,
      });
      continue;
    }

    const destPath = path.join(layout.skillsDir, finalName);

    // Avoid self-copy if already canonical.
    if (
      fs.existsSync(destPath) &&
      fs.realpathSync(destPath) === sourceInstance.realPath
    ) {
      result.skipped.push({
        skillName: finalName,
        reason: 'Already points to canonical store',
      });
      continue;
    }

    let backupCreated: string | null = null;
    if (!dryRun) {
      if (fs.existsSync(destPath)) {
        backupCreated = backupPath(storeDir, `canonical-${finalName}`, destPath);
      }
      copyBundleAtomic(sourceInstance.realPath, destPath);
    }

    result.adopted.push({
      skillName: finalName,
      fromAgent: sourceInstance.agentId,
      fromPath: sourceInstance.path,
      canonicalPath: destPath,
      backupCreated,
    });
  }

  return result;
}
