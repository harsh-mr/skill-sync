import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanSkills } from './scanner.js';
import { DEFAULT_TOKEN_BUDGET_WARNING, loadConfig } from './store.js';
import type {
  DiscoveredSkillInstance,
  DoctorIssue,
  DoctorReport,
  Scope,
  SkillSyncConfig,
} from './types.js';

export interface DoctorOptions {
  homeDir?: string;
  cwd?: string;
  storeDir?: string;
  scope?: Scope;
  config?: SkillSyncConfig | null;
  agentIds?: string[];
  fix?: boolean;
}

export interface DoctorResult {
  report: DoctorReport;
  fixed: string[];
}

function checkInstance(
  instance: DiscoveredSkillInstance,
  issues: DoctorIssue[],
  fixed: string[],
  applyFix: boolean,
): void {
  if (instance.isBrokenSymlink) {
    if (applyFix) {
      try {
        fs.rmSync(instance.path, { force: true });
        fixed.push(`Removed dangling symlink ${instance.path}`);
        return;
      } catch {
        // Fall through and report issue
      }
    }
    issues.push({
      code: 'BROKEN_SYMLINK',
      severity: 'error',
      message: `Broken symlink pointing to "${instance.symlinkTarget ?? 'unknown'}"`,
      skillName: instance.skillName,
      agentId: instance.agentId,
      path: instance.path,
      fixable: true,
      hint: 'Run "skill-sync doctor --fix" to remove dangling symlinks',
    });
    return;
  }

  if (!instance.hasSkillMd) {
    issues.push({
      code: 'MISSING_SKILL_MD',
      severity: 'error',
      message: `Directory "${instance.skillName}" is missing a SKILL.md entrypoint`,
      skillName: instance.skillName,
      agentId: instance.agentId,
      path: instance.path,
      hint: 'Add a SKILL.md with name/description frontmatter or remove the empty folder',
    });
    return;
  }

  if (!instance.parse) {
    return;
  }

  for (const err of instance.parse.errors) {
    issues.push({
      code: err.code,
      severity: 'error',
      message: err.message,
      skillName: instance.skillName,
      agentId: instance.agentId,
      path: err.file ?? path.join(instance.path, 'SKILL.md'),
      line: err.line,
      column: err.column,
      hint:
        err.code === 'INVALID_YAML'
          ? 'Wrap values containing ":" (e.g. description: "Use when: ...") in double quotes'
          : undefined,
    });
  }

  for (const warn of instance.parse.warnings) {
    issues.push({
      code: warn.code,
      severity: 'warning',
      message: warn.message,
      skillName: instance.skillName,
      agentId: instance.agentId,
      path: warn.file ?? path.join(instance.path, 'SKILL.md'),
      line: warn.line,
      column: warn.column,
    });
  }

  // Verify relative resource references inside SKILL.md resolve to files in the bundle
  if (instance.realPath) {
    for (const relRef of instance.parse.referencedPaths) {
      const resolvedRef = path.join(instance.realPath, ...relRef.split('/'));
      if (!fs.existsSync(resolvedRef)) {
        issues.push({
          code: 'MISSING_RESOURCE_REF',
          severity: 'warning',
          message: `SKILL.md references "${relRef}", but that file does not exist in the skill bundle`,
          skillName: instance.skillName,
          agentId: instance.agentId,
          path: path.join(instance.path, 'SKILL.md'),
          hint: `Create ${relRef} or remove the stale reference`,
        });
      }
    }
  }
}

