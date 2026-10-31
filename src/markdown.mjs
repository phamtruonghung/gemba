// The reading view's renderer: markdown in, prose out.
//
// The corpus, the expert notes and the interview drafts are all markdown — headings, bullets,
// blockquotes, one table. Printing that escaped put `## Don't count the number` on screen with its
// hashes, which is the syntax, not the writing.
//
// Safety rule, and the reason this file is small rather than a dependency: **text is escaped first, the
// tags are built around the escaped text.** No raw HTML passes through, so a note cannot inject markup
// into the page no matter who wrote it. A `javascript:` URL never becomes an anchor.
//
// Scope is deliberately what the corpus actually contains — h1–h4, paragraphs, `-`/`*` bullets,
// ordered lists, blockquotes, pipe tables, rules, fenced code, `**bold**`, `*italic*`/`_italic_`,
// `` `code` ``, `[label](url)`. Single-level lists only: measured across the twelve notes, there are no
// nested bullets, and a renderer that silently mangles a shape nobody writes is worse than one that
// does not claim to handle it.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ESCAPES[c]);

// Site paths and http(s) only. `//host` and `/\host` are read by browsers as another host (the same rule as
// safeNext in server.mjs, kept local because that module starts a server).
const HREF_OK = /^(https?:\/\/|\/(?![/\\]))[^\s"<>`\\\u0000-\u001f\u007f-\u009f]*$/;

// The vault's own notes refer to each other as `[[how-open-work-is-managed]]`. That is a real
// reference, so it should read as one: a link to the note when the library holds it, and the plain
// name when it does not — never the double brackets, which are a wiki's syntax, not a sentence.
function wikiLink(slug, links) {
  const target = links && (links.get(slug) ?? links.get(slug.replace(/^(vault|demo)-/, '')));
  if (target) return `<a href="/notes/${esc(slug)}">${esc(target)}</a>`;
  return `<span class="ref">${esc(slug)}</span>`;
}

// The `<` exclusion in italic keeps it from ever spanning a tag that bold just produced.
const emphasis = (t) =>
  t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[\s(*])[*_]([^*_\n<]+)[*_]/g, '$1<em>$2</em>');

// Every tag and attribute is built from the raw text, escaped exactly once, and parked behind a
// placeholder while the rest is escaped and given emphasis; the parked pieces go back in at the end.
export function renderInline(text, links = null) {
  const held = [];
  const hold = (html) => `\u0000${held.push(html) - 1}\u0000`;
  // Strip first, so a placeholder cannot be forged by the text itself.
  let t = String(text).replace(/\u0000/g, '');
  // Code spans first: their contents are literal, so nothing inside them is interpreted.
  t = t.replace(/`([^`]+)`/g, (_, code) => hold(`<code>${esc(code)}</code>`));
  t = t.replace(/\[\[([^\]]+)\]\]/g, (_, slug) => hold(wikiLink(slug.trim(), links)));
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, label, href) =>
    HREF_OK.test(href)
      ? hold(`<a href="${esc(href)}"${/^https?:/.test(href) ? ' rel="noopener"' : ''}>${emphasis(esc(label))}</a>`)
      : whole,
  );
  t = emphasis(esc(t));
  // A label can contain a parked piece, so restore until none is left.
  while (t.includes('\u0000')) t = t.replace(/\u0000(\d+)\u0000/g, (_, i) => held[Number(i)]);
  return t;
}

// `#` and `##` are both top-level sections in these notes: the page already carries the title as its
// own h1, so a note's own top level maps to h2 and the ladder below it never skips a step.
const headingLevel = (hashes) => (hashes.length <= 2 ? 2 : Math.min(6, hashes.length));

