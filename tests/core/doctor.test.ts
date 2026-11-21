import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runDoctor } from '../../src/core/doctor.js';
import { saveConfig } from '../../src/core/store.js';
import { createSandbox, type Sandbox } from '../helpers/sandbox.js';

describe('runDoctor', () => {
  let sandbox: Sandbox;

  afterEach(() => {
    sandbox?.cleanup();
  });

  it('detects broken symlinks, missing resource refs, invalid YAML, token budget overruns, and fixes dangling symlinks', () => {
    sandbox = createSandbox();
    const claudeSkills = path.join(sandbox.homeDir, '.claude', 'skills');
    fs.mkdirSync(claudeSkills, { recursive: true });

    // 1. Broken symlink
    const brokenLink = path.join(claudeSkills, 'dead-link');
    fs.symlinkSync(path.join(sandbox.root, 'nope'), brokenLink, 'dir');

    // 2. Skill referencing a missing script
    sandbox.writeSkill(claudeSkills, 'missing-ref', {
      description: 'Runs a script that does not exist yet.',
      body: 'Execute `scripts/missing.sh` before deploying.',
    });

    // 3. Invalid YAML skill
    sandbox.writeSkill(claudeSkills, 'bad-yaml', {
      rawSkillMd: '---\nname: bad-yaml\ndescription: Use when: broken colon\n---\nBody\n',
    });

    // Set a tight token budget threshold to verify budget warning
    saveConfig(sandbox.storeDir, {
      version: 1,
      defaultMode: 'symlink',
      tokenBudgetWarning: 5,
      agents: {},
    });

    const firstPass = runDoctor({
      homeDir: sandbox.homeDir,
      cwd: sandbox.cwd,
      storeDir: sandbox.storeDir,
      scope: 'global',
    });

    const codes = new Set(firstPass.report.issues.map((i) => i.code));
    expect(codes.has('BROKEN_SYMLINK')).toBe(true);
    expect(codes.has('MISSING_RESOURCE_REF')).toBe(true);
    expect(codes.has('INVALID_YAML')).toBe(true);
    expect(codes.has('TOKEN_BUDGET_EXCEEDED')).toBe(true);

    // Run with --fix to remove dangling symlink
    const fixPass = runDoctor({
      homeDir: sandbox.homeDir,
      cwd: sandbox.cwd,
      storeDir: sandbox.storeDir,
      scope: 'global',
      fix: true,
    });
    expect(fixPass.fixed.length).toBe(1);
    expect(() => fs.lstatSync(brokenLink)).toThrow();
  });
});
