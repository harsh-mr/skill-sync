import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const IGNORED_BUNDLE_ENTRIES = new Set([
  '.DS_Store',
  'Thumbs.db',
  '.git',
  'node_modules',
  '.skill-sync-meta.json',
]);

export interface BundleHashResult {
  hash: string;
  files: string[];
  latestMtimeMs: number;
}

function toPosixPath(relPath: string): string {
  return relPath.split(path.sep).join('/');
}

export function listBundleFiles(dirPath: string): string[] {
  const results: string[] = [];

  function walk(currentDir: string, relBase: string): void {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (IGNORED_BUNDLE_ENTRIES.has(entry.name)) {
        continue;
      }
      const absPath = path.join(currentDir, entry.name);
      const relPath = relBase ? path.join(relBase, entry.name) : entry.name;

      let stat: fs.Stats;
      try {
        stat = fs.statSync(absPath);
      } catch {
        // Broken symlink inside bundle; record the path so hash captures its presence.
        results.push(toPosixPath(relPath));
        continue;
      }

      if (stat.isDirectory()) {
        walk(absPath, relPath);
      } else if (stat.isFile()) {
        results.push(toPosixPath(relPath));
      }
    }
  }

  walk(dirPath, '');
  results.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return results;
}

export function hashSkillBundle(dirPath: string): BundleHashResult {
  const files = listBundleFiles(dirPath);
  const hash = crypto.createHash('sha256');
  let latestMtimeMs = 0;

  try {
    latestMtimeMs = fs.statSync(dirPath).mtimeMs;
  } catch {
    latestMtimeMs = 0;
  }

  for (const relPosix of files) {
    const absPath = path.join(dirPath, ...relPosix.split('/'));
    hash.update(relPosix);
    hash.update('\0');
    try {
      const stat = fs.statSync(absPath);
      if (stat.mtimeMs > latestMtimeMs) {
        latestMtimeMs = stat.mtimeMs;
      }
      const content = fs.readFileSync(absPath);
      hash.update(content);
    } catch {
      hash.update('__UNREADABLE__');
    }
    hash.update('\0');
  }

  return {
    hash: hash.digest('hex'),
    files,
    latestMtimeMs,
  };
}
