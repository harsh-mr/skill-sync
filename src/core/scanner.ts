import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { resolveAgents } from './agents.js';
import { hashSkillBundle, IGNORED_BUNDLE_ENTRIES } from './hash.js';
import { parseSkillFile } from './parser.js';
import {
  DEFAULT_TOKEN_BUDGET_WARNING,
  getStoreLayout,
  loadConfig,
  resolveStoreDir,
} from './store.js';
import type {
  AgentTokenBudget,
  DiscoveredSkillInstance,
  ScannedSkillGroup,
  ScanReport,
  Scope,
  SkillClassification,
  SkillSyncConfig,
} from './types.js';

export interface ScanOptions {
  homeDir?: string;
  cwd?: string;
  storeDir?: string;
  scope?: Scope;
  config?: SkillSyncConfig | null;
  agentIds?: string[];
}

export function inspectSkillDirectory(params: {
  skillName: string;
  skillPath: string;
  agentId: string;
  agentName: string;
  scope: 'global' | 'project';
}): DiscoveredSkillInstance {
  const { skillName, skillPath, agentId, agentName, scope } = params;
  const lstat = fs.lstatSync(skillPath);
  const isSym = lstat.isSymbolicLink();
  let symlinkTarget: string | null = null;
  let realPath: string | null = null;
  let isBrokenSymlink = false;

  if (isSym) {
    symlinkTarget = fs.readlinkSync(skillPath);
    try {
      realPath = fs.realpathSync(skillPath);
    } catch {
      isBrokenSymlink = true;
    }
  } else {
    realPath = fs.realpathSync(skillPath);
  }

  if (isBrokenSymlink || !realPath) {
    return {
      skillName,
      agentId,
      agentName,
      scope,
      path: skillPath,
      realPath: null,
      isSymlink: isSym,
      isBrokenSymlink: true,
      symlinkTarget,
      hasSkillMd: false,
      hash: null,
      files: [],
      mtimeMs: lstat.mtimeMs,
      parse: null,
    };
  }

  const realStat = fs.statSync(realPath);
  if (!realStat.isDirectory()) {
    return {
      skillName,
      agentId,
      agentName,
      scope,
      path: skillPath,
      realPath,
      isSymlink: isSym,
      isBrokenSymlink: false,
      symlinkTarget,
      hasSkillMd: false,
      hash: null,
      files: [],
      mtimeMs: realStat.mtimeMs,
      parse: null,
    };
  }

  const skillMdPath = path.join(realPath, 'SKILL.md');
  const hasSkillMd = fs.existsSync(skillMdPath);
  const bundleHash = hashSkillBundle(realPath);
  const parse = hasSkillMd ? parseSkillFile(realPath, skillName) : null;

  return {
    skillName,
    agentId,
    agentName,
    scope,
    path: skillPath,
    realPath,
    isSymlink: isSym,
    isBrokenSymlink: false,
    symlinkTarget,
    hasSkillMd,
    hash: bundleHash.hash,
    files: bundleHash.files,
    mtimeMs: bundleHash.latestMtimeMs,
    parse,
  };
}

function scanDirectoryForSkills(params: {
  dirPath: string;
  agentId: string;
  agentName: string;
  scope: 'global' | 'project';
}): DiscoveredSkillInstance[] {
  const { dirPath, agentId, agentName, scope } = params;
  if (!fs.existsSync(dirPath)) {
    return [];
  }

  const results: DiscoveredSkillInstance[] = [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    if (IGNORED_BUNDLE_ENTRIES.has(entry.name) || entry.name.startsWith('.')) {
      continue;
    }
    const entryPath = path.join(dirPath, entry.name);
    let lstat: fs.Stats;
    try {
      lstat = fs.lstatSync(entryPath);
    } catch {
      continue;
    }

    if (!lstat.isDirectory() && !lstat.isSymbolicLink()) {
      continue;
    }

    // If symlink points to a regular file (not dir), skip unless broken.
    if (lstat.isSymbolicLink()) {
      try {
        if (!fs.statSync(entryPath).isDirectory()) {
          continue;
        }
      } catch {
        // Broken symlink: include it so scan & doctor flag it!
      }
    }

    results.push(
      inspectSkillDirectory({
        skillName: entry.name,
        skillPath: entryPath,
        agentId,
        agentName,
        scope,
      }),
    );
  }

  return results;
}

function classifyGroup(
  canonical: DiscoveredSkillInstance | null,
  instances: DiscoveredSkillInstance[],
): { classification: SkillClassification; distinctHashes: string[] } {
  const all = canonical ? [canonical, ...instances] : [...instances];

  const hasBroken = all.some(
    (inst) =>
      inst.isBrokenSymlink ||
      !inst.hasSkillMd ||
      (inst.parse !== null && !inst.parse.valid),
  );

  const hashSet = new Set<string>();
  for (const inst of all) {
    if (inst.hash) {
      hashSet.add(inst.hash);
    }
  }
  const distinctHashes = [...hashSet];

  if (hasBroken) {
    return { classification: 'broken', distinctHashes };
  }

  if (canonical && instances.length === 0) {
    return { classification: 'canonical-only', distinctHashes };
  }

  if (distinctHashes.length > 1) {
    return { classification: 'diverged', distinctHashes };
  }

  if (canonical) {
    return { classification: 'synced', distinctHashes };
  }

  if (instances.length === 1) {
    return { classification: 'unique', distinctHashes };
  }

  return { classification: 'identical-scattered', distinctHashes };
}