const isBullet = (l) => /^[-*+]\s+/.test(l);
const isOrdered = (l) => /^\d+[.)]\s+/.test(l);
const isRule = (l) => /^(-{3,}|\*{3,}|_{3,})$/.test(l.trim());
const isTableSep = (l) => /^\|[\s:|-]+\|$/.test((l ?? '').trim());
const isFence = (l) => /^\s*```/.test(l);

/**
 * A heading's anchor id: lowercase, diacritics stripped (so `Bảo trì` and `Bao tri` share one stable
 * form and the id is plain ASCII in a URL), non-alphanumerics collapsed to hyphens.
 */
export function headingId(text) {
  const id = String(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/<[^>]*>/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return id || 'section';
}

/**
 * `outline`, when given an array, is filled with `{ id, text, level }` for each heading, so a page can
 * offer "keep my place" without parsing the HTML again.
 */
export function renderMarkdown(md, { title = '', links = null, outline = null } = {}) {
  const usedIds = new Map();
  const src = String(md ?? '')
    .replace(/^\uFEFF/, '')
    // A draft may still carry YAML front matter; a reader should never see the metadata.
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
    .replace(/\r\n?/g, '\n');

  const lines = src.split('\n');
  const out = [];
  let i = 0;
  let sawBlock = false;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i++;
      continue;
    }

    if (isFence(line)) {
      const body = [];
      i++;
      while (i < lines.length && !isFence(lines[i])) body.push(lines[i++]);
      i++; // closing fence
      out.push(`<pre><code>${esc(body.join('\n'))}\n</code></pre>`);
      sawBlock = true;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const text = heading[2].trim();
      // The page is already titled with the note's own title; a note that repeats it should not say it twice.
      if (!sawBlock && title && text === title.trim()) {
        sawBlock = true;
        i++;
        continue;
      }
      // A stable, deduplicated id plus a visible § link, so the URL fragment carries the reader's place and
      // can be bookmarked or sent to someone without any script.
      const base = headingId(text);
      const seen = usedIds.get(base) ?? 0;
      usedIds.set(base, seen + 1);
      const id = seen ? `${base}-${seen + 1}` : base;
      const level = headingLevel(heading[1]);
      if (outline) outline.push({ id, text: markdownToText(text), level });
      out.push(`<h${level} id="${id}">${renderInline(text, links)}<a class="sec-anchor" href="#${id}" aria-label="Link to this section: ${esc(markdownToText(text))}">§</a></h${level}>`);
      sawBlock = true;
      i++;
      continue;
    }

    if (isRule(line)) {
      out.push('<hr>');
      sawBlock = true;
      i++;
      continue;
    }

    if (line.trim().startsWith('|') && isTableSep(lines[i + 1])) {
      const cells = (row) =>
        row
          .trim()
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(cells(lines[i++]));
      out.push(
        `<div class="table-scroll" tabindex="0" role="region" aria-label="Table: scroll sideways to read it"><table><thead><tr>${head.map((c) => `<th>${renderInline(c, links)}</th>`).join('')}</tr></thead>` +
          `<tbody>${rows
            .map((r) => `<tr>${r.map((c) => `<td>${renderInline(c, links)}</td>`).join('')}</tr>`)
            .join('')}</tbody></table></div>`,
      );
      sawBlock = true;
      continue;
    }

    if (line.trim().startsWith('>')) {
      const quoted = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        quoted.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push(`<blockquote><p>${renderInline(quoted.join(' ').trim(), links)}</p></blockquote>`);
      sawBlock = true;
      continue;
    }

    if (isBullet(line) || isOrdered(line)) {
      const ordered = isOrdered(line);
      const items = [];
      while (i < lines.length && (isBullet(lines[i]) || isOrdered(lines[i]))) {
        items.push(lines[i].replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ''));
        i++;
        // A wrapped line belongs to the item above it, and markdown joins with a space.
        while (i < lines.length && lines[i].trim() && !isBullet(lines[i]) && !isOrdered(lines[i]) && !/^\s*(#{1,6}\s|>|\||```)/.test(lines[i])) {
          items[items.length - 1] += ` ${lines[i].trim()}`;
          i++;
        }
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((it) => `<li>${renderInline(it, links)}</li>`).join('')}</${tag}>`);
      sawBlock = true;
      continue;
    }

    // Paragraph: consecutive plain lines, joined the way markdown joins them.
    const para = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !isFence(lines[i]) &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !isRule(lines[i]) &&
      !lines[i].trim().startsWith('>') &&
      !isBullet(lines[i]) &&
      !isOrdered(lines[i]) &&
      !(lines[i].trim().startsWith('|') && isTableSep(lines[i + 1]))
    ) {
      para.push(lines[i].trim());
      i++;
    }
    out.push(`<p>${renderInline(para.join(' '), links)}</p>`);
    sawBlock = true;
  }

  return out.join('\n');
}

export function markdownToText(md, { limit = 0 } = {}) {
  const text = String(md ?? '')
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
    .replace(/`{3}[\s\S]*?`{3}/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/[|*_`]/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return limit && text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}
