import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ensureStore } from './store.js';

export interface GitStatusReport {
  isRepo: boolean;
  storeDir: string;
  branch: string | null;
  remoteName: string;
  remoteUrl: string | null;
  dirtyFiles: string[];
  ahead: number;
  behind: number;
  lastCommit: { hash: string; subject: string; date: string } | null;
}

export interface GitPushResult {
  committed: boolean;
  commitMessage?: string;
  pushed: boolean;
  branch: string;
  remoteUrl: string | null;
  summary: string;
}

export interface GitPullResult {
  pulled: boolean;
  branch: string;
  remoteUrl: string | null;
  output: string;
}

function runGit(storeDir: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: storeDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function tryGit(storeDir: string, args: string[]): string | null {
  try {
    return runGit(storeDir, args);
  } catch {
    return null;
  }
}

export function isGitRepo(storeDir: string): boolean {
  return fs.existsSync(path.join(storeDir, '.git'));
}

export function initGitRepo(storeDir: string, branch = 'main'): void {
  ensureStore(storeDir);
  if (isGitRepo(storeDir)) {
    return;
  }
  try {
    runGit(storeDir, ['init', '-b', branch]);
  } catch {
    // Older git versions without -b
    runGit(storeDir, ['init']);
    tryGit(storeDir, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
  }
}

export function setGitRemote(
  storeDir: string,
  remoteUrl: string,
  remoteName = 'origin',
): { remoteName: string; remoteUrl: string; initialized: boolean } {
  const wasRepo = isGitRepo(storeDir);
  initGitRepo(storeDir);

  const existing = tryGit(storeDir, ['remote', 'get-url', remoteName]);
  if (existing !== null) {
    runGit(storeDir, ['remote', 'set-url', remoteName, remoteUrl]);
  } else {
    runGit(storeDir, ['remote', 'add', remoteName, remoteUrl]);
  }

  return { remoteName, remoteUrl, initialized: !wasRepo };
}

export function getGitStatus(
  storeDir: string,
  remoteName = 'origin',
): GitStatusReport {
  if (!isGitRepo(storeDir)) {
    return {
      isRepo: false,
      storeDir,
      branch: null,
      remoteName,
      remoteUrl: null,
      dirtyFiles: [],
      ahead: 0,
      behind: 0,
      lastCommit: null,
    };
  }

  const branch =
    tryGit(storeDir, ['symbolic-ref', '--short', 'HEAD']) ??
    tryGit(storeDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const remoteUrl = tryGit(storeDir, ['remote', 'get-url', remoteName]);

  const porcelain = tryGit(storeDir, ['status', '--porcelain']) ?? '';
  const dirtyFiles = porcelain
    ? porcelain
        .split('\n')
        .map((line) => line.slice(3).trim())
        .filter(Boolean)
    : [];

  let ahead = 0;
  let behind = 0;
  const revCounts = tryGit(storeDir, [
    'rev-list',
    '--left-right',
    '--count',
    'HEAD...@{upstream}',
  ]);
  if (revCounts) {
    const [aStr, bStr] = revCounts.split(/\s+/);
    ahead = Number(aStr) || 0;
    behind = Number(bStr) || 0;
  }

  let lastCommit: GitStatusReport['lastCommit'] = null;
  const logLine = tryGit(storeDir, ['log', '-1', '--format=%h\t%s\t%cI']);
  if (logLine) {
    const [hash, subject, date] = logLine.split('\t');
    if (hash) {
      lastCommit = {
        hash,
        subject: subject ?? '',
        date: date ?? '',
      };
    }
  }

  return {
    isRepo: true,
    storeDir,
    branch,
    remoteName,
    remoteUrl,
    dirtyFiles,
    ahead,
    behind,
    lastCommit,
  };
}

export function pushStore(
  storeDir: string,
  options: {
    message?: string;
    remoteName?: string;
    branch?: string;
    dryRun?: boolean;
  } = {},
): GitPushResult {
  const remoteName = options.remoteName ?? 'origin';
  initGitRepo(storeDir);

  const branch =
    options.branch ??
    tryGit(storeDir, ['symbolic-ref', '--short', 'HEAD']) ??
    'main';
  const remoteUrl = tryGit(storeDir, ['remote', 'get-url', remoteName]);

  // Stage canonical skills, config, and .gitignore (state.json & .backups remain gitignored)
  const pathsToAdd = ['skills', 'config.json', '.gitignore'].filter((p) =>
    fs.existsSync(path.join(storeDir, p)),
  );
  if (pathsToAdd.length > 0 && !options.dryRun) {
    runGit(storeDir, ['add', '-A', '--', ...pathsToAdd]);
  }

  const staged = tryGit(storeDir, ['diff', '--cached', '--name-only']) ?? '';
  let committed = false;
  let commitMessage: string | undefined;

  if (staged.trim().length > 0) {
    commitMessage =
      options.message ??
      `chore(skill-sync): sync skills (${new Date().toISOString().slice(0, 16)})`;
    if (!options.dryRun) {
      runGit(storeDir, ['commit', '-m', commitMessage]);
    }
    committed = true;
  }

  if (!remoteUrl) {
    return {
      committed,
      commitMessage,
      pushed: false,
      branch,
      remoteUrl: null,
      summary: committed
        ? 'Committed locally (no git remote configured yet).'
        : 'Working tree clean (no git remote configured yet).',
    };
  }

  if (!options.dryRun) {
    runGit(storeDir, ['push', '-u', remoteName, branch]);
  }

  return {
    committed,
    commitMessage,
    pushed: true,
    branch,
    remoteUrl,
    summary: committed
      ? `Committed and pushed to ${remoteName}/${branch}.`
      : `Pushed existing commits to ${remoteName}/${branch}.`,
  };
}

export function pullStore(
  storeDir: string,
  options: {
    remoteName?: string;
    branch?: string;
    rebase?: boolean;
  } = {},
): GitPullResult {
  const remoteName = options.remoteName ?? 'origin';
  if (!isGitRepo(storeDir)) {
    throw new Error(
      `Canonical store ${storeDir} is not a git repository. Run "skill-sync remote <git-url>" first.`,
    );
  }

  const branch =
    options.branch ??
    tryGit(storeDir, ['symbolic-ref', '--short', 'HEAD']) ??
    'main';
  const remoteUrl = tryGit(storeDir, ['remote', 'get-url', remoteName]);
  if (!remoteUrl) {
    throw new Error(
      `No git remote "${remoteName}" configured in ${storeDir}. Run "skill-sync remote <git-url>".`,
    );
  }

  const args = ['pull'];
  if (options.rebase !== false) {
    args.push('--rebase');
  }
  args.push(remoteName, branch);

  const output = runGit(storeDir, args);
  return {
    pulled: true,
    branch,
    remoteUrl,
    output,
  };
}
