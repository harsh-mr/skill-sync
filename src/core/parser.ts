import fs from 'node:fs';
import path from 'node:path';
import { parseDocument } from 'yaml';
import type {
  ParseDiagnostic,
  SkillFrontmatter,
  SkillParseResult,
} from './types.js';

export const SKILL_NAME_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_SKILL_NAME_LENGTH = 64;
export const MAX_SKILL_DESCRIPTION_LENGTH = 1024;

export function estimateTokens(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) {
    return 0;
  }
  return Math.ceil(trimmed.length / 4);
}

/**
 * Extract relative references to bundled skill resources (scripts/, references/, assets/, templates/).
 */
export function extractResourceReferences(markdown: string): string[] {
  const refs = new Set<string>();

  // Markdown links: [label](scripts/foo.sh) or [label](./references/bar.md)
  const linkRegex = /\[[^\]]*\]\(\s*(?:\.\/)?((?:scripts|references|assets|templates)\/[^)\s#?]+)/g;
  for (const match of markdown.matchAll(linkRegex)) {
    const captured = match[1];
    if (captured) {
      refs.add(captured);
    }
  }

  // Inline code references: `scripts/foo.py` or `references/guide.md`
  const codeRegex = /`(?:\.\/)?((?:scripts|references|assets|templates)\/[A-Za-z0-9._/-]+)`/g;
  for (const match of markdown.matchAll(codeRegex)) {
    const captured = match[1];
    if (captured && !captured.endsWith('/')) {
      refs.add(captured);
    }
  }

  return [...refs].sort();
}

function normalizeTags(rawTags: unknown): string[] {
  if (Array.isArray(rawTags)) {
    return rawTags
      .filter((t): t is string => typeof t === 'string')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
  }
  if (typeof rawTags === 'string') {
    return rawTags
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
  }
  return [];
}

export function parseSkillMarkdown(
  content: string,
  options: { expectedName?: string; filePath?: string } = {},
): SkillParseResult {
  const errors: ParseDiagnostic[] = [];
  const warnings: ParseDiagnostic[] = [];
  const file = options.filePath ?? 'SKILL.md';

  const normalized = content.replace(/\r\n/g, '\n');
  const totalTokens = estimateTokens(normalized);

  if (!normalized.startsWith('---\n') && normalized !== '---') {
    errors.push({
      code: 'MISSING_FRONTMATTER',
      severity: 'error',
      message: 'SKILL.md must begin with YAML frontmatter delimited by ---',
      line: 1,
      column: 1,
      file,
    });
    return {
      valid: false,
      frontmatter: null,
      body: normalized,
      errors,
      warnings,
      frontmatterTokens: 0,
      totalTokens,
      referencedPaths: extractResourceReferences(normalized),
    };
  }

  const lines = normalized.split('\n');
  let closingIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line !== undefined && line.trim() === '---') {
      closingIndex = i;
      break;
    }
  }

  if (closingIndex === -1) {
    errors.push({
      code: 'UNCLOSED_FRONTMATTER',
      severity: 'error',
      message: 'YAML frontmatter opening --- is not closed with a matching ---',
      line: 1,
      column: 1,
      file,
    });
    return {
      valid: false,
      frontmatter: null,
      body: normalized,
      errors,
      warnings,
      frontmatterTokens: 0,
      totalTokens,
      referencedPaths: extractResourceReferences(normalized),
    };
  }

  const yamlSource = lines.slice(1, closingIndex).join('\n');
  const body = lines.slice(closingIndex + 1).join('\n').trim();
  const referencedPaths = extractResourceReferences(body);

  const doc = parseDocument(yamlSource, { prettyErrors: false });

  if (doc.errors.length > 0) {
    for (const err of doc.errors) {
      const pos = err.linePos?.[0];
      errors.push({
        code: 'INVALID_YAML',
        severity: 'error',
        message: `YAML syntax error: ${err.message}`,
        line: pos ? pos.line + 1 : 2,
        column: pos ? pos.col : 1,
        file,
      });
    }
    return {
      valid: false,
      frontmatter: null,
      body,
      errors,
      warnings,
      frontmatterTokens: estimateTokens(yamlSource),
      totalTokens,
      referencedPaths,
    };
  }

  const rawValue = doc.toJS();
  if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) {
    errors.push({
      code: 'INVALID_FRONTMATTER_TYPE',
      severity: 'error',
      message: 'YAML frontmatter must be a key-value mapping',
      line: 2,
      column: 1,
      file,
    });
    return {
      valid: false,
      frontmatter: null,
      body,
      errors,
      warnings,
      frontmatterTokens: estimateTokens(yamlSource),
      totalTokens,
      referencedPaths,
    };
  }

  const raw = rawValue as Record<string, unknown>;
  const name = typeof raw.name === 'string' ? raw.name.trim() : undefined;
  const description =
    typeof raw.description === 'string' ? raw.description.trim() : undefined;

  if (!name) {
    errors.push({
      code: 'MISSING_NAME',
      severity: 'error',
      message: 'Frontmatter is missing required field "name"',
      line: 2,
      file,
    });
  } else {
    if (name.length > MAX_SKILL_NAME_LENGTH) {
      errors.push({
        code: 'NAME_TOO_LONG',
        severity: 'error',
        message: `Skill name "${name}" exceeds ${MAX_SKILL_NAME_LENGTH} characters (${name.length})`,
        file,
      });
    }
    if (!SKILL_NAME_REGEX.test(name)) {
      errors.push({
        code: 'INVALID_NAME_FORMAT',
        severity: 'error',
        message: `Skill name "${name}" must be lowercase kebab-case (a-z, 0-9, hyphens)`,
        file,
      });
    }
    if (options.expectedName && name !== options.expectedName) {
      warnings.push({
        code: 'NAME_FOLDER_MISMATCH',
        severity: 'warning',
        message: `Frontmatter name "${name}" does not match folder name "${options.expectedName}"`,
        file,
      });
    }
  }

  if (!description) {
    errors.push({
      code: 'MISSING_DESCRIPTION',
      severity: 'error',
      message: 'Frontmatter is missing required field "description"',
      line: 2,
      file,
    });
  } else if (description.length > MAX_SKILL_DESCRIPTION_LENGTH) {
    errors.push({
      code: 'DESCRIPTION_TOO_LONG',
      severity: 'error',
      message: `Skill description exceeds ${MAX_SKILL_DESCRIPTION_LENGTH} characters (${description.length})`,
      file,
    });
  }

  if (!body) {
    warnings.push({
      code: 'EMPTY_BODY',
      severity: 'warning',
      message: 'SKILL.md has an empty instruction body below frontmatter',
      file,
    });
  }

  const tags = normalizeTags(raw.tags ?? (raw.metadata as Record<string, unknown> | undefined)?.tags);
  const license = typeof raw.license === 'string' ? raw.license : undefined;
  const allowedTools =
    typeof raw['allowed-tools'] === 'string' || Array.isArray(raw['allowed-tools'])
      ? (raw['allowed-tools'] as string | string[])
      : undefined;

  const frontmatter: SkillFrontmatter = {
    name,
    description,
    tags,
    license,
    allowedTools,
    raw,
  };

  // Passive context overhead is the name + description loaded into agent system prompts.
  const frontmatterTokens = estimateTokens(`${name ?? ''}\n${description ?? ''}`);

  return {
    valid: errors.length === 0,
    frontmatter,
    body,
    errors,
    warnings,
    frontmatterTokens,
    totalTokens,
    referencedPaths,
  };
}

export function parseSkillFile(
  skillDir: string,
  expectedName?: string,
): SkillParseResult | null {
  const skillMdPath = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(skillMdPath)) {
    return null;
  }
  const content = fs.readFileSync(skillMdPath, 'utf8');
  return parseSkillMarkdown(content, {
    expectedName: expectedName ?? path.basename(skillDir),
    filePath: skillMdPath,
  });
}
