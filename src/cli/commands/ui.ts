import { spawn } from 'node:child_process';
import { serve } from '@hono/node-server';
import pc from 'picocolors';
import { createApp } from '../../server/app.js';

export interface UiCommandOptions {
  port?: string;
  host?: string;
  project?: boolean;
  store?: string;
  open?: boolean;
  home?: string;
  cwd?: string;
}

function openBrowser(url: string): void {
  try {
    const cmd =
      process.platform === 'darwin'
        ? 'open'
        : process.platform === 'win32'
          ? 'cmd'
          : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.unref();
  } catch {
    // Headless or browser unavailable; URL is already printed cleanly.
  }
}

export function runUiCommand(opts: UiCommandOptions): void {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ? Number(opts.port) : 4319;
  const defaultScope = opts.project ? 'project' : 'global';

  const app = createApp({
    homeDir: opts.home,
    cwd: opts.cwd,
    storeDir: opts.store,
    defaultScope,
  });

  const server = serve(
    {
      fetch: app.fetch,
      hostname: host,
      port: Number.isFinite(port) ? port : 4319,
    },
    (info) => {
      const url = `http://${host}:${info.port}`;
      console.log('');
      console.log(pc.bold('skill-sync ui') + pc.dim(` (${defaultScope})`));
      console.log(`  ${pc.green('●')} Local server ready at ${pc.cyan(url)}`);
      console.log(pc.dim('  Press Ctrl+C to stop.\n'));

      if (opts.open !== false && process.stdout.isTTY) {
        openBrowser(url);
      }
    },
  );

  const shutdown = () => {
    console.log(pc.dim('\nStopping local UI server...'));
    server.close(() => process.exit(0));
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
