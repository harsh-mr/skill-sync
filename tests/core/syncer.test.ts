import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { adoptSkills, getAdoptableGroups, pickNewestInstance } from '../../src/core/adopt.js';
import { scanSkills } from '../../src/core/scanner.js';
import { loadConfig, saveConfig } from '../../src/core/store.js';
import { applySync, planSync, syncRulesBridge } from '../../src/core/syncer.js';
import { createSandbox, type Sandbox } from '../helpers/sandbox.js';

describe('adopt + hybrid syncer', () => {
  let sandbox: Sandbox;

  afterEach(() => {
    sandbox?.cleanup();
  });

  it('adopts scattered skills and syncs across agents in symlink and copy modes with 3-way drift detection', () => {
    sandbox = createSandbox();

    const claudeSkills = path.join(sandbox.homeDir, '.claude', 'skills');
    const cursorSkills = path.join(sandbox.homeDir, '.cursor', 'skills');
    const codexSkills = path.join(sandbox.homeDir, '.codex', 'skills');

    sandbox.writeSkill(claudeSkills, 'react-patterns', {
      tags: ['frontend'],
      body: 'Use React 19 server actions.',
      extraFiles: { 'references/hooks.md': '# Hooks guide\n' },
    });
    fs.mkdirSync(cursorSkills, { recursive: true });
    fs.mkdirSync(codexSkills, { recursive: true });

    // Step 1: Scan & adopt
    const initialScan = scanSkills({
      homeDir: sandbox.homeDir,
      storeDir: sandbox.storeDir,
      scope: 'global',
    });
    const { autoAdoptable } = getAdoptableGroups(initialScan);
    expect(autoAdoptable).toHaveLength(1);

    const detectedIds = initialScan.agents.filter((a) => a.detected).map((a) => a.id);
    const adoptRes = adoptSkills({
      storeDir: sandbox.storeDir,
      enableDetectedAgents: detectedIds,
      selections: autoAdoptable.map((g) => ({
        skillName: g.skillName,
        sourceInstance: pickNewestInstance(g.instances)!,
      })),
    });
    expect(adoptRes.adopted).toHaveLength(1);

    // Configure Cursor to use copy mode and Codex to use symlink mode
    const cfg = loadConfig(sandbox.storeDir)!;
    cfg.agents['cursor'] = { enabled: true, mode: 'copy', profiles: ['frontend'] };
    cfg.agents['codex'] = { enabled: true, mode: 'symlink', profiles: ['*'] };
    cfg.agents['claude-code'] = { enabled: true, mode: 'symlink', profiles: ['*'] };
    saveConfig(sandbox.storeDir, cfg);

    // Step 2: Plan & apply sync
    const plan1 = planSync({
      homeDir: sandbox.homeDir,
      storeDir: sandbox.storeDir,
      scope: 'global',
    });
    const apply1 = applySync(plan1);
    expect(apply1.errors).toHaveLength(0);

    // Verify Cursor got a real copy (not symlink) with nested reference file
    const cursorSkillPath = path.join(cursorSkills, 'react-patterns');
    expect(fs.lstatSync(cursorSkillPath).isSymbolicLink()).toBe(false);
    expect(fs.existsSync(path.join(cursorSkillPath, 'references/hooks.md'))).toBe(true);

    // Verify Codex got a symlink pointing straight to canonical
    const codexSkillPath = path.join(codexSkills, 'react-patterns');
    expect(fs.lstatSync(codexSkillPath).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(codexSkillPath)).toBe(
      fs.realpathSync(path.join(sandbox.storeDir, 'skills', 'react-patterns')),
    );

    // Step 3: Edit Cursor's copy directly -> should plan pull-upstream!
    const cursorSkillMd = path.join(cursorSkillPath, 'SKILL.md');
    fs.appendFileSync(cursorSkillMd, '\n## Added inside Cursor\n', 'utf8');

    const plan2 = planSync({
      homeDir: sandbox.homeDir,
      storeDir: sandbox.storeDir,
      scope: 'global',
    });
    const cursorAction2 = plan2.actions.find((a) => a.agentId === 'cursor');
    expect(cursorAction2?.type).toBe('pull-upstream');

    const apply2 = applySync(plan2, { pullUpstream: true });
    expect(apply2.pulled).toHaveLength(1);
    expect(apply2.backupsCreated.length).toBeGreaterThan(0);

    // Canonical store (and therefore symlinked Claude/Codex) now contains the Cursor edit!
    const canonicalContent = fs.readFileSync(
      path.join(sandbox.storeDir, 'skills', 'react-patterns', 'SKILL.md'),
      'utf8',
    );
    expect(canonicalContent).toContain('## Added inside Cursor');

    // Step 4: Edit BOTH canonical and Cursor -> should detect conflict!
    fs.appendFileSync(
      path.join(sandbox.storeDir, 'skills', 'react-patterns', 'SKILL.md'),
      '\n## Canonical change\n',
      'utf8',
    );
    fs.appendFileSync(cursorSkillMd, '\n## Conflicting Cursor change\n', 'utf8');

    const plan3 = planSync({
      homeDir: sandbox.homeDir,
      storeDir: sandbox.storeDir,
      scope: 'global',
    });
    const cursorAction3 = plan3.actions.find((a) => a.agentId === 'cursor');
    expect(cursorAction3?.type).toBe('conflict');

    // Default conflict strategy skips safely
    const apply3 = applySync(plan3, { conflictStrategy: 'skip' });
    expect(apply3.conflictsRemaining).toHaveLength(1);

    // Forcing canonical overwrites Cursor and backs up Cursor's conflicting copy
    const apply4 = applySync(plan3, { conflictStrategy: 'canonical' });
    expect(apply4.applied).toHaveLength(1);
    expect(apply4.backupsCreated.length).toBeGreaterThan(0);
    expect(fs.readFileSync(cursorSkillMd, 'utf8')).toContain('## Canonical change');
  });

  it('filters skills by per-agent profile tags and syncs AGENTS.md -> CLAUDE.md bridge', () => {
    sandbox = createSandbox();
    const canonicalSkills = path.join(sandbox.storeDir, 'skills');

    sandbox.writeSkill(canonicalSkills, 'ui-kit', { tags: ['frontend'] });
    sandbox.writeSkill(canonicalSkills, 'k8s-ops', { tags: ['infra'] });

    const cursorSkills = path.join(sandbox.homeDir, '.cursor', 'skills');
    fs.mkdirSync(cursorSkills, { recursive: true });

    saveConfig(sandbox.storeDir, {
      version: 1,
      defaultMode: 'copy',
      tokenBudgetWarning: 4000,
      agents: {
        cursor: { enabled: true, mode: 'copy', profiles: ['frontend'] },
      },
    });

    const plan = planSync({
      homeDir: sandbox.homeDir,
      storeDir: sandbox.storeDir,
      scope: 'global',
    });
    applySync(plan);

    expect(fs.existsSync(path.join(cursorSkills, 'ui-kit'))).toBe(true);
    expect(fs.existsSync(path.join(cursorSkills, 'k8s-ops'))).toBe(false);

    // Rules bridge test in project workspace
    fs.writeFileSync(path.join(sandbox.cwd, 'AGENTS.md'), '# Team Rules\nAlways test.\n');
    const bridge = syncRulesBridge({ cwd: sandbox.cwd, mode: 'copy' });
    expect(bridge.syncedTargets).toEqual(['CLAUDE.md']);
    expect(fs.readFileSync(path.join(sandbox.cwd, 'CLAUDE.md'), 'utf8')).toBe(
      '# Team Rules\nAlways test.\n',
    );
  });
});
