import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import {
  adoptSkills,
  getAdoptableGroups,
  pickNewestInstance,
} from '../core/adopt.js';
import { runDoctor } from '../core/doctor.js';
import { getGitStatus, pullStore, pushStore, setGitRemote } from '../core/git.js';
import { parseSkillMarkdown, SKILL_NAME_REGEX } from '../core/parser.js';
import { diffSkillBundles, scanSkills } from '../core/scanner.js';
import {
  backupPath,
  createDefaultConfig,
  ensureStore,
  getStoreLayout,
  loadConfig,
  resolveStoreDir,
  saveConfig,
} from '../core/store.js';
import { applySync, planSync, syncRulesBridge } from '../core/syncer.js';
import type { ConflictResolution, SyncMode } from '../core/types.js';

export interface ServerOptions {
  homeDir?: string;
  cwd?: string;
  storeDir?: string;
  defaultScope?: 'global' | 'project';
  uiDir?: string;
}

function resolveUiDirectory(explicitDir?: string): string {
  if (explicitDir && fs.existsSync(explicitDir)) {
    return explicitDir;
  }
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(currentDir, '../ui'),
    path.resolve(currentDir, '../../src/ui'),
    path.resolve(process.cwd(), 'dist/ui'),
    path.resolve(process.cwd(), 'src/ui'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'index.html'))) {
      return dir;
    }
  }
  return candidates[0]!;
}

function isSafeSkillSlug(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 80 &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('..') &&
    name !== '.'
  );
}

