const state = {
  scope: 'global',
  view: 'matrix',
  overview: null,
  selectedSkill: null,
  selectedSkillData: null,
  matrixFilter: '',
  editorFilter: '',
};

const VIEW_META = {
  matrix: {
    title: 'Sync Matrix',
    subtitle: 'Inspect and synchronize SKILL.md bundles across your installed coding agents.',
  },
  skills: {
    title: 'Skills & Editor',
    subtitle: 'Edit canonical SKILL.md files with instant YAML validation and token estimates.',
  },
  conflicts: {
    title: 'Diffs & Conflicts',
    subtitle: 'Compare diverged agent copies line by line before choosing the canonical version.',
  },
  doctor: {
    title: 'Doctor & Git Sync',
    subtitle: 'Audit frontmatter health, context token budgets, and multi-machine Git sync.',
  },
};

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showToast(message, isError = false) {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast${isError ? ' error' : ''}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3400);
}

async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

function badgeForClassification(cls) {
  switch (cls) {
    case 'synced':
      return '<span class="badge badge-ok">synced</span>';
    case 'unique':
      return '<span class="badge badge-info">unique</span>';
    case 'identical-scattered':
      return '<span class="badge badge-info">scattered</span>';
    case 'diverged':
      return '<span class="badge badge-warn">diverged</span>';
    case 'broken':
      return '<span class="badge badge-danger">broken</span>';
    case 'canonical-only':
      return '<span class="badge badge-neutral">canonical-only</span>';
    default:
      return `<span class="badge badge-neutral">${escapeHtml(cls)}</span>`;
  }
}

function renderDiffHtml(patch) {
  if (!patch) {
    return '<span class="muted">No SKILL.md text differences (bundled files may differ).</span>';
  }
  return patch
    .split('\n')
    .map((line) => {
      const safe = escapeHtml(line);
      if (line.startsWith('+') && !line.startsWith('+++')) {
        return `<span class="diff-line-add">${safe}</span>`;
      }
      if (line.startsWith('-') && !line.startsWith('---')) {
        return `<span class="diff-line-del">${safe}</span>`;
      }
      if (line.startsWith('@@')) {
        return `<span class="diff-line-hunk">${safe}</span>`;
      }
      return `<span>${safe}</span>\n`;
    })
    .join('');
}

async function loadOverview() {
  try {
    const data = await api(`/api/overview?scope=${encodeURIComponent(state.scope)}`);
    state.overview = data;
    renderAll();
  } catch (err) {
    showToast(err.message, true);
  }
}

function renderAll() {
  const data = state.overview;
  if (!data) return;

  document.getElementById('store-path-label').textContent = data.storeDir;
  document.getElementById('count-skills').textContent = String(data.scan.summary.totalSkills);

  const conflictItems = getConflictItems();
  const conflictBadge = document.getElementById('count-conflicts');
  conflictBadge.textContent = String(conflictItems.length);
  conflictBadge.classList.toggle('hidden', conflictItems.length === 0);

  const issueCount = data.doctor.summary.errors + data.doctor.summary.warnings;
  const issueBadge = document.getElementById('count-issues');
  issueBadge.textContent = String(issueCount);
  issueBadge.classList.toggle('hidden', issueCount === 0);

  document.getElementById('sidebar-agents').textContent = String(
    data.scan.summary.detectedAgents,
  );
  const pending =
    data.plan.summary.create +
    data.plan.summary.update +
    data.plan.summary['pull-upstream'] +
    data.plan.summary.conflict;
  document.getElementById('sidebar-pending').textContent = String(pending);
  document.getElementById('sidebar-git').textContent = data.git.remoteUrl ? 'Linked' : 'None';

  const unadoptedCount =
    data.scan.summary.unique + data.scan.summary.identicalScattered;
  const adoptBtn = document.getElementById('btn-adopt-all');
  adoptBtn.classList.toggle('hidden', unadoptedCount === 0);
  adoptBtn.textContent = `Adopt Unadopted (${unadoptedCount})`;

  renderAgents();
  renderMatrix();
  renderEditorSkillList();
  renderConflicts();
  renderDoctorAndGit();
}

