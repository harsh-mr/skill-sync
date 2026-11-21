import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  AgentDefinition,
  ResolvedAgent,
  Scope,
  SkillSyncConfig,
} from './types.js';

export const BUILTIN_AGENTS: readonly AgentDefinition[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    globalSkillsDir: '~/.claude/skills',
    projectSkillsDir: '.claude/skills',
    detectGlobalDirs: ['~/.claude'],
    detectProjectDirs: ['.claude', 'CLAUDE.md'],
    rulesFile: 'CLAUDE.md',
  },
  {
    id: 'cursor',
    name: 'Cursor',
    globalSkillsDir: '~/.cursor/skills',
    projectSkillsDir: '.cursor/skills',
    detectGlobalDirs: ['~/.cursor'],
    detectProjectDirs: ['.cursor'],
    rulesFile: 'AGENTS.md',
  },
  {
    id: 'codex',
    name: 'OpenAI Codex CLI',
    globalSkillsDir: '~/.codex/skills',
    projectSkillsDir: '.agents/skills',
    detectGlobalDirs: ['~/.codex'],
    detectProjectDirs: ['.agents'],
    rulesFile: 'AGENTS.md',
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    globalSkillsDir: '~/.gemini/antigravity/skills',
    projectSkillsDir: '.agent/skills',
    detectGlobalDirs: ['~/.gemini/antigravity'],
    detectProjectDirs: ['.agent'],
    rulesFile: 'AGENTS.md',
  },
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    globalSkillsDir: '~/.gemini/skills',
    projectSkillsDir: '.gemini/skills',
    detectGlobalDirs: ['~/.gemini'],
    detectProjectDirs: ['.gemini', 'GEMINI.md'],
    rulesFile: 'GEMINI.md',
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    globalSkillsDir: '~/.copilot/skills',
    projectSkillsDir: '.github/skills',
    detectGlobalDirs: ['~/.copilot'],
    detectProjectDirs: ['.github/skills', '.github/copilot-instructions.md'],
    rulesFile: 'AGENTS.md',
  },
  {
    id: 'windsurf',
    name: 'Windsurf',
    globalSkillsDir: '~/.codeium/windsurf/skills',
    projectSkillsDir: '.windsurf/skills',
    detectGlobalDirs: ['~/.codeium/windsurf'],
    detectProjectDirs: ['.windsurf'],
    rulesFile: 'AGENTS.md',
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    globalSkillsDir: '~/.config/opencode/skills',
    projectSkillsDir: '.opencode/skills',
    detectGlobalDirs: ['~/.config/opencode'],
    detectProjectDirs: ['.opencode'],
    rulesFile: 'AGENTS.md',
  },
  {
    id: 'cline',
    name: 'Cline',
    globalSkillsDir: '~/.cline/skills',
    projectSkillsDir: '.cline/skills',
    detectGlobalDirs: ['~/.cline'],
    detectProjectDirs: ['.cline', '.clinerules'],
    rulesFile: '.clinerules',
  },
  {
    id: 'roo-code',
    name: 'Roo Code',
    globalSkillsDir: '~/.roo/skills',
    projectSkillsDir: '.roo/skills',
    detectGlobalDirs: ['~/.roo'],
    detectProjectDirs: ['.roo', '.roorules'],
    rulesFile: '.roorules',
  },
] as const;

export function expandPath(inputPath: string, homeDir = os.homedir()): string {
  if (inputPath === '~') {
    return homeDir;
  }
  if (inputPath.startsWith('~/') || inputPath.startsWith('~\\')) {
    return path.join(homeDir, inputPath.slice(2));
  }
  return inputPath;
}

export function pathExists(targetPath: string): boolean {
  try {
    fs.accessSync(targetPath);
    return true;
  } catch {
    return false;
  }
}

export interface ResolveAgentsOptions {
  homeDir?: string;
  cwd?: string;
  scope?: Scope;
  config?: SkillSyncConfig | null;
  agentIds?: string[];
}

export function resolveAgents(options: ResolveAgentsOptions = {}): ResolvedAgent[] {
  const homeDir = options.homeDir ?? os.homedir();
  const cwd = options.cwd ?? process.cwd();
  const scope = options.scope ?? 'global';
  const config = options.config ?? null;
  const filterSet = options.agentIds?.length ? new Set(options.agentIds) : null;

  const scopes: Array<'global' | 'project'> =
    scope === 'all' ? ['global', 'project'] : [scope];

  const resolved: ResolvedAgent[] = [];

  for (const agentScope of scopes) {
    for (const def of BUILTIN_AGENTS) {
      if (filterSet && !filterSet.has(def.id)) {
        continue;
      }

      const override = config?.agents?.[def.id];
      const rawSkillsDir =
        agentScope === 'global'
          ? override?.globalSkillsDir ?? def.globalSkillsDir
          : override?.projectSkillsDir ?? def.projectSkillsDir;

      const skillsDir =
        agentScope === 'global'
          ? expandPath(rawSkillsDir, homeDir)
          : path.resolve(cwd, rawSkillsDir);

      const exists = pathExists(skillsDir);
      const detectPaths =
        agentScope === 'global'
          ? def.detectGlobalDirs.map((d) => expandPath(d, homeDir))
          : def.detectProjectDirs.map((d) => path.resolve(cwd, d));

      const detected = exists || detectPaths.some((p) => pathExists(p));
      const rulesPath =
        agentScope === 'project' && def.rulesFile
          ? path.resolve(cwd, def.rulesFile)
          : undefined;

      resolved.push({
        id: def.id,
        name: def.name,
        scope: agentScope,
        skillsDir,
        exists,
        detected,
        rulesPath,
        isCustom: false,
      });
    }

    if (config?.customAgents) {
      for (const [id, custom] of Object.entries(config.customAgents)) {
        if (filterSet && !filterSet.has(id)) {
          continue;
        }
        const rawDir =
          agentScope === 'global' ? custom.globalSkillsDir : custom.projectSkillsDir;
        if (!rawDir) {
          continue;
        }
        const skillsDir =
          agentScope === 'global'
            ? expandPath(rawDir, homeDir)
            : path.resolve(cwd, rawDir);
        const exists = pathExists(skillsDir);
        const rulesPath =
          agentScope === 'project' && custom.rulesFile
            ? path.resolve(cwd, custom.rulesFile)
            : undefined;

        resolved.push({
          id,
          name: custom.name,
          scope: agentScope,
          skillsDir,
          exists,
          detected: exists || Boolean(config.agents?.[id]?.enabled),
          rulesPath,
          isCustom: true,
        });
      }
    }
  }

  return resolved;
}

export function getAgentDisplayName(
  agentId: string,
  config?: SkillSyncConfig | null,
): string {
  if (agentId === 'canonical') {
    return 'Canonical Store';
  }
  const builtin = BUILTIN_AGENTS.find((a) => a.id === agentId);
  if (builtin) {
    return builtin.name;
  }
  return config?.customAgents?.[agentId]?.name ?? agentId;
}
