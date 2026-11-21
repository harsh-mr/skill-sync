import pc from 'picocolors';
import { runDoctor } from '../../core/doctor.js';
import type { Scope } from '../../core/types.js';
import { parseCsvOption } from '../format.js';

export interface DoctorCommandOptions {
  project?: boolean;
  all?: boolean;
  agents?: string;
  store?: string;
  fix?: boolean;
  json?: boolean;
  home?: string;
  cwd?: string;
}

export function runDoctorCommand(opts: DoctorCommandOptions): void {
  const scope: Scope = opts.all ? 'all' : opts.project ? 'project' : 'global';
  const { report, fixed } = runDoctor({
    scope,
    agentIds: parseCsvOption(opts.agents),
    storeDir: opts.store,
    fix: Boolean(opts.fix),
    homeDir: opts.home,
    cwd: opts.cwd,
  });

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ report, fixed }, null, 2)}\n`);
    if (report.summary.errors > 0) {
      process.exitCode = 1;
    }
    return;
  }

  console.log('');
  console.log(pc.bold('skill-sync doctor') + pc.dim(` (${report.scope})`));
  console.log('');

  if (fixed.length > 0) {
    for (const msg of fixed) {
      console.log(`  ${pc.green('✓ fixed')} ${msg}`);
    }
    console.log('');
  }

  if (report.issues.length === 0) {
    console.log(
      pc.green(`All checks passed across ${report.summary.skillsChecked} skill(s).\n`),
    );
    return;
  }

  for (const issue of report.issues) {
    const badge =
      issue.severity === 'error'
        ? pc.red('ERROR')
        : issue.severity === 'warning'
          ? pc.yellow('WARN ')
          : pc.cyan('INFO ');

    const loc = [
      issue.skillName ? pc.bold(issue.skillName) : null,
      issue.agentId ? pc.dim(`(${issue.agentId})`) : null,
      issue.line ? pc.dim(`line ${issue.line}`) : null,
    ]
      .filter(Boolean)
      .join(' ');

    console.log(`  ${badge} ${pc.dim(`[${issue.code}]`)} ${loc ? `${loc}: ` : ''}${issue.message}`);
    if (issue.hint) {
      console.log(`        ${pc.dim(`→ ${issue.hint}`)}`);
    }
  }

  console.log('');
  const s = report.summary;
  console.log(
    pc.dim('Checked ') +
      `${s.skillsChecked} skill(s): ` +
      [
        s.errors > 0 ? pc.red(`${s.errors} error(s)`) : pc.green('0 errors'),
        s.warnings > 0 ? pc.yellow(`${s.warnings} warning(s)`) : pc.dim('0 warnings'),
        s.info > 0 ? pc.cyan(`${s.info} info`) : pc.dim('0 info'),
      ].join(pc.dim(' · ')),
  );
  console.log('');

  if (s.errors > 0) {
    process.exitCode = 1;
  }
}
