import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/server/app.js';
import { createSandbox, type Sandbox } from '../helpers/sandbox.js';

describe('embedded Hono UI server & API', () => {
  let sandbox: Sandbox;

  afterEach(() => {
    sandbox?.cleanup();
  });

  it('serves static UI assets and handles full skill creation, agent config, sync, edit, diff, and doctor APIs', async () => {
    sandbox = createSandbox();

    const claudeSkills = path.join(sandbox.homeDir, '.claude', 'skills');
    const cursorSkills = path.join(sandbox.homeDir, '.cursor', 'skills');
    fs.mkdirSync(claudeSkills, { recursive: true });
    fs.mkdirSync(cursorSkills, { recursive: true });

    sandbox.writeSkill(claudeSkills, 'legacy-skill', {
      body: 'Original Claude instructions',
    });
    sandbox.writeSkill(cursorSkills, 'legacy-skill', {
      body: 'Edited Cursor instructions',
    });

    const app = createApp({
      homeDir: sandbox.homeDir,
      cwd: sandbox.cwd,
      storeDir: sandbox.storeDir,
      defaultScope: 'global',
      uiDir: path.resolve(process.cwd(), 'src/ui'),
    });

    // 1. Static HTML & CSS
    const htmlRes = await app.request('/');
    expect(htmlRes.status).toBe(200);
    expect(await htmlRes.text()).toContain('skill-sync');

    const cssRes = await app.request('/styles.css');
    expect(cssRes.status).toBe(200);

    // 2. Overview detects diverged skill
    const overviewRes = await app.request('/api/overview?scope=global');
    expect(overviewRes.status).toBe(200);
    const overview = (await overviewRes.json()) as {
      scan: { summary: { diverged: number } };
    };
    expect(overview.scan.summary.diverged).toBe(1);

    // 3. Diff API compares diverged copies
    const diffRes = await app.request(
      '/api/diff?skill=legacy-skill&left=claude-code&right=cursor',
    );
    expect(diffRes.status).toBe(200);
    const diffBody = (await diffRes.json()) as { diff: { skillMdPatch: string } };
    expect(diffBody.diff.skillMdPatch).toContain('-Original Claude instructions');
    expect(diffBody.diff.skillMdPatch).toContain('+Edited Cursor instructions');

    // 4. Create new canonical skill
    const createRes = await app.request('/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'api-testing',
        description: 'Run structured contract tests against REST APIs.',
        tags: ['backend'],
        instructions: '# API Testing\n\nCheck status codes and schemas.',
      }),
    });
    expect(createRes.status).toBe(201);

    // 5. Configure cursor to copy mode & sync
    const cfgRes = await app.request('/api/config/agent/cursor', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, mode: 'copy', profiles: ['*'] }),
    });
    expect(cfgRes.status).toBe(200);

    const syncRes = await app.request('/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'global', conflictStrategy: 'skip' }),
    });
    expect(syncRes.status).toBe(200);
    expect(fs.existsSync(path.join(cursorSkills, 'api-testing', 'SKILL.md'))).toBe(true);

    // 6. Edit skill via PUT & syncAfter
    const putRes = await app.request('/api/skills/api-testing', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content:
          '---\nname: api-testing\ndescription: "Updated description"\ntags: [backend]\n---\n\n# Updated\n',
        syncAfter: true,
      }),
    });
    expect(putRes.status).toBe(200);
    expect(fs.readFileSync(path.join(cursorSkills, 'api-testing', 'SKILL.md'), 'utf8')).toContain(
      '# Updated',
    );

    // 7. Reject path traversal on skill route
    const badRes = await app.request('/api/skills/..%2Fsecret');
    expect(badRes.status).toBe(400);
  });
});
