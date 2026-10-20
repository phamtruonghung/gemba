// The reading view: a note is markdown, and a person reading it should see prose, not syntax.
//
// The corpus is markdown (headings, bullets, blockquotes, a table), and the page used to print it
// escaped — `## Don't count the number` arrived on screen with the hashes. Rendering is therefore a
// real feature with a real safety rule: text is escaped FIRST and tags are built around it, so no note
// can inject HTML into the page, whoever wrote it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../src/markdown.mjs';

const NOTE = `# 5 Why — how to ask

## Don't count the number of questions

Five is an example number, not a rule. Stop when the answer points to something *fixable*.

## Three ways it usually drifts

- Drifting into personal blame.
- Going outside what you control.

Rules of the walk:

1. Ask from an observed fact.
2. Stop at something verifiable.

> A conclusion without an action is just a conversation.

| Step | Question |
| --- | --- |
| 1 | Why did it stop? |
| 2 | Why was it allowed to? |

See the [gate rules](https://example.com/rules) and the \`INSUFFICIENT_DATA\` marker.
`;

test('headings become real headings, and the note title is not repeated', () => {
  const html = renderMarkdown(NOTE, { title: '5 Why — how to ask' });
  assert.ok(!html.includes('# 5 Why'), 'the title line is dropped, not rendered');
  assert.match(html, /<h2 id="don-t-count-the-number-of-questions">Don't count the number of questions<a class="sec-anchor"/);
  assert.match(html, /<h2 id="three-ways-it-usually-drifts">Three ways it usually drifts<a class="sec-anchor"/);
  assert.ok(!html.includes('##'), 'no markdown heading syntax survives into the page');
});

test('lists, blockquotes and tables are structure, not text', () => {
  const html = renderMarkdown(NOTE);
  assert.match(html, /<ul>\s*<li>Drifting into personal blame\.<\/li>/);
  assert.match(html, /<ol>\s*<li>Ask from an observed fact\.<\/li>/);
  assert.match(html, /<blockquote>/);
  assert.match(html, /<table>[\s\S]*<th>Step<\/th>[\s\S]*<td>Why did it stop\?<\/td>/);
});

test('inline emphasis, code and links are rendered; a bad link scheme is refused', () => {
  const html = renderMarkdown(NOTE);
  assert.match(html, /<em>fixable<\/em>/);
  assert.match(html, /<code>INSUFFICIENT_DATA<\/code>/);
  assert.match(html, /<a href="https:\/\/example\.com\/rules"[^>]*>gate rules<\/a>/);
  const bad = renderMarkdown('[click](javascript:alert(1))');
  assert.ok(!bad.includes('<a '), 'a javascript: URL never becomes a link');
  assert.match(bad, /\[click\]\(javascript:alert\(1\)\)/);
});

test('a note cannot inject HTML into the page', () => {
  const evil = renderMarkdown('# T\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>\n\n**bold**');
  assert.ok(!/<script>alert/.test(evil), 'a script tag in a note stays literal text');
  assert.ok(!/<img /.test(evil), 'so does an image tag with an event handler');
  assert.match(evil, /&lt;script&gt;/, 'it is escaped, not silently deleted');
  assert.match(evil, /<strong>bold<\/strong>/, 'and real markdown still renders beside it');
});

test('a wiki reference becomes a link when the library has it, and a plain name when it does not', () => {
  // The vault names its own notes `<doi>[[how-open-work-is-managed]]`; the library stores that note as
  // `vault-how-open-work-is-managed`. Double brackets on screen are a wiki's syntax, not a sentence.
  const links = new Map([
    ['vault-how-open-work-is-managed', 'How open work is managed'],
    ['how-open-work-is-managed', 'How open work is managed']
  ]);
  const html = renderMarkdown('See [[how-open-work-is-managed]] and [[production-glossary]].', { links });
  assert.match(html, /<a href="\/notes\/how-open-work-is-managed">How open work is managed<\/a>/,
    'a reference the library holds is a link, titled as the note is titled');
  assert.match(html, /<span class="ref">production-glossary<\/span>/,
    'a reference it does not hold reads as a name, not as markup');
  assert.ok(!html.includes('[[') && !html.includes(']]'), 'no double brackets reach the page');
});

test('front matter, if a draft carries it, is not shown to a reader', () => {
  const html = renderMarkdown('---\ntitle: T\ntopic: improvement\n---\n\nReal body.\n');
  assert.ok(!html.includes('topic: improvement'));
  assert.match(html, /<p>Real body\.<\/p>/);
});

test('a horizontal rule, a fenced block and hard-wrapped prose all read correctly', () => {
  const html = renderMarkdown('First para.\n\n---\n\n```\nnode src/server.mjs\n```\n\nA sentence that wraps\nacross two lines.\n');
  assert.match(html, /<hr>/);
  assert.match(html, /<pre><code>node src\/server\.mjs\n<\/code><\/pre>/);
  assert.match(html, /<p>A sentence that wraps across two lines\.<\/p>/, 'a wrapped line is one paragraph');
});