function getConflictItems() {
  const data = state.overview;
  if (!data) return [];
  const items = [];
  const seen = new Set();

  for (const action of data.plan.actions) {
    if (action.type === 'conflict' || action.type === 'pull-upstream') {
      items.push({
        kind: action.type,
        skillName: action.skillName,
        agentId: action.agentId,
        agentName: action.agentName,
        actionId: action.id,
        reason: action.reason,
        left: 'canonical',
        right: action.agentId,
      });
      seen.add(action.skillName);
    }
  }

  for (const group of data.scan.skills) {
    if (group.classification === 'diverged' && !seen.has(group.skillName)) {
      const candidates = [
        ...(group.canonical ? [group.canonical] : []),
        ...group.instances,
      ].filter((i) => !i.isBrokenSymlink);
      if (candidates.length >= 2) {
        items.push({
          kind: 'diverged',
          skillName: group.skillName,
          left: candidates[0].agentId,
          right: candidates[1].agentId,
          reason: `${group.distinctHashes.length} different versions across ${candidates.map((c) => c.agentId).join(', ')}`,
          candidates,
        });
      }
    }
  }

  return items;
}

function renderAgents() {
  const data = state.overview;
  const container = document.getElementById('agent-cards');
  const agentsToShow = data.scan.agents.filter(
    (a) => a.detected || data.config.agents[a.id]?.enabled,
  );

  if (agentsToShow.length === 0) {
    container.innerHTML =
      '<div class="empty-state">No coding agents detected in this scope yet.</div>';
    return;
  }

  container.innerHTML = agentsToShow
    .map((agent) => {
      const cfg = data.config.agents[agent.id] || {
        enabled: agent.detected,
        mode: data.config.defaultMode,
        profiles: ['*'],
      };
      const budget = data.scan.tokenBudgets.find(
        (b) => b.agentId === agent.id && b.scope === agent.scope,
      );
      const profilesText = (cfg.profiles || ['*']).join(', ');
      return `
        <div class="agent-card ${cfg.enabled ? '' : 'disabled'}" data-agent="${escapeHtml(agent.id)}">
          <div class="agent-card-top">
            <div>
              <div class="agent-name">${escapeHtml(agent.name)}</div>
              <div class="agent-id">${escapeHtml(agent.id)}</div>
            </div>
            <label class="inline-controls" style="cursor:pointer;font-size:12px;">
              <input type="checkbox" class="agent-toggle" data-agent="${escapeHtml(agent.id)}" ${cfg.enabled ? 'checked' : ''} />
              <span>${cfg.enabled ? 'On' : 'Off'}</span>
            </label>
          </div>
          <div class="stat-line">
            <span>${budget?.skillCount ?? 0} skill(s)</span>
            <strong class="${budget?.exceedsBudget ? 'badge badge-warn' : ''}">~${budget?.frontmatterTokens ?? 0} tok</strong>
          </div>
          <div class="agent-controls">
            <select class="select-inline agent-mode" data-agent="${escapeHtml(agent.id)}" aria-label="Sync mode for ${escapeHtml(agent.name)}">
              <option value="symlink" ${(cfg.mode || 'symlink') === 'symlink' ? 'selected' : ''}>symlink</option>
              <option value="copy" ${cfg.mode === 'copy' ? 'selected' : ''}>copy</option>
            </select>
            <input
              type="text"
              class="profile-input agent-profiles"
              data-agent="${escapeHtml(agent.id)}"
              value="${escapeHtml(profilesText)}"
              title="Profile tags (comma-separated, or * for all)"
              aria-label="Profiles for ${escapeHtml(agent.name)}"
            />
          </div>
        </div>
      `;
    })
    .join('');

  container.querySelectorAll('.agent-toggle').forEach((el) => {
    el.addEventListener('change', async (e) => {
      const agentId = e.target.dataset.agent;
      await updateAgentConfig(agentId, { enabled: e.target.checked });
    });
  });

  container.querySelectorAll('.agent-mode').forEach((el) => {
    el.addEventListener('change', async (e) => {
      const agentId = e.target.dataset.agent;
      await updateAgentConfig(agentId, { mode: e.target.value });
    });
  });

  container.querySelectorAll('.agent-profiles').forEach((el) => {
    el.addEventListener('change', async (e) => {
      const agentId = e.target.dataset.agent;
      const profiles = e.target.value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      await updateAgentConfig(agentId, { profiles: profiles.length ? profiles : ['*'] });
    });
  });
}