export function runDoctor(options: DoctorOptions = {}): DoctorResult {
  const homeDir = options.homeDir ?? os.homedir();
  const cwd = options.cwd ?? process.cwd();
  const scope = options.scope ?? 'global';
  const applyFix = options.fix ?? false;

  const scan = scanSkills({
    homeDir,
    cwd,
    storeDir: options.storeDir,
    scope,
    config: options.config,
    agentIds: options.agentIds,
  });

  const config = options.config ?? loadConfig(scan.storeDir);
  const tokenBudgetWarning =
    config?.tokenBudgetWarning ?? DEFAULT_TOKEN_BUDGET_WARNING;

  const issues: DoctorIssue[] = [];
  const fixed: string[] = [];
  const checkedRealPaths = new Set<string>();

  for (const group of scan.skills) {
    if (group.canonical) {
      if (group.canonical.realPath) {
        checkedRealPaths.add(group.canonical.realPath);
      }
      checkInstance(group.canonical, issues, fixed, applyFix);
    }

    for (const inst of group.instances) {
      // Avoid duplicate parse reports when an agent symlink points directly to canonical
      if (
        !inst.isBrokenSymlink &&
        inst.isSymlink &&
        inst.realPath &&
        checkedRealPaths.has(inst.realPath)
      ) {
        continue;
      }
      checkInstance(inst, issues, fixed, applyFix);
    }

    if (group.classification === 'diverged') {
      const locs = [
        ...(group.canonical ? ['canonical'] : []),
        ...group.instances.map((i) => i.agentId),
      ].join(', ');
      issues.push({
        code: 'DIVERGED_SKILL',
        severity: 'warning',
        message: `Skill "${group.skillName}" has ${group.distinctHashes.length} different versions across: ${locs}`,
        skillName: group.skillName,
        hint: 'Run "skill-sync adopt" or "skill-sync sync" to reconcile copies',
      });
    } else if (
      group.classification === 'unique' ||
      group.classification === 'identical-scattered'
    ) {
      const locs = group.instances.map((i) => i.agentId).join(', ');
      issues.push({
        code: 'UNADOPTED_SKILL',
        severity: 'info',
        message: `Skill "${group.skillName}" exists in [${locs}] but is not yet in canonical store`,
        skillName: group.skillName,
        hint: 'Run "skill-sync adopt" to import it into your canonical store',
      });
    }
  }

  for (const budget of scan.tokenBudgets) {
    if (budget.frontmatterTokens > tokenBudgetWarning) {
      issues.push({
        code: 'TOKEN_BUDGET_EXCEEDED',
        severity: 'warning',
        message: `${budget.agentName} (${budget.scope}) loads ~${budget.frontmatterTokens} frontmatter tokens across ${budget.skillCount} skills (threshold: ${tokenBudgetWarning})`,
        agentId: budget.agentId,
        hint: 'Assign tags/profiles in config.json to trim unused skills for this agent',
      });
    }
  }

  // Project-level AGENTS.md <-> CLAUDE.md drift check
  if (scope === 'project' || scope === 'all') {
    const agentsMdPath = path.resolve(cwd, 'AGENTS.md');
    const claudeMdPath = path.resolve(cwd, 'CLAUDE.md');
    const hasAgentsMd = fs.existsSync(agentsMdPath);
    const hasClaudeMd = fs.existsSync(claudeMdPath);

    if (hasAgentsMd && hasClaudeMd) {
      const aContent = fs.readFileSync(agentsMdPath, 'utf8');
      const cContent = fs.readFileSync(claudeMdPath, 'utf8');
      if (aContent !== cContent) {
        issues.push({
          code: 'RULES_BRIDGE_DRIFT',
          severity: 'warning',
          message: 'AGENTS.md and CLAUDE.md have different contents in this project',
          path: claudeMdPath,
          hint: 'Run "skill-sync sync --project --bridge-rules" to mirror AGENTS.md -> CLAUDE.md',
        });
      }
    } else if (hasAgentsMd && !hasClaudeMd) {
      const claudeDetected = scan.agents.some(
        (a) => a.id === 'claude-code' && a.detected,
      );
      if (claudeDetected) {
        issues.push({
          code: 'RULES_BRIDGE_MISSING',
          severity: 'info',
          message: 'Project has AGENTS.md without a mirrored CLAUDE.md for Claude Code',
          path: agentsMdPath,
          hint: 'Run "skill-sync sync --project --bridge-rules" to mirror AGENTS.md -> CLAUDE.md',
        });
      }
    }
  }

  const summary = {
    errors: issues.filter((i) => i.severity === 'error').length,
    warnings: issues.filter((i) => i.severity === 'warning').length,
    info: issues.filter((i) => i.severity === 'info').length,
    skillsChecked: scan.summary.totalSkills,
  };

  return {
    report: {
      checkedAt: new Date().toISOString(),
      scope,
      storeDir: scan.storeDir,
      issues,
      tokenBudgets: scan.tokenBudgets,
      summary,
    },
    fixed,
  };
}
