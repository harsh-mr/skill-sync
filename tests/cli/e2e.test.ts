import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSandbox, type Sandbox } from '../helpers/sandbox.js';

const CLI_BIN = path.resolve(process.cwd(), 'dist/cli/index.js');

function runCli(args: string[], env: NodeJS.ProcessEnv, cwd: string): string {
  return execFileSync(process.execPath, [CLI_BIN, ...args], {
    cwd,
    env: { ...process.env, ...env, NO_COLOR: '1' },
    encoding: 'utf8',
  });
}

describe('CLI end-to-end workflow', () => {
  let sandbox: Sandbox;

  afterEach(() => {
    sandbox?.cleanup();
  });

  it('runs scan -> adopt -> sync -> status -> doctor cleanly against compiled dist/cli/index.js', () => {
    sandbox = createSandbox();

    const claudeSkills = path.join(sandbox.homeDir, '.claude', 'skills');
    const cursorSkills = path.join(sandbox.homeDir, '.cursor', 'skills');
    const antigravitySkills = path.join(
      sandbox.homeDir,
      '.gemini',
      'antigravity',
      'skills',
    );

    sandbox.writeSkill(claudeSkills, 'ts-refactor', {
      tags: ['core'],
      body: 'Refactor TypeScript modules cleanly.',
    });
    fs.mkdirSync(cursorSkills, { recursive: true });
    fs.mkdirSync(antigravitySkills, { recursive: true });

    const env = { HOME: sandbox.homeDir };

    // 1. scan --json
    const scanOut = JSON.parse(runCli(['scan', '--json'], env, sandbox.cwd));
    expect(scanOut.summary.totalSkills).toBe(1);
    expect(scanOut.summary.unique).toBe(1);

    // 2. adopt --yes --json
    const adoptOut = JSON.parse(runCli(['adopt', '--yes', '--json'], env, sandbox.cwd));
    expect(adoptOut.adopted).toHaveLength(1);

    // 3. sync --mode copy --yes --json
    const syncOut = JSON.parse(
      runCli(['sync', '--mode', 'copy', '--yes', '--json'], env, sandbox.cwd),
    );
    expect(syncOut.result.errors).toHaveLength(0);
    expect(fs.existsSync(path.join(cursorSkills, 'ts-refactor', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(antigravitySkills, 'ts-refactor', 'SKILL.md'))).toBe(
      true,
    );

    // 4. status --json
    const statusOut = JSON.parse(runCli(['status', '--json'], env, sandbox.cwd));
    expect(statusOut.scanSummary.synced).toBe(1);

    // 5. doctor --json
    const doctorOut = JSON.parse(runCli(['doctor', '--json'], env, sandbox.cwd));
    expect(doctorOut.report.summary.errors).toBe(0);
  });
});
