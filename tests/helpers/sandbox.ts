import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface Sandbox {
  root: string;
  homeDir: string;
  cwd: string;
  storeDir: string;
  writeSkill: (
    baseDir: string,
    skillName: string,
    options?: {
      name?: string;
      description?: string;
      tags?: string[];
      body?: string;
      rawSkillMd?: string;
      extraFiles?: Record<string, string>;
      mtimeMs?: number;
    },
  ) => string;
  cleanup: () => void;
}

export function createSandbox(): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-sync-test-'));
  const homeDir = path.join(root, 'home');
  const cwd = path.join(root, 'workspace');
  const storeDir = path.join(homeDir, '.skill-sync');

  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });

  const writeSkill: Sandbox['writeSkill'] = (baseDir, skillName, options = {}) => {
    const skillDir = path.join(baseDir, skillName);
    fs.mkdirSync(skillDir, { recursive: true });

    const tagsLine =
      options.tags && options.tags.length > 0
        ? `tags: [${options.tags.join(', ')}]\n`
        : '';

    const skillMd =
      options.rawSkillMd ??
      `---\nname: ${options.name ?? skillName}\ndescription: "${options.description ?? `Skill instructions for ${skillName}`}"\n${tagsLine}---\n\n${options.body ?? `# ${skillName}\n\nFollow these steps carefully.`}\n`;

    const skillMdPath = path.join(skillDir, 'SKILL.md');
    fs.writeFileSync(skillMdPath, skillMd, 'utf8');

    if (options.extraFiles) {
      for (const [relPath, content] of Object.entries(options.extraFiles)) {
        const abs = path.join(skillDir, ...relPath.split('/'));
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, 'utf8');
      }
    }

    if (options.mtimeMs !== undefined) {
      const time = new Date(options.mtimeMs);
      fs.utimesSync(skillMdPath, time, time);
      fs.utimesSync(skillDir, time, time);
    }

    return skillDir;
  };

  return {
    root,
    homeDir,
    cwd,
    storeDir,
    writeSkill,
    cleanup: () => {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