export function createApp(options: ServerOptions = {}): Hono {
  const app = new Hono();
  const homeDir = options.homeDir ?? os.homedir();
  const cwd = options.cwd ?? process.cwd();
  const defaultScope = options.defaultScope ?? 'global';
  const uiDir = resolveUiDirectory(options.uiDir);

  function getContext(scopeParam?: string) {
    const scope: 'global' | 'project' =
      scopeParam === 'project'
        ? 'project'
        : scopeParam === 'global'
          ? 'global'
          : defaultScope;
    const storeDir = resolveStoreDir({
      homeDir,
      cwd,
      scope,
      storeDir: options.storeDir,
    });
    return { scope, storeDir };
  }

  // --- API Routes ---

  app.get('/api/overview', (c) => {
    const { scope, storeDir } = getContext(c.req.query('scope'));
    const scan = scanSkills({ homeDir, cwd, storeDir, scope });
    const config =
      loadConfig(storeDir) ??
      createDefaultConfig(scan.agents.filter((a) => a.detected).map((a) => a.id));
    const plan = planSync({ homeDir, cwd, storeDir, scope, config });
    const doctor = runDoctor({ homeDir, cwd, storeDir, scope, config });
    const git = getGitStatus(storeDir);

    return c.json({
      scope,
      storeDir,
      config,
      scan,
      plan,
      doctor: doctor.report,
      git,
    });
  });

  app.get('/api/skills/:name', (c) => {
    const skillName = c.req.param('name');
    if (!isSafeSkillSlug(skillName)) {
      return c.json({ error: 'Invalid skill name' }, 400);
    }
    const { scope, storeDir } = getContext(c.req.query('scope'));
    const scan = scanSkills({ homeDir, cwd, storeDir, scope });
    const group = scan.skills.find((s) => s.skillName === skillName);
    const layout = getStoreLayout(storeDir);
    const canonicalDir = path.join(layout.skillsDir, skillName);
    const canonicalMdPath = path.join(canonicalDir, 'SKILL.md');

    let content: string | null = null;
    let sourcePath: string | null = null;
    let isCanonical = false;

    if (fs.existsSync(canonicalMdPath)) {
      content = fs.readFileSync(canonicalMdPath, 'utf8');
      sourcePath = canonicalMdPath;
      isCanonical = true;
    } else if (group?.instances[0]?.realPath) {
      const altMd = path.join(group.instances[0].realPath, 'SKILL.md');
      if (fs.existsSync(altMd)) {
        content = fs.readFileSync(altMd, 'utf8');
        sourcePath = altMd;
      }
    }

    if (content === null && !group) {
      return c.json({ error: `Skill "${skillName}" not found` }, 404);
    }

    const parse =
      content !== null
        ? parseSkillMarkdown(content, {
            expectedName: skillName,
            filePath: sourcePath ?? 'SKILL.md',
          })
        : null;

    return c.json({
      skillName,
      isCanonical,
      sourcePath,
      content: content ?? '',
      parse,
      group: group ?? null,
    });
  });

  app.post('/api/skills', async (c) => {
    const body = (await c.req.json()) as {
      scope?: string;
      name?: string;
      description?: string;
      tags?: string[];
      instructions?: string;
    };

    const name = body.name?.trim() ?? '';
    const description = body.description?.trim() ?? '';
    if (!SKILL_NAME_REGEX.test(name)) {
      return c.json(
        { error: 'Skill name must be lowercase kebab-case (a-z, 0-9, hyphens)' },
        400,
      );
    }
    if (!description) {
      return c.json({ error: 'Skill description is required' }, 400);
    }

    const { storeDir } = getContext(body.scope);
    const layout = ensureStore(storeDir);
    const skillDir = path.join(layout.skillsDir, name);
    if (fs.existsSync(skillDir)) {
      return c.json({ error: `Skill "${name}" already exists in canonical store` }, 409);
    }

    const tags = (body.tags ?? [])
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    const tagsLine = tags.length > 0 ? `tags: [${tags.join(', ')}]\n` : '';
    const escapedDesc = description.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const instructions =
      body.instructions?.trim() || `# ${name}\n\nDescribe the workflow steps here.`;

    const markdown = `---\nname: ${name}\ndescription: "${escapedDesc}"\n${tagsLine}---\n\n${instructions}\n`;
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), markdown, 'utf8');

    const parse = parseSkillMarkdown(markdown, { expectedName: name });
    return c.json({ created: true, skillName: name, parse }, 201);
  });

  app.put('/api/skills/:name', async (c) => {
    const skillName = c.req.param('name');
    if (!isSafeSkillSlug(skillName)) {
      return c.json({ error: 'Invalid skill name' }, 400);
    }
    const body = (await c.req.json()) as {
      scope?: string;
      content?: string;
      syncAfter?: boolean;
    };
    if (typeof body.content !== 'string') {
      return c.json({ error: 'Missing "content" string' }, 400);
    }

    const { scope, storeDir } = getContext(body.scope);
    const layout = ensureStore(storeDir);
    const skillDir = path.join(layout.skillsDir, skillName);
    const skillMdPath = path.join(skillDir, 'SKILL.md');

    let backup: string | null = null;
    if (fs.existsSync(skillMdPath)) {
      backup = backupPath(storeDir, `edit-${skillName}`, skillDir);
    } else {
      fs.mkdirSync(skillDir, { recursive: true });
    }

    fs.writeFileSync(skillMdPath, body.content, 'utf8');
    const parse = parseSkillMarkdown(body.content, {
      expectedName: skillName,
      filePath: skillMdPath,
    });

    let syncResult = null;
    if (body.syncAfter) {
      const plan = planSync({ homeDir, cwd, storeDir, scope });
      syncResult = applySync(plan, { conflictStrategy: 'skip' });
    }

    return c.json({
      saved: true,
      skillName,
      backup,
      parse,
      syncResult,
    });
  });

  app.get('/api/diff', (c) => {
    const skillName = c.req.query('skill') ?? '';
    const leftId = c.req.query('left') ?? 'canonical';
    const rightId = c.req.query('right') ?? '';
    if (!isSafeSkillSlug(skillName)) {
      return c.json({ error: 'Invalid skill name' }, 400);
    }

    const { scope, storeDir } = getContext(c.req.query('scope'));
    const scan = scanSkills({ homeDir, cwd, storeDir, scope });
    const group = scan.skills.find((s) => s.skillName === skillName);
    if (!group) {
      return c.json({ error: `Skill "${skillName}" not found` }, 404);
    }

    const all = [
      ...(group.canonical ? [group.canonical] : []),
      ...group.instances,
    ].filter((inst) => inst.realPath && !inst.isBrokenSymlink);

    const leftInst =
      all.find((i) => i.agentId === leftId) ?? all[0];
    const rightInst =
      all.find((i) => i.agentId === rightId) ??
      all.find((i) => i !== leftInst && i.hash !== leftInst?.hash) ??
      all[1];

    if (!leftInst?.realPath || !rightInst?.realPath) {
      return c.json({ error: 'Need two readable skill copies to compute diff' }, 400);
    }

    const diff = diffSkillBundles(leftInst.realPath, rightInst.realPath, {
      left: leftInst.agentId,
      right: rightInst.agentId,
    });

    return c.json({
      skillName,
      left: {
        agentId: leftInst.agentId,
        agentName: leftInst.agentName,
        path: leftInst.path,
        mtimeMs: leftInst.mtimeMs,
      },
      right: {
        agentId: rightInst.agentId,
        agentName: rightInst.agentName,
        path: rightInst.path,
        mtimeMs: rightInst.mtimeMs,
      },
      diff,
    });
  });

  app.post('/api/adopt', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      scope?: string;
      skillName?: string;
      fromAgentId?: string;
      strategy?: 'newest' | 'skip';
    };

    const { scope, storeDir } = getContext(body.scope);
    const scan = scanSkills({ homeDir, cwd, storeDir, scope });
    const detectedIds = scan.agents.filter((a) => a.detected).map((a) => a.id);

    if (body.skillName && body.fromAgentId) {
      const group = scan.skills.find((s) => s.skillName === body.skillName);
      const source = group?.instances.find((i) => i.agentId === body.fromAgentId);
      if (!source) {
        return c.json(
          { error: `Instance "${body.skillName}" in "${body.fromAgentId}" not found` },
          404,
        );
      }
      const res = adoptSkills({
        storeDir,
        enableDetectedAgents: detectedIds,
        selections: [{ skillName: body.skillName, sourceInstance: source }],
      });
      return c.json(res);
    }

    const { autoAdoptable, needsChoice } = getAdoptableGroups(scan);
    const selections = autoAdoptable
      .map((g) => {
        const picked = pickNewestInstance(g.instances);
        return picked ? { skillName: g.skillName, sourceInstance: picked } : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    if (body.strategy === 'newest') {
      for (const g of needsChoice) {
        const picked = pickNewestInstance([
          ...(g.canonical ? [g.canonical] : []),
          ...g.instances,
        ]);
        if (picked) {
          selections.push({ skillName: g.skillName, sourceInstance: picked });
        }
      }
    }

    const res = adoptSkills({
      storeDir,
      enableDetectedAgents: detectedIds,
      selections,
    });
    return c.json(res);
  });

  app.post('/api/sync', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      scope?: string;
      mode?: SyncMode;
      dryRun?: boolean;
      prune?: boolean;
      pullUpstream?: boolean;
      conflictStrategy?: ConflictResolution;
      perActionResolution?: Record<string, ConflictResolution>;
      bridgeRules?: boolean;
    };

    const { scope, storeDir } = getContext(body.scope);
    const plan = planSync({
      homeDir,
      cwd,
      storeDir,
      scope,
      modeOverride: body.mode,
      includePrune: Boolean(body.prune),
    });

    const result = applySync(plan, {
      dryRun: Boolean(body.dryRun),
      conflictStrategy: body.conflictStrategy ?? 'skip',
      perActionResolution: body.perActionResolution,
      pullUpstream: body.pullUpstream ?? true,
      prune: Boolean(body.prune),
    });

    const rulesBridge =
      body.bridgeRules && scope === 'project'
        ? syncRulesBridge({ cwd, mode: body.mode ?? 'copy', dryRun: Boolean(body.dryRun) })
        : null;

    return c.json({ plan, result, rulesBridge });
  });

  app.patch('/api/config/agent/:agentId', async (c) => {
    const agentId = c.req.param('agentId');
    const body = (await c.req.json()) as {
      scope?: string;
      enabled?: boolean;
      mode?: SyncMode;
      profiles?: string[];
      include?: string[];
      exclude?: string[];
    };

    const { scope, storeDir } = getContext(body.scope);
    const scan = scanSkills({ homeDir, cwd, storeDir, scope });
    ensureStore(storeDir, {
      detectedAgentIds: scan.agents.filter((a) => a.detected).map((a) => a.id),
    });

    const config =
      loadConfig(storeDir) ??
      createDefaultConfig(scan.agents.filter((a) => a.detected).map((a) => a.id));

    const prev = config.agents[agentId] ?? {
      enabled: false,
      mode: config.defaultMode,
      profiles: ['*'],
    };

    config.agents[agentId] = {
      ...prev,
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      ...(body.mode !== undefined ? { mode: body.mode } : {}),
      ...(body.profiles !== undefined ? { profiles: body.profiles } : {}),
      ...(body.include !== undefined ? { include: body.include } : {}),
      ...(body.exclude !== undefined ? { exclude: body.exclude } : {}),
    };

    saveConfig(storeDir, config);
    return c.json({ agentId, agentConfig: config.agents[agentId], config });
  });

  app.post('/api/doctor/fix', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { scope?: string };
    const { scope, storeDir } = getContext(body.scope);
    const res = runDoctor({ homeDir, cwd, storeDir, scope, fix: true });
    return c.json(res);
  });

  app.post('/api/git/remote', async (c) => {
    const body = (await c.req.json()) as { scope?: string; url?: string };
    if (!body.url?.trim()) {
      return c.json({ error: 'Remote URL is required' }, 400);
    }
    const { storeDir } = getContext(body.scope);
    try {
      const res = setGitRemote(storeDir, body.url.trim());
      return c.json(res);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        500,
      );
    }
  });

  app.post('/api/git/push', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      scope?: string;
      message?: string;
    };
    const { storeDir } = getContext(body.scope);
    try {
      const res = pushStore(storeDir, { message: body.message });
      return c.json(res);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        500,
      );
    }
  });

  app.post('/api/git/pull', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      scope?: string;
      syncAfter?: boolean;
    };
    const { scope, storeDir } = getContext(body.scope);
    try {
      const pull = pullStore(storeDir);
      let sync = null;
      if (body.syncAfter !== false) {
        const plan = planSync({ homeDir, cwd, storeDir, scope });
        sync = applySync(plan, { conflictStrategy: 'skip' });
      }
      return c.json({ pull, sync });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        500,
      );
    }
  });

  // --- Static Local Web UI Assets ---

  const serveStaticFile = (filename: string, contentType: string) => {
    const filePath = path.join(uiDir, filename);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return { content: fs.readFileSync(filePath, 'utf8'), contentType };
  };

  app.get('/', (c) => {
    const asset = serveStaticFile('index.html', 'text/html; charset=utf-8');
    if (!asset) {
      return c.text('UI assets not found. Run "pnpm build" first.', 404);
    }
    return c.html(asset.content);
  });

  app.get('/styles.css', (c) => {
    const asset = serveStaticFile('styles.css', 'text/css; charset=utf-8');
    if (!asset) {
      return c.notFound();
    }
    return c.body(asset.content, 200, { 'Content-Type': asset.contentType });
  });

  app.get('/app.js', (c) => {
    const asset = serveStaticFile('app.js', 'application/javascript; charset=utf-8');
    if (!asset) {
      return c.notFound();
    }
    return c.body(asset.content, 200, { 'Content-Type': asset.contentType });
  });

  return app;
}