export function scanSkills(options: ScanOptions = {}): ScanReport {
  const homeDir = options.homeDir ?? os.homedir();
  const cwd = options.cwd ?? process.cwd();
  const scope = options.scope ?? 'global';
  const storeScope: 'global' | 'project' = scope === 'project' ? 'project' : 'global';
  const storeDir = resolveStoreDir({
    homeDir,
    cwd,
    scope: storeScope,
    storeDir: options.storeDir,
  });
  const config = options.config ?? loadConfig(storeDir);
  const tokenBudgetWarning =
    config?.tokenBudgetWarning ?? DEFAULT_TOKEN_BUDGET_WARNING;

  const agents = resolveAgents({
    homeDir,
    cwd,
    scope,
    config,
    agentIds: options.agentIds,
  });

  const storeLayout = getStoreLayout(storeDir);
  const canonicalInstances = scanDirectoryForSkills({
    dirPath: storeLayout.skillsDir,
    agentId: 'canonical',
    agentName: 'Canonical Store',
    scope: storeScope,
  });

  const canonicalMap = new Map<string, DiscoveredSkillInstance>();
  for (const inst of canonicalInstances) {
    canonicalMap.set(inst.skillName, inst);
  }

  const groupMap = new Map<string, DiscoveredSkillInstance[]>();
  for (const name of canonicalMap.keys()) {
    groupMap.set(name, []);
  }

  const tokenBudgets: AgentTokenBudget[] = [];

  for (const agent of agents) {
    const discovered = agent.exists
      ? scanDirectoryForSkills({
          dirPath: agent.skillsDir,
          agentId: agent.id,
          agentName: agent.name,
          scope: agent.scope,
        })
      : [];

    let agentFrontmatterTokens = 0;
    for (const inst of discovered) {
      const list = groupMap.get(inst.skillName) ?? [];
      list.push(inst);
      groupMap.set(inst.skillName, list);
      if (inst.parse) {
        agentFrontmatterTokens += inst.parse.frontmatterTokens;
      }
    }

    if (agent.detected || discovered.length > 0) {
      tokenBudgets.push({
        agentId: agent.id,
        agentName: agent.name,
        scope: agent.scope,
        skillCount: discovered.length,
        frontmatterTokens: agentFrontmatterTokens,
        exceedsBudget: agentFrontmatterTokens > tokenBudgetWarning,
      });
    }
  }

  const skills: ScannedSkillGroup[] = [];
  const summary = {
    totalSkills: 0,
    synced: 0,
    unique: 0,
    identicalScattered: 0,
    diverged: 0,
    broken: 0,
    canonicalOnly: 0,
    detectedAgents: agents.filter((a) => a.detected).length,
  };

  const sortedNames = [...groupMap.keys()].sort((a, b) => a.localeCompare(b));

  for (const skillName of sortedNames) {
    const canonical = canonicalMap.get(skillName) ?? null;
    const instances = groupMap.get(skillName) ?? [];
    const { classification, distinctHashes } = classifyGroup(canonical, instances);

    const sampleParse =
      canonical?.parse ?? instances.find((i) => i.parse)?.parse ?? null;

    skills.push({
      skillName,
      classification,
      canonical,
      instances,
      distinctHashes,
      frontmatterTokens: sampleParse?.frontmatterTokens ?? 0,
      tags: sampleParse?.frontmatter?.tags ?? [],
      description: sampleParse?.frontmatter?.description,
    });

    summary.totalSkills += 1;
    switch (classification) {
      case 'synced':
        summary.synced += 1;
        break;
      case 'unique':
        summary.unique += 1;
        break;
      case 'identical-scattered':
        summary.identicalScattered += 1;
        break;
      case 'diverged':
        summary.diverged += 1;
        break;
      case 'broken':
        summary.broken += 1;
        break;
      case 'canonical-only':
        summary.canonicalOnly += 1;
        break;
    }
  }

  return {
    scannedAt: new Date().toISOString(),
    scope,
    storeDir,
    agents,
    skills,
    summary,
    tokenBudgets,
  };
}

export interface SkillDiffResult {
  skillMdPatch: string;
  onlyInLeft: string[];
  onlyInRight: string[];
  changedFiles: string[];
}

export function diffSkillBundles(
  leftDir: string,
  rightDir: string,
  labels: { left: string; right: string } = { left: 'left', right: 'right' },
): SkillDiffResult {
  const leftHash = hashSkillBundle(leftDir);
  const rightHash = hashSkillBundle(rightDir);

  const leftSet = new Set(leftHash.files);
  const rightSet = new Set(rightHash.files);

  const onlyInLeft = leftHash.files.filter((f) => !rightSet.has(f));
  const onlyInRight = rightHash.files.filter((f) => !leftSet.has(f));
  const changedFiles: string[] = [];

  for (const rel of leftHash.files) {
    if (!rightSet.has(rel)) {
      continue;
    }
    const leftBuf = fs.readFileSync(path.join(leftDir, ...rel.split('/')));
    const rightBuf = fs.readFileSync(path.join(rightDir, ...rel.split('/')));
    if (!leftBuf.equals(rightBuf)) {
      changedFiles.push(rel);
    }
  }

  const leftMdPath = path.join(leftDir, 'SKILL.md');
  const rightMdPath = path.join(rightDir, 'SKILL.md');
  const leftMd = fs.existsSync(leftMdPath) ? fs.readFileSync(leftMdPath, 'utf8') : '';
  const rightMd = fs.existsSync(rightMdPath) ? fs.readFileSync(rightMdPath, 'utf8') : '';

  const skillMdPatch =
    leftMd === rightMd
      ? ''
      : createTwoFilesPatch(
          `${labels.left}/SKILL.md`,
          `${labels.right}/SKILL.md`,
          leftMd,
          rightMd,
          '',
          '',
          { context: 3 },
        );

  return {
    skillMdPatch,
    onlyInLeft,
    onlyInRight,
    changedFiles,
  };
}
