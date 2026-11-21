import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getGitStatus,
  pullStore,
  pushStore,
  setGitRemote,
} from '../../src/core/git.js';
import { ensureStore } from '../../src/core/store.js';
import { createSandbox, type Sandbox } from '../helpers/sandbox.js';

describe('git multi-machine sync', () => {
  let sandbox: Sandbox;

  afterEach(() => {
    sandbox?.cleanup();
  });

  it('pushes canonical skills from machine A to a bare remote and pulls them on machine B without committing state.json', () => {
    sandbox = createSandbox();

    const remoteDir = path.join(sandbox.root, 'remote.git');
    execFileSync('git', ['init', '--bare', '-b', 'main', remoteDir], {
      stdio: 'ignore',
    });

    const machineAStore = path.join(sandbox.root, 'machine-a', '.skill-sync');
    const machineBStore = path.join(sandbox.root, 'machine-b', '.skill-sync');

    ensureStore(machineAStore);
    sandbox.writeSkill(path.join(machineAStore, 'skills'), 'sql-tuning', {
      tags: ['backend'],
      body: 'Always inspect EXPLAIN ANALYZE.',
    });
    // Write machine-local state.json that must stay gitignored
    fs.writeFileSync(
      path.join(machineAStore, 'state.json'),
      JSON.stringify({ version: 1, agents: {} }),
    );

    const remoteRes = setGitRemote(machineAStore, remoteDir);
    expect(remoteRes.initialized).toBe(true);

    // Configure local git identity inside test repo
    execFileSync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: machineAStore,
    });
    execFileSync('git', ['config', 'user.name', 'Test User'], {
      cwd: machineAStore,
    });

    const pushRes = pushStore(machineAStore, { message: 'initial skills' });
    expect(pushRes.committed).toBe(true);
    expect(pushRes.pushed).toBe(true);

    const statusA = getGitStatus(machineAStore);
    expect(statusA.isRepo).toBe(true);
    expect(statusA.remoteUrl).toBe(remoteDir);
    expect(statusA.dirtyFiles).toHaveLength(0);
    expect(statusA.lastCommit?.subject).toBe('initial skills');

    // Verify state.json was NOT tracked in git
    const trackedFiles = execFileSync('git', ['ls-files'], {
      cwd: machineAStore,
      encoding: 'utf8',
    });
    expect(trackedFiles).toContain('skills/sql-tuning/SKILL.md');
    expect(trackedFiles).not.toContain('state.json');

    // Machine B sets remote and pulls
    setGitRemote(machineBStore, remoteDir);
    execFileSync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: machineBStore,
    });
    execFileSync('git', ['config', 'user.name', 'Test User'], {
      cwd: machineBStore,
    });
    // Clean initial default config created by ensureStore so pull cleanly fast-forwards
    fs.rmSync(path.join(machineBStore, 'config.json'), { force: true });
    fs.rmSync(path.join(machineBStore, '.gitignore'), { force: true });

    const pullRes = pullStore(machineBStore);
    expect(pullRes.pulled).toBe(true);
    expect(
      fs.existsSync(path.join(machineBStore, 'skills', 'sql-tuning', 'SKILL.md')),
    ).toBe(true);
  });
});
