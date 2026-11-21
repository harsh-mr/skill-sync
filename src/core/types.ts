export type SyncMode = 'symlink' | 'copy';

export type Scope = 'global' | 'project' | 'all';

export type BuiltinAgentId =
  | 'claude-code'
  | 'cursor'
  | 'codex'
  | 'antigravity'
  | 'gemini-cli'
  | 'copilot'
  | 'windsurf'
  | 'opencode'
  | 'cline'
  | 'roo-code';

export type AgentId = BuiltinAgentId | (string & {});

export interface AgentDefinition {
  id: AgentId;
  name: string;
  globalSkillsDir: string;
  projectSkillsDir: string;
  detectGlobalDirs: string[];
  detectProjectDirs: string[];
  rulesFile?: string;
}

export interface CustomAgentDefinition {
  name: string;
  globalSkillsDir?: string;
  projectSkillsDir?: string;
  rulesFile?: string;
}

export interface ResolvedAgent {
  id: AgentId;
  name: string;
  scope: 'global' | 'project';
  skillsDir: string;
  exists: boolean;
  detected: boolean;
  rulesPath?: string;
  isCustom: boolean;
}

export interface ParseDiagnostic {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  line?: number;
  column?: number;
  file?: string;
}

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  tags: string[];
  license?: string;
  allowedTools?: string | string[];
  raw: Record<string, unknown>;
}

export interface SkillParseResult {
  valid: boolean;
  frontmatter: SkillFrontmatter | null;
  body: string;
  errors: ParseDiagnostic[];
  warnings: ParseDiagnostic[];
  frontmatterTokens: number;
  totalTokens: number;
  referencedPaths: string[];
}

export interface DiscoveredSkillInstance {
  skillName: string;
  agentId: AgentId | 'canonical';
  agentName: string;
  scope: 'global' | 'project';
  path: string;
  realPath: string | null;
  isSymlink: boolean;
  isBrokenSymlink: boolean;
  symlinkTarget: string | null;
  hasSkillMd: boolean;
  hash: string | null;
  files: string[];
  mtimeMs: number;
  parse: SkillParseResult | null;
}

export type SkillClassification =
  | 'synced'
  | 'unique'
  | 'identical-scattered'
  | 'diverged'
  | 'broken'
  | 'canonical-only';

export interface ScannedSkillGroup {
  skillName: string;
  classification: SkillClassification;
  canonical: DiscoveredSkillInstance | null;
  instances: DiscoveredSkillInstance[];
  distinctHashes: string[];
  frontmatterTokens: number;
  tags: string[];
  description?: string;
}

export interface AgentTokenBudget {
  agentId: AgentId;
  agentName: string;
  scope: 'global' | 'project';
  skillCount: number;
  frontmatterTokens: number;
  exceedsBudget: boolean;
}

export interface ScanSummary {
  totalSkills: number;
  synced: number;
  unique: number;
  identicalScattered: number;
  diverged: number;
  broken: number;
  canonicalOnly: number;
  detectedAgents: number;
}

export interface ScanReport {
  scannedAt: string;
  scope: Scope;
  storeDir: string;
  agents: ResolvedAgent[];
  skills: ScannedSkillGroup[];
  summary: ScanSummary;
  tokenBudgets: AgentTokenBudget[];
}

export interface AgentConfig {
  enabled: boolean;
  mode?: SyncMode;
  profiles?: string[];
  include?: string[];
  exclude?: string[];
  globalSkillsDir?: string;
  projectSkillsDir?: string;
}

export interface RulesBridgeConfig {
  enabled: boolean;
  source: string;
  targets: string[];
}

export interface SkillSyncConfig {
  version: 1;
  defaultMode: SyncMode;
  tokenBudgetWarning: number;
  agents: Record<string, AgentConfig>;
  customAgents?: Record<string, CustomAgentDefinition>;
  rulesBridge?: RulesBridgeConfig;
}

export interface SyncedSkillRecord {
  syncedHash: string;
  syncedAt: string;
  mode: SyncMode;
}

export interface SkillSyncState {
  version: 1;
  agents: Record<string, Record<string, SyncedSkillRecord>>;
}

export type SyncActionType =
  | 'create'
  | 'update'
  | 'pull-upstream'
  | 'conflict'
  | 'remove'
  | 'noop'
  | 'skip';

export interface SyncAction {
  id: string;
  agentId: AgentId;
  agentName: string;
  scope: 'global' | 'project';
  skillName: string;
  sourcePath: string;
  targetPath: string;
  mode: SyncMode;
  type: SyncActionType;
  reason: string;
  canonicalHash?: string;
  targetHash?: string;
  lastSyncedHash?: string;
}

export interface SyncPlan {
  scope: 'global' | 'project';
  storeDir: string;
  actions: SyncAction[];
  summary: Record<SyncActionType, number>;
}

export type ConflictResolution = 'skip' | 'canonical' | 'agent';

export interface SyncApplyResult {
  applied: SyncAction[];
  skipped: SyncAction[];
  pulled: SyncAction[];
  conflictsRemaining: SyncAction[];
  backupsCreated: string[];
  errors: Array<{ action: SyncAction; error: string }>;
}

export interface DoctorIssue {
  code: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  skillName?: string;
  agentId?: AgentId | 'canonical';
  path?: string;
  line?: number;
  column?: number;
  fixable?: boolean;
  hint?: string;
}

export interface DoctorReport {
  checkedAt: string;
  scope: Scope;
  storeDir: string;
  issues: DoctorIssue[];
  tokenBudgets: AgentTokenBudget[];
  summary: {
    errors: number;
    warnings: number;
    info: number;
    skillsChecked: number;
  };
}

export interface RuntimePaths {
  homeDir: string;
  cwd: string;
  storeDir?: string;
}
