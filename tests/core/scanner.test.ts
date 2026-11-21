import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { diffSkillBundles, scanSkills } from '../../src/core/scanner.js';
import { createSandbox, type Sandbox } from '../helpers/sandbox.js';

describe('scanSkills', () => {
  let sandbox: Sandbox;

  afterEach(() => {
    sandbox?.cleanup();
  });

  it('discovers agents and classifies unique, scattered, diverged, synced, canonical-only, and broken skills', () => {
    sandbox = createSandbox();

    const claudeSkills = path.join(sandbox.homeDir, '.claude', 'skills');
    const cursorSkills = path.join(sandbox.homeDir, '.cursor', 'skills');
    const antigravitySkills = path.join(
      sandbox.homeDir,
      '.gemini',
      'antigravity',
      'skills',
    );
    const canonicalSkills = path.join(sandbox.storeDir, 'skills');

    // 1. Unique skill only in Claude Code
    sandbox.writeSkill(claudeSkills, 'claude-only', { tags: ['core'] });

    // 2. Identical scattered skill in Claude Code + Cursor (not yet in canonical)
    sandbox.writeSkill(claudeSkills, 'shared-review', {
      body: 'Same review instructions',
    });
    sandbox.writeSkill(cursorSkills, 'shared-review', {
      body: 'Same review instructions',
    });

    // 3. Diverged skill between Claude Code and Antigravity
    sandbox.writeSkill(claudeSkills, 'deploy-app', {
      body: 'Deploy v1 via kubectl',
      mtimeMs: 1_700_000_000_000,
    });
    sandbox.writeSkill(antigravitySkills, 'deploy-app', {
      body: 'Deploy v2 via helm',
      mtimeMs: 1_750_000_000_000,
    });

    // 4. Synced skill (canonical + symlink in Cursor)
    const canonicalSynced = sandbox.writeSkill(canonicalSkills, 'db-migrate', {
      body: 'Use drizzle-kit migrate',
    });
    fs.mkdirSync(cursorSkills, { recursive: true });
    fs.symlinkSync(canonicalSynced, path.join(cursorSkills, 'db-migrate'), 'dir');

    // 5. Canonical-only skill
    sandbox.writeSkill(canonicalSkills, 'new-skill');

    // 6. Broken symlink in Cursor
    fs.symlinkSync(
      path.join(sandbox.root, 'does-not-exist'),
      path.join(cursorSkills, 'dangling-skill'),
      'dir',
    );

    const report = scanSkills({
      homeDir: sandbox.homeDir,
      cwd: sandbox.cwd,
      storeDir: sandbox.storeDir,
      scope: 'global',
    });

    expect(report.summary.detectedAgents).toBeGreaterThanOrEqual(3);
    expect(report.summary.totalSkills).toBe(6);

    const byName = new Map(report.skills.map((s) => [s.skillName, s]));
    expect(byName.get('claude-only')?.classification).toBe('unique');
    expect(byName.get('shared-review')?.classification).toBe('identical-scattered');
    expect(byName.get('deploy-app')?.classification).toBe('diverged');
    expect(byName.get('deploy-app')?.distinctHashes).toHaveLength(2);
    expect(byName.get('db-migrate')?.classification).toBe('synced');
    expect(byName.get('new-skill')?.classification).toBe('canonical-only');
    expect(byName.get('dangling-skill')?.classification).toBe('broken');

    // Verify bundle diffing on the diverged skill
    const diff = diffSkillBundles(
      path.join(claudeSkills, 'deploy-app'),
      path.join(antigravitySkills, 'deploy-app'),
      { left: 'claude-code', right: 'antigravity' },
    );
    expect(diff.skillMdPatch).toContain('-Deploy v1 via kubectl');
    expect(diff.skillMdPatch).toContain('+Deploy v2 via helm');
    expect(diff.changedFiles).toEqual(['SKILL.md']);
  });
});
