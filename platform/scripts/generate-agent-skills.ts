import { readFileSync, writeFileSync } from 'node:fs';
const source = new URL('../src/agents/research/skills/visual-inspection/SKILL.md', import.meta.url);
const target = new URL('../src/agents/research/skills/visual-inspection.generated.ts', import.meta.url);
const output = '// Generated from visual-inspection/SKILL.md. Run npx tsx scripts/generate-agent-skills.ts to update.\n'
  + 'export const VISUAL_INSPECTION_SKILL = ' + JSON.stringify(readFileSync(source, 'utf8')) + ';\n';
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== output) throw new Error('Visual inspection skill bundle is stale. Run npx tsx scripts/generate-agent-skills.ts.');
} else writeFileSync(target, output);
