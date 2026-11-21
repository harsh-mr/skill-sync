import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveConfig } from '../../src/core/store.js';
import { applySync, planSync } from '../../src/core/syncer.js';
import { startWatch, type WatchEvent, type WatchHandle } from '../../src/core/watcher.js';
import { createSandbox, type Sandbox } from '../helpers/sandbox.js';

function waitForEvent(
  events: WatchEvent[],
  predicate: (e: WatchEvent) => boolean,
  timeoutMs = 4000,
): Promise<WatchEvent> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const found = events.find(predicate);
      if (found) {
        resolve(found);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error('Timed out waiting for watcher event'));
        return;
      }
      setTimeout(check, 40);
    };
    check();
  });
}

describe('startWatch', () => {
  let sandbox: Sandbox;
  let handle: WatchHandle | null = null;

  afterEach(async () => {
    if (handle) {
      await handle.stop();
      handle = null;
    }
    sandbox?.cleanup();
  });

  it('propagates canonical edits to copy-mode agent automatically on file change', async () => {
    sandbox = createSandbox();
    const canonicalSkills = path.join(sandbox.storeDir, 'skills');
    const cursorSkills = path.join(sandbox.homeDir, '.cursor', 'skills');
    fs.mkdirSync(cursorSkills, { recursive: true });

    sandbox.writeSkill(canonicalSkills, 'live-skill', {
      body: 'Initial instructions.',
    });

    saveConfig(sandbox.storeDir, {
      version: 1,
      defaultMode: 'copy',
      tokenBudgetWarning: 4000,
      agents: {
        cursor: { enabled: true, mode: 'copy', profiles: ['*'] },
      },
    });

    // Initial sync baseline
    const initialPlan = planSync({
      homeDir: sandbox.homeDir,
      storeDir: sandbox.storeDir,
      scope: 'global',
    });
    applySync(initialPlan);

    const events: WatchEvent[] = [];
    handle = startWatch({
      homeDir: sandbox.homeDir,
      storeDir: sandbox.storeDir,
      scope: 'global',
      debounceMs: 80,
      onEvent: (ev) => events.push(ev),
    });

    await handle.ready;

    // Modify canonical SKILL.md
    fs.appendFileSync(
      path.join(canonicalSkills, 'live-skill', 'SKILL.md'),
      '\n## Live Updated Section\n',
      'utf8',
    );

    const syncEvent = await waitForEvent(
      events,
      (e) => e.type === 'synced' && (e.result?.applied.length ?? 0) > 0,
    );
    expect(syncEvent.result?.applied).toHaveLength(1);

    const cursorContent = fs.readFileSync(
      path.join(cursorSkills, 'live-skill', 'SKILL.md'),
      'utf8',
    );
    expect(cursorContent).toContain('## Live Updated Section');
  });
});
