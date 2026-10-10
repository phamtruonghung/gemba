#!/usr/bin/env node
// scripts/import-notes.mjs — bring markdown notes into the corpus as seed material.
//
// Usage:
//   node scripts/import-notes.mjs <srcDir> <outDir> [topicMap.json]
//
// topicMap.json: { "file-basename.md": "topic-slug", ... } — anything not listed lands under "khac".
// The source files are copied verbatim (body untouched) with frontmatter added: title (from the H1),
// topic, origin, and the path the note came from, so the corpus page can say where it came from.

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

const [srcDir, outDir, mapPath] = process.argv.slice(2);
if (!srcDir || !outDir) {
  console.error('usage: node scripts/import-notes.mjs <srcDir> <outDir> [topicMap.json]');
  process.exit(2);
}
const topicMap = mapPath && existsSync(mapPath) ? JSON.parse(readFileSync(mapPath, 'utf8')) : {};
mkdirSync(outDir, { recursive: true });

const SKIP = new Set(['index.md', 'log.md', 'SCHEMA.md', 'board.md']);
const files = readdirSync(srcDir).filter((f) => f.endsWith('.md') && !SKIP.has(f));
const written = [];

// The portable lessons in a company-scoped vault carry back-links into that scope
// (`src: relats/raw/daily/...`). The craft is publishable; the pointer to the employer's
// scope is not, and the gate blocks it. So the corpus copy drops the provenance pointer
// instead of weakening the rule — the fact of the removal is reported, not hidden.
function stripCompanyCitations(text) {
  let removed = 0;
  const out = text.replace(/\s*`?src:\s*[^`\n]*relats\/[^`\n]*`?/g, () => {
    removed += 1;
    return '';
  });
  return { out: out.replace(/\brelats\/[\w./-]*/g, '').replace(/[ \t]+\n/g, '\n'), removed };
}

for (const f of files) {
  const raw = readFileSync(join(srcDir, f), 'utf8');
  const body = raw.replace(/^---\n[\s\S]*?\n---\n/, '');
  const h1 = /^#\s+(.+)$/m.exec(body);
  const title = h1 ? h1[1].trim() : basename(f, '.md').replace(/-/g, ' ');
  const topic = topicMap[f] ?? 'khac';
  const { out: cleaned, removed } = stripCompanyCitations(body);
  const out = `---\ntitle: ${title}\ntopic: ${topic}\norigin: vault\nsource: ${srcDir}/${f}\n---\n\n${cleaned.trim()}\n`;
  const target = join(outDir, `vault-${basename(f, '.md')}.md`);
  writeFileSync(target, out);
  written.push({ target, topic, chars: body.length, removed });
}

console.log(`imported ${written.length} note(s) into ${outDir}`);
for (const w of written) console.log(`  ${w.topic.padEnd(16)} ${String(w.chars).padStart(6)} chars  company-citations stripped: ${w.removed}  ${w.target}`);
