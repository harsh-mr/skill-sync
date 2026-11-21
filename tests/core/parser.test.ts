import { describe, expect, it } from 'vitest';
import { parseSkillMarkdown } from '../../src/core/parser.js';

describe('parseSkillMarkdown', () => {
  it('parses valid SKILL.md frontmatter, tags, tokens, and resource references', () => {
    const md = `---
name: api-debugger
description: "Diagnose HTTP and GraphQL API failures with structured traces."
tags: [backend, debugging]
allowed-tools: Bash, Read
---

# API Debugger

Run \`scripts/check-health.sh\` and consult [error codes](references/errors.md).
`;
    const res = parseSkillMarkdown(md, { expectedName: 'api-debugger' });
    expect(res.valid).toBe(true);
    expect(res.errors).toHaveLength(0);
    expect(res.warnings).toHaveLength(0);
    expect(res.frontmatter?.name).toBe('api-debugger');
    expect(res.frontmatter?.tags).toEqual(['backend', 'debugging']);
    expect(res.frontmatterTokens).toBeGreaterThan(10);
    expect(res.referencedPaths).toEqual([
      'references/errors.md',
      'scripts/check-health.sh',
    ]);
  });

  it('catches unquoted YAML colon syntax errors with line numbers', () => {
    const md = `---
name: broken-yaml
description: Use when: debugging production errors
---

Body here.
`;
    const res = parseSkillMarkdown(md, { expectedName: 'broken-yaml' });
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.code === 'INVALID_YAML')).toBe(true);
    expect(res.errors[0]?.line).toBeGreaterThanOrEqual(2);
  });

  it('flags invalid uppercase skill names and folder mismatches', () => {
    const md = `---
name: Bad_Name
description: "Some valid description"
---

Instructions.
`;
    const res = parseSkillMarkdown(md, { expectedName: 'bad-name' });
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.code === 'INVALID_NAME_FORMAT')).toBe(true);
    expect(res.warnings.some((w) => w.code === 'NAME_FOLDER_MISMATCH')).toBe(true);
  });

  it('reports missing frontmatter cleanly', () => {
    const res = parseSkillMarkdown('# No Frontmatter\n\nJust markdown.');
    expect(res.valid).toBe(false);
    expect(res.errors[0]?.code).toBe('MISSING_FRONTMATTER');
  });
});