async function updateAgentConfig(agentId, patch) {
  try {
    await api(`/api/config/agent/${encodeURIComponent(agentId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ scope: state.scope, ...patch }),
    });
    showToast(`Updated ${agentId} configuration`);
    await loadOverview();
  } catch (err) {
    showToast(err.message, true);
  }
}

function renderMatrix() {
  const data = state.overview;
  const activeAgents = data.scan.agents.filter(
    (a) => a.detected || data.config.agents[a.id]?.enabled,
  );
  const head = document.getElementById('matrix-head');
  const body = document.getElementById('matrix-body');

  head.innerHTML = `
    <tr>
      <th>Skill</th>
      <th>Status</th>
      <th>Tokens</th>
      ${activeAgents.map((a) => `<th>${escapeHtml(a.name)}</th>`).join('')}
    </tr>
  `;

  const filter = state.matrixFilter.trim().toLowerCase();
  const rows = data.scan.skills.filter(
    (s) =>
      !filter ||
      s.skillName.toLowerCase().includes(filter) ||
      (s.description || '').toLowerCase().includes(filter) ||
      s.tags.some((t) => t.includes(filter)),
  );

  if (rows.length === 0) {
    body.innerHTML = `<tr><td colspan="${3 + activeAgents.length}" class="muted" style="text-align:center;padding:28px;">No skills found. Click "New Skill" to create one or add skills to an agent folder.</td></tr>`;
    return;
  }

  const actionByKey = new Map(
    data.plan.actions.map((a) => [`${a.agentId}:${a.skillName}`, a]),
  );

  body.innerHTML = rows
    .map((group) => {
      const cells = activeAgents
        .map((agent) => {
          const inst = group.instances.find((i) => i.agentId === agent.id);
          const action = actionByKey.get(`${agent.id}:${group.skillName}`);

          if (inst?.isBrokenSymlink) {
            return '<td><span class="badge badge-danger">broken link</span></td>';
          }
          if (action?.type === 'conflict') {
            return '<td><span class="badge badge-warn">conflict</span></td>';
          }
          if (action?.type === 'pull-upstream') {
            return '<td><span class="badge badge-info">edited</span></td>';
          }
          if (inst && group.canonical && inst.hash === group.canonical.hash) {
            const modeTag = inst.isSymlink ? 'symlink' : 'copy';
            return `<td><span class="badge badge-ok">${modeTag}</span></td>`;
          }
          if (inst && !group.canonical) {
            return '<td><span class="badge badge-info">unadopted</span></td>';
          }
          if (action?.type === 'create' || action?.type === 'update') {
            return `<td><span class="badge badge-neutral">pending ${action.mode}</span></td>`;
          }
          return '<td><span class="muted">&mdash;</span></td>';
        })
        .join('');

      const tagsHtml = group.tags
        .map((t) => `<span class="mono-pill">${escapeHtml(t)}</span>`)
        .join(' ');

      return `
        <tr>
          <td>
            <button type="button" class="skill-cell-btn" data-open-skill="${escapeHtml(group.skillName)}">
              ${escapeHtml(group.skillName)}
            </button>
            <div class="skill-desc">${escapeHtml(group.description || '')} ${tagsHtml}</div>
          </td>
          <td>${badgeForClassification(group.classification)}</td>
          <td class="mono muted">${group.frontmatterTokens}</td>
          ${cells}
        </tr>
      `;
    })
    .join('');

  body.querySelectorAll('[data-open-skill]').forEach((btn) => {
    btn.addEventListener('click', () => {
      openSkillInEditor(btn.dataset.openSkill);
    });
  });
}

function renderEditorSkillList() {
  const data = state.overview;
  const container = document.getElementById('editor-skill-list');
  const filter = state.editorFilter.trim().toLowerCase();
  const list = data.scan.skills.filter(
    (s) => !filter || s.skillName.toLowerCase().includes(filter),
  );

  if (list.length === 0) {
    container.innerHTML = '<div class="muted" style="padding:14px;">No skills available.</div>';
    return;
  }

  container.innerHTML = list
    .map(
      (s) => `
      <button type="button" class="skill-list-item ${state.selectedSkill === s.skillName ? 'active' : ''}" data-select-skill="${escapeHtml(s.skillName)}">
        <div class="skill-list-item-top">
          <span class="mono" style="font-weight:500;font-size:12.5px;">${escapeHtml(s.skillName)}</span>
          ${badgeForClassification(s.classification)}
        </div>
        <span class="muted" style="font-size:11.5px;">${s.frontmatterTokens} tok &middot; ${s.instances.length} agent(s)</span>
      </button>
    `,
    )
    .join('');

  container.querySelectorAll('[data-select-skill]').forEach((btn) => {
    btn.addEventListener('click', () => loadSkillIntoEditor(btn.dataset.selectSkill));
  });
}

async function openSkillInEditor(skillName) {
  switchView('skills');
  await loadSkillIntoEditor(skillName);
}

async function loadSkillIntoEditor(skillName) {
  try {
    const data = await api(
      `/api/skills/${encodeURIComponent(skillName)}?scope=${encodeURIComponent(state.scope)}`,
    );
    state.selectedSkill = skillName;
    state.selectedSkillData = data;
    renderEditorSkillList();

    document.getElementById('editor-title').textContent = data.skillName;
    document.getElementById('editor-meta').textContent = data.isCanonical
      ? `Canonical store · ${data.sourcePath}`
      : `Not yet in canonical store (saving imports it into canonical store)`;
    document.getElementById('editor-tokens').textContent =
      `${data.parse?.frontmatterTokens ?? 0} frontmatter tok`;

    const files = data.group?.canonical?.files || data.group?.instances?.[0]?.files || [];
    document.getElementById('editor-files').innerHTML = files
      .map((f) => `<span class="mono-pill">${escapeHtml(f)}</span>`)
      .join('');

    const textarea = document.getElementById('editor-textarea');
    textarea.disabled = false;
    textarea.value = data.content || '';
    document.getElementById('btn-save-skill').disabled = false;
    document.getElementById('btn-save-sync-skill').disabled = false;

    renderEditorDiagnostics(data.parse);
  } catch (err) {
    showToast(err.message, true);
  }
}

function renderEditorDiagnostics(parse) {
  const box = document.getElementById('editor-diagnostics');
  if (!parse) {
    box.innerHTML = '';
    return;
  }
  const all = [...(parse.errors || []), ...(parse.warnings || [])];
  if (all.length === 0) {
    box.innerHTML =
      '<div style="font-size:12px;color:var(--ok-fg);">Valid SKILL.md frontmatter.</div>';
    return;
  }
  box.innerHTML = all
    .map(
      (d) => `
      <div style="font-size:12px;color:${d.severity === 'error' ? 'var(--danger-fg)' : 'var(--warn-fg)'};">
        <strong>[${escapeHtml(d.code)}]</strong> ${d.line ? `Line ${d.line}: ` : ''}${escapeHtml(d.message)}
      </div>
    `,
    )
    .join('');
}

async function saveSelectedSkill(syncAfter) {
  if (!state.selectedSkill) return;
  const content = document.getElementById('editor-textarea').value;
  try {
    const res = await api(`/api/skills/${encodeURIComponent(state.selectedSkill)}`, {
      method: 'PUT',
      body: JSON.stringify({ scope: state.scope, content, syncAfter }),
    });
    renderEditorDiagnostics(res.parse);
    document.getElementById('editor-tokens').textContent =
      `${res.parse?.frontmatterTokens ?? 0} frontmatter tok`;
    showToast(
      syncAfter
        ? `Saved "${state.selectedSkill}" and synced agents`
        : `Saved "${state.selectedSkill}"`,
    );
    await loadOverview();
  } catch (err) {
    showToast(err.message, true);
  }
}

async function renderConflicts() {
  const container = document.getElementById('conflicts-container');
  const items = getConflictItems();
  if (items.length === 0) {
    container.innerHTML =
      '<div class="empty-state">No diverged skills or sync conflicts. All agent copies agree.</div>';
    return;
  }

  container.innerHTML = items
    .map(
      (item, idx) => `
      <article class="diff-card" id="conflict-card-${idx}">
        <div class="diff-card-header">
          <div>
            <div class="inline-controls">
              <span class="mono" style="font-weight:600;font-size:14px;">${escapeHtml(item.skillName)}</span>
              <span class="badge ${item.kind === 'pull-upstream' ? 'badge-info' : 'badge-warn'}">${escapeHtml(item.kind)}</span>
            </div>
            <div class="muted" style="margin-top:3px;">${escapeHtml(item.reason)}</div>
          </div>
          <div class="inline-controls">
            ${
              item.kind === 'diverged'
                ? item.candidates
                    .map(
                      (c) =>
                        `<button type="button" class="btn btn-secondary btn-sm" data-adopt-skill="${escapeHtml(item.skillName)}" data-adopt-agent="${escapeHtml(c.agentId)}">Adopt ${escapeHtml(c.agentId)}</button>`,
                    )
                    .join('')
                : `
                  <button type="button" class="btn btn-secondary btn-sm" data-resolve-action="${escapeHtml(item.actionId)}" data-resolution="canonical">Keep Canonical</button>
                  <button type="button" class="btn btn-primary btn-sm" data-resolve-action="${escapeHtml(item.actionId)}" data-resolution="agent">Pull ${escapeHtml(item.agentId)}</button>
                `
            }
          </div>
        </div>
        <pre class="diff-pre" id="diff-body-${idx}">Loading diff...</pre>
      </article>
    `,
    )
    .join('');

  container.querySelectorAll('[data-adopt-skill]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await api('/api/adopt', {
          method: 'POST',
          body: JSON.stringify({
            scope: state.scope,
            skillName: btn.dataset.adoptSkill,
            fromAgentId: btn.dataset.adoptAgent,
          }),
        });
        showToast(`Adopted ${btn.dataset.adoptSkill} from ${btn.dataset.adoptAgent}`);
        await loadOverview();
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });

  container.querySelectorAll('[data-resolve-action]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await api('/api/sync', {
          method: 'POST',
          body: JSON.stringify({
            scope: state.scope,
            perActionResolution: {
              [btn.dataset.resolveAction]: btn.dataset.resolution,
            },
          }),
        });
        showToast(`Resolved conflict using ${btn.dataset.resolution}`);
        await loadOverview();
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });

  // Fetch diffs lazily
  items.forEach(async (item, idx) => {
    const pre = document.getElementById(`diff-body-${idx}`);
    if (!pre) return;
    try {
      const diffData = await api(
        `/api/diff?scope=${encodeURIComponent(state.scope)}&skill=${encodeURIComponent(item.skillName)}&left=${encodeURIComponent(item.left)}&right=${encodeURIComponent(item.right)}`,
      );
      pre.innerHTML = renderDiffHtml(diffData.diff.skillMdPatch);
    } catch (err) {
      pre.textContent = err.message;
    }
  });
}

function renderDoctorAndGit() {
  const data = state.overview;
  const issuesEl = document.getElementById('doctor-issues');
  if (data.doctor.issues.length === 0) {
    issuesEl.innerHTML =
      '<div class="empty-state">All checks passed across your skills and agents.</div>';
  } else {
    issuesEl.innerHTML = data.doctor.issues
      .map((issue) => {
        const cls =
          issue.severity === 'error'
            ? 'badge-danger'
            : issue.severity === 'warning'
              ? 'badge-warn'
              : 'badge-info';
        return `
          <div class="issue-row">
            <div class="issue-top">
              <span class="badge ${cls}">${escapeHtml(issue.severity)}</span>
              <span class="mono-pill">${escapeHtml(issue.code)}</span>
              ${issue.skillName ? `<strong class="mono" style="font-size:12.5px;">${escapeHtml(issue.skillName)}</strong>` : ''}
            </div>
            <div style="font-size:13px;">${escapeHtml(issue.message)}</div>
            ${issue.hint ? `<div class="muted">&rarr; ${escapeHtml(issue.hint)}</div>` : ''}
          </div>
        `;
      })
      .join('');
  }

  const budgetsEl = document.getElementById('token-budget-list');
  const threshold = data.config.tokenBudgetWarning || 4000;
  if (data.doctor.tokenBudgets.length === 0) {
    budgetsEl.innerHTML = '<div class="muted">No active agents in this scope.</div>';
  } else {
    budgetsEl.innerHTML = data.doctor.tokenBudgets
      .map((b) => {
        const pct = Math.min(100, Math.round((b.frontmatterTokens / threshold) * 100));
        return `
          <div class="meter-row">
            <div class="meter-label">
              <span>${escapeHtml(b.agentName)} (${b.skillCount})</span>
              <span class="mono">${b.frontmatterTokens} / ${threshold} tok</span>
            </div>
            <div class="meter-track">
              <div class="meter-fill ${b.exceedsBudget ? 'warn' : ''}" style="width:${pct}%"></div>
            </div>
          </div>
        `;
      })
      .join('');
  }

  const git = data.git;
  document.getElementById('git-status-summary').innerHTML = `
    <div>Repo: ${git.isRepo ? 'initialized' : 'not initialized'} (${escapeHtml(git.branch || 'main')})</div>
    <div>Remote: ${escapeHtml(git.remoteUrl || 'not configured')}</div>
    <div>Dirty files: ${git.dirtyFiles.length}</div>
    ${git.lastCommit ? `<div>HEAD: ${escapeHtml(git.lastCommit.hash)} ${escapeHtml(git.lastCommit.subject)}</div>` : ''}
  `;
  const remoteInput = document.getElementById('git-remote-input');
  if (git.remoteUrl && !remoteInput.value) {
    remoteInput.value = git.remoteUrl;
  }
}

function switchView(viewName) {
  state.view = viewName;
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === viewName);
  });
  document.querySelectorAll('.view').forEach((sec) => {
    sec.classList.toggle('active', sec.id === `view-${viewName}`);
  });
  const meta = VIEW_META[viewName];
  if (meta) {
    document.getElementById('view-title').textContent = meta.title;
    document.getElementById('view-subtitle').textContent = meta.subtitle;
  }
}

function wireEvents() {
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  document.querySelectorAll('.scope-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      state.scope = btn.dataset.scope;
      state.selectedSkill = null;
      document.querySelectorAll('.scope-btn').forEach((b) => {
        b.classList.toggle('active', b.dataset.scope === state.scope);
      });
      await loadOverview();
    });
  });

  document.getElementById('btn-refresh').addEventListener('click', () => loadOverview());

  document.getElementById('btn-adopt-all').addEventListener('click', async () => {
    try {
      const res = await api('/api/adopt', {
        method: 'POST',
        body: JSON.stringify({ scope: state.scope }),
      });
      showToast(`Adopted ${res.adopted.length} skill(s) into canonical store`);
      await loadOverview();
    } catch (err) {
      showToast(err.message, true);
    }
  });

  document.getElementById('btn-sync-now').addEventListener('click', async () => {
    try {
      const res = await api('/api/sync', {
        method: 'POST',
        body: JSON.stringify({ scope: state.scope, conflictStrategy: 'skip' }),
      });
      const r = res.result;
      showToast(
        `Sync complete: ${r.applied.length} updated, ${r.pulled.length} pulled, ${r.conflictsRemaining.length} conflict(s)`,
      );
      await loadOverview();
    } catch (err) {
      showToast(err.message, true);
    }
  });

  document.getElementById('matrix-search').addEventListener('input', (e) => {
    state.matrixFilter = e.target.value;
    renderMatrix();
  });

  document.getElementById('editor-search').addEventListener('input', (e) => {
    state.editorFilter = e.target.value;
    renderEditorSkillList();
  });

  document
    .getElementById('btn-save-skill')
    .addEventListener('click', () => saveSelectedSkill(false));
  document
    .getElementById('btn-save-sync-skill')
    .addEventListener('click', () => saveSelectedSkill(true));

  document.getElementById('btn-doctor-fix').addEventListener('click', async () => {
    try {
      const res = await api('/api/doctor/fix', {
        method: 'POST',
        body: JSON.stringify({ scope: state.scope }),
      });
      showToast(
        res.fixed.length > 0
          ? `Fixed ${res.fixed.length} issue(s)`
          : 'No automatically fixable issues found',
      );
      await loadOverview();
    } catch (err) {
      showToast(err.message, true);
    }
  });

  document.getElementById('git-remote-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = document.getElementById('git-remote-input').value.trim();
    if (!url) return;
    try {
      await api('/api/git/remote', {
        method: 'POST',
        body: JSON.stringify({ scope: state.scope, url }),
      });
      showToast('Configured Git remote');
      await loadOverview();
    } catch (err) {
      showToast(err.message, true);
    }
  });

  document.getElementById('btn-git-push').addEventListener('click', async () => {
    try {
      const res = await api('/api/git/push', {
        method: 'POST',
        body: JSON.stringify({ scope: state.scope }),
      });
      showToast(res.summary);
      await loadOverview();
    } catch (err) {
      showToast(err.message, true);
    }
  });

  document.getElementById('btn-git-pull').addEventListener('click', async () => {
    try {
      await api('/api/git/pull', {
        method: 'POST',
        body: JSON.stringify({ scope: state.scope, syncAfter: true }),
      });
      showToast('Pulled latest skills from Git and synced agents');
      await loadOverview();
    } catch (err) {
      showToast(err.message, true);
    }
  });

  // New Skill Modal
  const modal = document.getElementById('new-skill-modal');
  document.getElementById('btn-new-skill').addEventListener('click', () => modal.showModal());
  document.getElementById('btn-close-modal').addEventListener('click', () => modal.close());
  document.getElementById('btn-cancel-modal').addEventListener('click', () => modal.close());

  document.getElementById('new-skill-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('new-skill-name').value.trim();
    const description = document.getElementById('new-skill-desc').value.trim();
    const tags = document
      .getElementById('new-skill-tags')
      .value.split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const instructions = document.getElementById('new-skill-body').value;

    try {
      await api('/api/skills', {
        method: 'POST',
        body: JSON.stringify({ scope: state.scope, name, description, tags, instructions }),
      });
      modal.close();
      e.target.reset();
      showToast(`Created skill "${name}"`);
      await loadOverview();
      await openSkillInEditor(name);
    } catch (err) {
      showToast(err.message, true);
    }
  });
}

wireEvents();
loadOverview();
