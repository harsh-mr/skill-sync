import { Command } from 'commander';
import { runAdoptCommand } from './commands/adopt.js';
import { runDoctorCommand } from './commands/doctor.js';
import {
  runPullCommand,
  runPushCommand,
  runRemoteCommand,
} from './commands/git.js';
import { runScanCommand } from './commands/scan.js';
import { runStatusCommand } from './commands/status.js';
import { runSyncCommand } from './commands/sync.js';
import { runUiCommand } from './commands/ui.js';
import { runWatchCommand } from './commands/watch.js';

export function buildProgram(): Command {
  const program = new Command();

  program
    .name('skill-sync')
    .description(
      'Discover, consolidate, lint, and sync SKILL.md bundles across coding agents.',
    )
    .version('0.1.0');

  program
    .command('scan')
    .description('Discover skills across installed coding agents and canonical store')
    .option('-p, --project', 'Scan project-level skill folders instead of global')
    .option('-a, --all', 'Scan both global and project-level skill folders')
    .option('--agents <list>', 'Comma-separated agent IDs to include')
    .option('--store <dir>', 'Override canonical store directory')
    .option('--json', 'Output machine-readable JSON')
    .action((opts) => runScanCommand(opts));

  program
    .command('adopt')
    .description('Consolidate discovered skills from agents into the canonical store')
    .option('-p, --project', 'Adopt project-level skills into .skill-sync/')
    .option('--agents <list>', 'Comma-separated agent IDs to scan')
    .option('--store <dir>', 'Override canonical store directory')
    .option('-y, --yes', 'Non-interactive mode (auto-accept non-conflicting skills)')
    .option(
      '--strategy <strategy>',
      'Diverged skill strategy in non-interactive mode: newest | skip',
      'skip',
    )
    .option('--dry-run', 'Preview adoption without writing files')
    .option('--json', 'Output machine-readable JSON')
    .action((opts) => runAdoptCommand(opts));

  program
    .command('sync')
    .description('Sync canonical skills across enabled coding agents')
    .option('-p, --project', 'Sync project-level skill folders')
    .option('--agents <list>', 'Comma-separated agent IDs to sync')
    .option('--store <dir>', 'Override canonical store directory')
    .option('--mode <mode>', 'Override sync mode: symlink | copy')
    .option('--dry-run', 'Preview planned changes without writing files')
    .option('--prune', 'Remove previously synced skills no longer in canonical/profile')
    .option('--no-pull', 'Do not auto-pull upstream edits made directly in agent folders')
    .option(
      '--conflict <strategy>',
      'Conflict resolution strategy: skip | canonical | agent',
    )
    .option(
      '--bridge-rules',
      'Mirror project AGENTS.md -> CLAUDE.md when running in --project mode',
    )
    .option('-y, --yes', 'Skip interactive prompts')
    .option('--json', 'Output machine-readable JSON')
    .action((opts) => runSyncCommand(opts));

  program
    .command('doctor')
    .description(
      'Lint SKILL.md frontmatter, check broken links/symlinks, and audit token budgets',
    )
    .option('-p, --project', 'Check project-level skills')
    .option('-a, --all', 'Check both global and project-level skills')
    .option('--agents <list>', 'Comma-separated agent IDs to check')
    .option('--store <dir>', 'Override canonical store directory')
    .option('--fix', 'Apply safe mechanical fixes (e.g. remove dangling symlinks)')
    .option('--json', 'Output machine-readable JSON')
    .action((opts) => runDoctorCommand(opts));

  program
    .command('status')
    .description(
      'Show concise overview of detected agents, skills, and pending sync actions',
    )
    .option('-p, --project', 'Inspect project-level status')
    .option('--agents <list>', 'Comma-separated agent IDs to inspect')
    .option('--store <dir>', 'Override canonical store directory')
    .option('--json', 'Output machine-readable JSON')
    .action((opts) => runStatusCommand(opts));

  program
    .command('watch')
    .description('Watch canonical store and agent folders for live two-way syncing')
    .option('-p, --project', 'Watch project-level skill folders')
    .option('--agents <list>', 'Comma-separated agent IDs to watch')
    .option('--store <dir>', 'Override canonical store directory')
    .option('--mode <mode>', 'Override sync mode: symlink | copy')
    .option('--no-pull', 'Disable pulling upstream edits from agent folders')
    .option('--debounce <ms>', 'Debounce delay in milliseconds', '300')
    .action((opts) => runWatchCommand(opts));

  program
    .command('remote [url]')
    .description('Inspect or configure Git remote URL for multi-machine store sync')
    .option('-p, --project', 'Target project .skill-sync store')
    .option('--store <dir>', 'Override canonical store directory')
    .option('--remote <name>', 'Git remote name', 'origin')
    .option('--json', 'Output machine-readable JSON')
    .action((url, opts) => runRemoteCommand(url, opts));

  program
    .command('push')
    .description('Commit and push canonical skills & config to your configured Git remote')
    .option('-p, --project', 'Target project .skill-sync store')
    .option('--store <dir>', 'Override canonical store directory')
    .option('--remote <name>', 'Git remote name', 'origin')
    .option('--branch <name>', 'Git branch name')
    .option('-m, --message <msg>', 'Custom commit message')
    .option('--dry-run', 'Preview without committing or pushing')
    .option('--json', 'Output machine-readable JSON')
    .action((opts) => runPushCommand(opts));

  program
    .command('pull')
    .description('Pull latest canonical skills from Git remote and sync agents')
    .option('-p, --project', 'Target project .skill-sync store')
    .option('--store <dir>', 'Override canonical store directory')
    .option('--remote <name>', 'Git remote name', 'origin')
    .option('--branch <name>', 'Git branch name')
    .option('--no-sync-after', 'Pull from Git without running agent sync afterwards')
    .option('--json', 'Output machine-readable JSON')
    .action((opts) => runPullCommand(opts));

  program
    .command('ui')
    .description('Launch the local companion Web UI for visual skill management')
    .option('--port <port>', 'Port to listen on', '4319')
    .option('--host <host>', 'Host interface to bind', '127.0.0.1')
    .option('-p, --project', 'Default UI to project-level scope')
    .option('--store <dir>', 'Override canonical store directory')
    .option('--no-open', 'Do not automatically open the browser')
    .action((opts) => runUiCommand(opts));

  return program;
}

const program = buildProgram();
program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
