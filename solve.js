// solve.js — a faster drop-in for makefun-site 1.0.0, written from its README alone.
// run(input) returns the output tree (path -> text) for one site's input.
// No dependencies, no I/O, no clock, no randomness: the answer depends on the input alone.

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// ---------------------------------------------------------------- text

// HTML escaping: & < > " ' only. The fast path returns the string untouched when
// it holds none of them (the common case for titles, urls and template values).
const ESC_ENT = new Array(128);
ESC_ENT[38] = '&amp;';
ESC_ENT[60] = '&lt;';
ESC_ENT[62] = '&gt;';
ESC_ENT[34] = '&quot;';
ESC_ENT[39] = '&#39;';

function escapeHtml(s) {
  if (
    s.indexOf('&') === -1 && s.indexOf('<') === -1 && s.indexOf('>') === -1 &&
    s.indexOf('"') === -1 && s.indexOf("'") === -1
  ) return s;
  const parts = [];
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 128) {
      const e = ESC_ENT[c];
      if (e !== undefined) {
        parts.push(s.slice(last, i), e);
        last = i + 1;
      }
    }
  }
  parts.push(s.slice(last));
  return parts.join('');
}

// A slug: NFKD, combining marks dropped, A-Z lowered, each run of other
// characters one '-', none at either end, cut to 64 (a '-' at the cut dropped),
// 'untitled' when nothing is left. `cache` is per run().
const MARK_RE = /\p{M}/gu;
const NON_ALNUM_RE = /[^a-z0-9]+/g;

function slugify(s, cache) {
  const hit = cache.get(s);
  if (hit !== undefined) return hit;
  let t = s.normalize('NFKD').replace(MARK_RE, '').toLowerCase().replace(NON_ALNUM_RE, '-');
  let a = 0;
  let b = t.length;
  if (b > 0 && t.charCodeAt(0) === 45) a = 1;
  if (b > a && t.charCodeAt(b - 1) === 45) b--;
  t = t.slice(a, b);
  if (t.length > 64) {
    t = t.slice(0, 64);
    if (t.charCodeAt(63) === 45) t = t.slice(0, 63);
  }
  if (t === '') t = 'untitled';
  cache.set(s, t);
  return t;
}

function dateLong(d) {
  return (+d.slice(8)) + ' ' + MONTHS[+d.slice(5, 7) - 1] + ' ' + d.slice(0, 4);
}

// True when the line holds only spaces and tabs (or is empty).
function isBlank(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Trim spaces and tabs at both ends.
function trimST(s) {
  let a = 0;
  let b = s.length;
  while (a < b && (s.charCodeAt(a) === 32 || s.charCodeAt(a) === 9)) a++;
  while (b > a && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === s.length ? s : s.slice(a, b);
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = new Set(['title', 'summary', 'date', 'tags', 'draft', 'layout', 'slug']);
const KEY_VALUE_RE = /^([a-z_]+): (.*)$/;
const KEY_EMPTY_RE = /^([a-z_]+):$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LAYOUT_RE = /^[a-z0-9-]+$/;
const SLUG_VALUE_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function validDate(v) {
  const m = DATE_RE.exec(v);
  if (!m) return false;
  const y = +m[1];
  const mo = +m[2];
  const d = +m[3];
  if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1) return false;
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const dim = mo === 2 ? (leap ? 29 : 28) : mo === 4 || mo === 6 || mo === 9 || mo === 11 ? 30 : 31;
  return d <= dim;
}

// A quoted ("...") or bare string value. Returns { v } or { e: reason }.
function parseStringValue(key, value) {
  if (value.charCodeAt(0) === 34) {
    let out = '';
    for (let i = 1; i < value.length; i++) {
      const c = value[i];
      if (c === '\\') {
        const d = value[i + 1];
        if (d === '"' || d === '\\') {
          out += d;
          i++;
        } else {
          return { e: `key "${key}": a quoted string has a bad escape` };
        }
      } else if (c === '"') {
        if (i !== value.length - 1) return { e: `key "${key}": a quoted string is not closed` };
        return { v: out };
      } else {
        out += c;
      }
    }
    return { e: `key "${key}": a quoted string is not closed` };
  }
  if (value.charCodeAt(0) === 91) return { e: `key "${key}": a bare string opens on [` };
  return { v: value };
}

// A [a, b, c] tag list. Returns { v: names } or { e: reason }.
function parseTagsValue(value) {
  if (value.charCodeAt(0) !== 91 || value.charCodeAt(value.length - 1) !== 93) {
    return { e: 'key "tags": not a list [a, b]' };
  }
  const inner = value.slice(1, -1);
  if (inner.trim() === '') return { v: [] };
  const parts = inner.split(',');
  const names = [];
  for (let i = 0; i < parts.length; i++) {
    const t = parts[i].trim();
    if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1) {
      return { e: 'key "tags": an empty tag, or one holding " [ or ]' };
    }
    names.push(t);
  }
  return { v: names };
}

// Validate one key's value. Returns an error reason, or null, and stores the
// parsed value in kv when it reads.
function checkValue(key, value, kv) {
  switch (key) {
    case 'title':
    case 'summary': {
      const r = parseStringValue(key, value);
      if (r.e) return r.e;
      kv[key] = r.v;
      return null;
    }
    case 'date':
      if (!validDate(value)) return 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)';
      kv.date = value;
      return null;
    case 'tags': {
      const r = parseTagsValue(value);
      if (r.e) return r.e;
      kv.tags = r.v;
      return null;
    }
    case 'draft':
      if (value !== 'true' && value !== 'false') return 'key "draft": true or false';
      kv.draft = value === 'true';
      return null;
    case 'layout':
      if (!LAYOUT_RE.test(value)) return 'key "layout": not a template name';
      kv.layout = value;
      return null;
    case 'slug':
      if (value.length > 64 || !SLUG_VALUE_RE.test(value)) return 'key "slug": not a slug';
      kv.slug = value;
      return null;
    default:
      return null;
  }
}

// One front-matter line (not blank, not a comment). Returns a reason or null.
function checkFmLine(line, n, kv) {
  let key;
  let raw;
  const m = KEY_VALUE_RE.exec(line);
  if (m) {
    key = m[1];
    raw = m[2];
  } else {
    const m2 = KEY_EMPTY_RE.exec(line);
    if (!m2) return `line ${n} is not "key: value"`;
    key = m2[1];
    raw = '';
  }
  if (!FM_KEYS.has(key)) return `unknown key "${key}"`;
  if (Object.hasOwn(kv, key)) return `key "${key}" is given twice`;
  const value = trimST(raw);
  if (value === '') return `key "${key}" has no value`;
  return checkValue(key, value, kv);
}

// Parse a source's front matter. Returns { kv, body } or { error }.
function parseFrontMatter(src) {
  if (src !== '---' && !src.startsWith('---\n')) return { error: 'no front matter' };
  const kv = {};
  let pos = src === '---' ? 3 : 4;
  let n = 2;
  for (;;) {
    if (pos >= src.length) return { error: 'the front matter is not closed' };
    const nl = src.indexOf('\n', pos);
    const line = nl === -1 ? src.slice(pos) : src.slice(pos, nl);
    if (line === '---') {
      if (!kv.title) return { error: 'no title' };
      return { kv, body: nl === -1 ? '' : src.slice(nl + 1) };
    }
    if (!isBlank(line) && line.charCodeAt(0) !== 35) {
      const err = checkFmLine(line, n, kv);
      if (err) return { error: err };
    }
    if (nl === -1) return { error: 'the front matter is not closed' };
    pos = nl + 1;
    n++;
  }
}

// ---------------------------------------------------------------- Markdown

const FENCE_OPEN_RE = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE_RE = /^```[ \t]*$/;
const HEADING_RE = /^(#{1,6})[ \t]+(.*)$/;
const HR_RE = /^(---|\*\*\*)[ \t]*$/;
const BULLET_RE = /^[-*] (.*)$/;
const ORDERED_RE = /^(\d+)\. (.*)$/;

// Characters a backslash may escape in inline text.
const ESCAPABLE = new Uint8Array(128);
for (const ch of '\\`*_[]()#+-.!>') ESCAPABLE[ch.charCodeAt(0)] = 1;

// Find the next `**` (not escaped) at or after `from`. -1 when there is none.
// Note: a `**` right at `from` is found too — it would close with nothing
// between, which the caller treats as no opener at all.
function findStrongClose(src, from, end) {
  for (let k = from; k + 1 < end; k++) {
    const c = src.charCodeAt(k);
    if (c === 92 && k + 1 < end && ESCAPABLE[src.charCodeAt(k + 1)]) {
      k++;
      continue;
    }
    if (c === 42 && src.charCodeAt(k + 1) === 42) return k;
  }
  return -1;
}

// Find the single `*` that closes an emphasis span opened at `from`: one not
// beside another `*`, and not escaped itself. A `**` pair holds no single
// `*`, so both of its stars are passed over together; an escaped star is
// passed over with its backslash.
function findEmClose(src, from, end) {
  for (let k = from; k < end; k++) {
    const c = src.charCodeAt(k);
    if (c === 92 && k + 1 < end && ESCAPABLE[src.charCodeAt(k + 1)]) {
      k++;
      continue;
    }
    if (c === 42) {
      if (k + 1 < end && src.charCodeAt(k + 1) === 42) {
        k++;
        continue;
      }
      if (k >= from + 1) return k;
    }
  }
  return -1;
}

// Find the first `]` (not escaped) at or after `from`.
function findBracketClose(src, from, end) {
  for (let k = from; k < end; k++) {
    const c = src.charCodeAt(k);
    if (c === 92 && k + 1 < end && ESCAPABLE[src.charCodeAt(k + 1)]) {
      k++;
      continue;
    }
    if (c === 93) return k;
  }
  return -1;
}

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const WS_RE = /\s/;

// Resolve a link target from the source's directory. Returns the href, and
// records a broken link (once) when the target names nothing.
function resolveHref(target, ctx) {
  const c0 = target.charCodeAt(0);
  if (c0 === 35 || c0 === 47 || SCHEME_RE.test(target)) return target;
  let path = target;
  let frag = null;
  const hi = target.indexOf('#');
  if (hi !== -1) {
    path = target.slice(0, hi);
    frag = target.slice(hi + 1);
  }
  const stack = ctx.dir.slice();
  const parts = path.split('/');
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (stack.length) stack.pop();
      continue;
    }
    stack.push(seg);
  }
  const resolved = stack.join('/');
  const url = ctx.pages.get(resolved);
  if (url !== undefined) return frag === null ? url : url + '#' + frag;
  if (ctx.statics.has(resolved)) {
    const u = ctx.base + '/' + resolved;
    return frag === null ? u : u + '#' + frag;
  }
  ctx.broken.add(ctx.source + '\n' + target);
  return target;
}

// Render inline Markdown of src[a..b] into out (an array of strings). The
// next mark is found by one native scan, not a character-by-character loop.
const SPECIAL_RE = /[\\`*\[&<>"']/g;

function inlineTo(src, a, b, ctx, out) {
  let i = a;
  SPECIAL_RE.lastIndex = i;
  let m = SPECIAL_RE.exec(src);
  while (m !== null && m.index < b) {
    const j = m.index;
    if (j > i) out.push(src.slice(i, j));
    const c = src.charCodeAt(j);
    if (c === 92) {
      // Backslash escape.
      if (j + 1 < b && ESCAPABLE[src.charCodeAt(j + 1)]) {
        const d = src.charCodeAt(j + 1);
        out.push(d === 62 ? '&gt;' : src[j + 1]);
        i = j + 2;
      } else {
        out.push('\\');
        i = j + 1;
      }
    } else if (c === 96) {
      // Code span.
      const k = src.indexOf('`', j + 1);
      if (k !== -1 && k < b && k > j + 1) {
        out.push('<code>', escapeHtml(src.slice(j + 1, k)), '</code>');
        i = k + 1;
      } else {
        out.push('`');
        i = j + 1;
      }
    } else if (c === 42) {
      if (j + 1 < b && src.charCodeAt(j + 1) === 42) {
        // Strong: closed by the next `**`, with at least one character
        // between. When the next `**` leaves nothing between, or there is
        // none, `**` is itself and the parser moves past it.
        const k = findStrongClose(src, j + 2, b);
        if (k !== -1 && k > j + 2) {
          out.push('<strong>');
          inlineTo(src, j + 2, k, ctx, out);
          out.push('</strong>');
          i = k + 2;
        } else {
          out.push('**');
          i = j + 2;
        }
      } else {
        // Emphasis.
        const k = findEmClose(src, j + 1, b);
        if (k !== -1) {
          out.push('<em>');
          inlineTo(src, j + 1, k, ctx, out);
          out.push('</em>');
          i = k + 1;
        } else {
          out.push('*');
          i = j + 1;
        }
      }
    } else if (c === 91) {
      // Link.
      let done = false;
      const k = findBracketClose(src, j + 1, b);
      if (k !== -1 && k + 1 < b && src.charCodeAt(k + 1) === 40) {
        const t = src.indexOf(')', k + 2);
        if (t !== -1 && t < b) {
          const target = src.slice(k + 2, t);
          if (target !== '' && !WS_RE.test(target)) {
            out.push('<a href="', escapeHtml(resolveHref(target, ctx)), '">');
            inlineTo(src, j + 1, k, ctx, out);
            out.push('</a>');
            i = t + 1;
            done = true;
          }
        }
      }
      if (!done) {
        out.push('[');
        i = j + 1;
      }
    } else if (c === 38) {
      out.push('&amp;');
      i = j + 1;
    } else if (c === 60) {
      out.push('&lt;');
      i = j + 1;
    } else if (c === 62) {
      out.push('&gt;');
      i = j + 1;
    } else if (c === 34) {
      out.push('&quot;');
      i = j + 1;
    } else {
      out.push('&#39;');
      i = j + 1;
    }
    SPECIAL_RE.lastIndex = i;
    m = SPECIAL_RE.exec(src);
  }
  if (i < b) out.push(src.slice(i, b));
}

function inlineStr(src, ctx) {
  const out = [];
  inlineTo(src, 0, src.length, ctx, out);
  return out.join('');
}

// Is this line a heading? Returns { level, text } or null.
function headingOf(line) {
  const m = HEADING_RE.exec(line);
  if (!m) return null;
  const text = trimST(m[2]);
  if (text === '') return null;
  return { level: m[1].length, text };
}

// Is this line a list continuation (two or more spaces, then something)?
function isContinuation(line) {
  if (line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  return trimST(line) !== '';
}

// Render one body's Markdown. Returns { html, toc, excerpt }.
function renderMarkdown(body, ctx) {
  const lines = body.split('\n');
  const n = lines.length;
  const out = [];
  const toc = [];
  const ids = new Set();
  let excerpt = '';
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const c0 = line.charCodeAt(0);
    if (c0 === 96) {
      const fm = FENCE_OPEN_RE.exec(line);
      if (fm) {
        const lang = fm[1];
        i++;
        const buf = [];
        while (i < n && !FENCE_CLOSE_RE.test(lines[i])) {
          buf.push(escapeHtml(lines[i]));
          i++;
        }
        if (i < n) i++;
        out.push(
          '<pre><code' + (lang ? ' class="language-' + lang + '"' : '') + '>' +
          (buf.length ? buf.join('\n') + '\n' : '') + '</code></pre>',
        );
        continue;
      }
    } else if (c0 === 35) {
      const h = headingOf(line);
      if (h) {
        const baseId = slugify(h.text, ctx.slugs);
        let id = baseId;
        let k = 2;
        while (ids.has(id)) id = baseId + '-' + (k++);
        ids.add(id);
        const inner = inlineStr(h.text, ctx);
        if (h.level === 2 || h.level === 3) toc.push({ level: h.level, id, html: inner });
        out.push('<h' + h.level + ' id="' + id + '">' + inner + '</h' + h.level + '>');
        i++;
        continue;
      }
    } else if (c0 === 62) {
      const parts = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let t = lines[i].slice(1);
        if (t.charCodeAt(0) === 32) t = t.slice(1);
        t = trimST(t);
        if (t !== '') parts.push(t);
        i++;
      }
      if (parts.length) {
        out.push('<blockquote>\n<p>' + inlineStr(parts.join('\n'), ctx) + '</p>\n</blockquote>');
      } else {
        out.push('<blockquote>\n</blockquote>');
      }
      continue;
    }
    if (c0 === 45 || c0 === 42 || (c0 >= 48 && c0 <= 57)) {
      if (HR_RE.test(line)) {
        out.push('<hr>');
        i++;
        continue;
      }
      const bm = BULLET_RE.exec(line);
      const om = bm ? null : ORDERED_RE.exec(line);
      if (bm || om) {
        const ordered = om !== null;
        const start = ordered ? +om[1] : 0;
        const items = [];
        let cur = ordered ? om[2] : bm[1];
        i++;
        while (i < n) {
          const l = lines[i];
          if (ordered ? ORDERED_RE.test(l) : BULLET_RE.test(l)) {
            items.push(cur);
            cur = ordered ? ORDERED_RE.exec(l)[2] : BULLET_RE.exec(l)[1];
            i++;
          } else if (isContinuation(l)) {
            cur += '\n' + trimST(l);
            i++;
          } else {
            break;
          }
        }
        items.push(cur);
        const lis = [];
        for (let q = 0; q < items.length; q++) lis.push('<li>' + inlineStr(items[q], ctx) + '</li>');
        out.push(
          ordered
            ? '<ol' + (start !== 1 ? ' start="' + start + '"' : '') + '>\n' + lis.join('\n') + '\n</ol>'
            : '<ul>\n' + lis.join('\n') + '\n</ul>',
        );
        continue;
      }
    }
    // Paragraph: lines up to a blank line, a fence, a heading or a break.
    const parts = [trimST(line)];
    i++;
    while (i < n) {
      const l2 = lines[i];
      if (isBlank(l2)) break;
      const d = l2.charCodeAt(0);
      if (d === 96 && FENCE_OPEN_RE.test(l2)) break;
      if (d === 35 && headingOf(l2)) break;
      if ((d === 45 || d === 42) && HR_RE.test(l2)) break;
      parts.push(trimST(l2));
      i++;
    }
    const inner = inlineStr(parts.join('\n'), ctx);
    if (excerpt === '') excerpt = inner;
    out.push('<p>' + inner + '</p>');
  }
  return { html: out.length ? out.join('\n') + '\n' : '', toc, excerpt };
}

// Count runs of characters other than whitespace, without allocating.
function countWords(s) {
  let words = 0;
  let inWord = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11) inWord = false;
    else if (!inWord) {
      words++;
      inWord = true;
    }
  }
  return words;
}

// ---------------------------------------------------------------- templates

// Node kinds: 0 text, 1 var, 2 for, 3 if, 4 include.
const PATH_SEG_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function parsePath(s) {
  if (s === '') return null;
  const parts = s.split('.');
  for (let i = 0; i < parts.length; i++) {
    if (!PATH_SEG_RE.test(parts[i])) return null;
  }
  return parts;
}

const FOR_RE = /^for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+(.+)$/;
const IF_RE = /^if\s+(not\s+)?(.+)$/;
const INCLUDE_RE = /^include\s+"([^"]*)"$/;

// Process one {% %} tag's content. Returns a reason or null.
function processTag(content, stack) {
  const top = stack[stack.length - 1];
  let m = FOR_RE.exec(content);
  if (m) {
    const path = parsePath(m[2].trim());
    if (!path) return 'a path is not one';
    const node = [2, m[1], path, []];
    top.nodes.push(node);
    stack.push({ nodes: node[3], kind: 1, node });
    return null;
  }
  if (content === 'endfor') {
    if (top.kind !== 1) return 'an endfor without a for';
    stack.pop();
    return null;
  }
  m = IF_RE.exec(content);
  if (m) {
    const path = parsePath(m[2].trim());
    if (!path) return 'a path is not one';
    const node = [3, path, m[1] !== undefined, [], null];
    top.nodes.push(node);
    stack.push({ nodes: node[3], kind: 2, node, inElse: false });
    return null;
  }
  if (content === 'else') {
    if (top.kind !== 2 || top.inElse) return 'an else without an if';
    top.node[4] = [];
    top.nodes = top.node[4];
    top.inElse = true;
    return null;
  }
  if (content === 'endif') {
    if (top.kind !== 2) return 'an endif without an if';
    stack.pop();
    return null;
  }
  m = INCLUDE_RE.exec(content);
  if (m) {
    top.nodes.push([4, m[1]]);
    return null;
  }
  return 'an unknown tag';
}

// Parse a template source. Returns { nodes } or { error }.
function parseTemplate(src) {
  const root = [];
  const stack = [{ nodes: root, kind: 0 }];
  const top = () => stack[stack.length - 1];
  const n = src.length;
  let i = 0;
  let textStart = 0;
  while (i < n) {
    const a = src.indexOf('{{', i);
    const b = src.indexOf('{%', i);
    if (a === -1 && b === -1) break;
    let s;
    let kind;
    if (b === -1 || (a !== -1 && a < b)) {
      s = a;
      kind = src.charCodeAt(a + 2) === 123 ? 'raw' : 'var';
    } else {
      s = b;
      kind = 'tag';
    }
    if (kind === 'tag') {
      const close = src.indexOf('%}', s + 2);
      if (close === -1) return { error: 'a {% is not closed' };
      // Alone on its line? Only spaces/tabs beside it, back to the line
      // start and on to the line end: then the whole line goes with it.
      let leftOk = true;
      for (let k = s - 1; k >= 0; k--) {
        const c = src.charCodeAt(k);
        if (c === 10) break;
        if (c !== 32 && c !== 9) {
          leftOk = false;
          break;
        }
      }
      let rightOk = false;
      let afterNl = close + 2;
      if (leftOk) {
        let k = close + 2;
        while (k < n) {
          const c = src.charCodeAt(k);
          if (c === 10) {
            rightOk = true;
            afterNl = k + 1;
            break;
          }
          if (c !== 32 && c !== 9) break;
          k++;
        }
        if (k >= n) {
          rightOk = true;
          afterNl = n;
        }
      }
      let text = src.slice(textStart, s);
      let nextStart = close + 2;
      if (leftOk && rightOk) {
        text = text.replace(/[ \t]+$/, '');
        nextStart = afterNl;
      }
      if (text !== '') top().nodes.push([0, text]);
      const content = src.slice(s + 2, close).trim();
      const err = processTag(content, stack);
      if (err) return { error: err };
      i = nextStart;
      textStart = nextStart;
    } else {
      const closer = kind === 'raw' ? '}}}' : '}}';
      const off = kind === 'raw' ? 3 : 2;
      const close = src.indexOf(closer, s + off);
      if (close === -1) return { error: kind === 'raw' ? 'a {{{ is not closed' : 'a {{ is not closed' };
      const text = src.slice(textStart, s);
      if (text !== '') top().nodes.push([0, text]);
      const path = parsePath(src.slice(s + off, close).trim());
      if (!path) return { error: 'a path is not one' };
      top().nodes.push([1, path, kind === 'raw']);
      i = close + closer.length;
      textStart = i;
    }
  }
  if (textStart < n) {
    const text = src.slice(textStart);
    if (text !== '') top().nodes.push([0, text]);
  }
  if (stack.length > 1) {
    return { error: stack[stack.length - 1].kind === 1 ? 'a for is not closed' : 'an if is not closed' };
  }
  return { nodes: root };
}

// Read a dotted path: the first name from the innermost loop that binds it
// (`loop` before the element), else from the page's values; each next name an
// own property of the value so far, or undefined.
function lookup(path, ctx, frames) {
  const n0 = path[0];
  let v;
  let found = false;
  for (let f = frames.length - 1; f >= 0; f--) {
    const fr = frames[f];
    if (n0 === 'loop') {
      v = fr.loop;
      found = true;
      break;
    }
    if (fr.v === n0) {
      v = fr.val;
      found = true;
      break;
    }
  }
  if (!found) {
    if (!Object.hasOwn(ctx, n0)) return undefined;
    v = ctx[n0];
  }
  for (let p = 1; p < path.length; p++) {
    if (v === null || v === undefined) return undefined;
    const nm = path[p];
    if (!Object.hasOwn(v, nm)) return undefined;
    v = v[nm];
  }
  return v;
}

// Write a value as a template does: a string itself, a number in JavaScript's
// own digits, true or false, an array as its items joined by ', ', else ''.
function writeValue(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (v === true) return 'true';
  if (v === false) return 'false';
  if (Array.isArray(v)) {
    let s = '';
    for (let i = 0; i < v.length; i++) {
      if (i) s += ', ';
      s += writeValue(v[i]);
    }
    return s;
  }
  return '';
}

// Undefined, null, false, "", 0 and an empty array are false; anything else true.
function truthy(v) {
  return !(
    v === undefined || v === null || v === false || v === '' || v === 0 ||
    (Array.isArray(v) && v.length === 0)
  );
}

function renderNodes(nodes, ctx, frames, templates, out, depth) {
  for (let i = 0; i < nodes.length; i++) {
    const nd = nodes[i];
    const k = nd[0];
    if (k === 0) {
      out.push(nd[1]);
    } else if (k === 1) {
      const s = writeValue(lookup(nd[1], ctx, frames));
      out.push(nd[2] ? s : escapeHtml(s));
    } else if (k === 2) {
      const arr = lookup(nd[2], ctx, frames);
      if (Array.isArray(arr) && arr.length) {
        const loop = { index: 0, first: false, last: false, length: arr.length };
        const frame = { v: nd[1], val: undefined, loop };
        frames.push(frame);
        for (let j = 0; j < arr.length; j++) {
          loop.index = j + 1;
          loop.first = j === 0;
          loop.last = j === arr.length - 1;
          frame.val = arr[j];
          renderNodes(nd[3], ctx, frames, templates, out, depth);
        }
        frames.pop();
      }
    } else if (k === 3) {
      const t = truthy(lookup(nd[1], ctx, frames));
      const show = nd[2] ? !t : t;
      if (show) renderNodes(nd[3], ctx, frames, templates, out, depth);
      else if (nd[4]) renderNodes(nd[4], ctx, frames, templates, out, depth);
    } else {
      if (depth < 8) {
        const t = templates.get(nd[1]);
        if (t) renderNodes(t, ctx, frames, templates, out, depth + 1);
      }
    }
  }
}

// ---------------------------------------------------------------- the build

export function run(input) {
  const site = input.site || {};
  const base = String(site.base_url || '').replace(/\/+$/, '');
  const perPage = site.per_page;
  const recentN = site.recent;
  const report = [];
  const broken = new Set();
  const slugs = new Map();

  // 1. Sources, sorted by path in code-unit order.
  const files = (input.files || []).slice();
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  // 2. Templates, parsed in code-unit order of name.
  const templates = new Map();
  const templateNames = Object.keys(input.templates || {}).sort();
  for (let i = 0; i < templateNames.length; i++) {
    const name = templateNames[i];
    const parsed = parseTemplate(input.templates[name]);
    if (parsed.error) report.push(`template "${name}": ${parsed.error}`);
    else templates.set(name, parsed.nodes);
  }

  // 3. Front matter and the checks, in order. Kept sources stay in sorted order.
  const kept = [];
  const statics = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (!f.path.endsWith('.md')) {
      statics.push(f);
      continue;
    }
    const content = f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content;
    const fm = parseFrontMatter(content);
    if (fm.error) {
      report.push(`refused ${f.path}: ${fm.error}`);
      continue;
    }
    const kv = fm.kv;
    const isPost = f.path.startsWith('posts/');
    const slash = f.path.indexOf('/');
    const dir = slash === -1 ? '' : f.path.slice(0, slash);
    if (dir === 'tags' || dir === 'page') {
      report.push(`refused ${f.path}: ${dir}/ is the generator's own`);
      continue;
    }
    if (isPost && kv.date === undefined) {
      report.push(`refused ${f.path}: a post needs a date`);
      continue;
    }
    const layout = kv.layout || (isPost ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${f.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    if (kv.draft === true) {
      report.push(`draft ${f.path}`);
      continue;
    }
    kept.push({
      path: f.path,
      srcDir: f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '',
      dir: isPost ? 'posts' : f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '',
      isPost,
      kv,
      body: fm.body,
      layout,
    });
  }

  // 4. Permalinks: slugs unique in their directory, in source order.
  const taken = new Map();
  for (let i = 0; i < kept.length; i++) {
    const rec = kept[i];
    let set = taken.get(rec.dir);
    if (!set) {
      set = new Set();
      if (rec.dir === '') {
        set.add('posts');
        set.add('tags');
        set.add('page');
      }
      taken.set(rec.dir, set);
    }
    const baseSlug = rec.kv.slug || slugify(rec.kv.title, slugs);
    let slug = baseSlug;
    let n = 2;
    while (set.has(slug)) slug = baseSlug + '-' + (n++);
    set.add(slug);
    rec.slug = slug;
    rec.outPath = (rec.dir === '' ? '' : rec.dir + '/') + slug + '/index.html';
    rec.url = base + '/' + (rec.dir === '' ? '' : rec.dir + '/') + slug + '/';
  }

  // 5. Markdown, each source's body rendered, its links resolved.
  const pagesBySource = new Map();
  const staticSet = new Set();
  for (let i = 0; i < kept.length; i++) pagesBySource.set(kept[i].path, kept[i].url);
  for (let i = 0; i < statics.length; i++) staticSet.add(statics[i].path);
  for (let i = 0; i < kept.length; i++) {
    const rec = kept[i];
    const ctx = {
      dir: rec.srcDir === '' ? [] : rec.srcDir.split('/'),
      pages: pagesBySource,
      statics: staticSet,
      base,
      source: rec.path,
      broken,
      slugs,
    };
    const md = renderMarkdown(rec.body, ctx);
    rec.content = md.html;
    rec.toc = md.toc;
    rec.excerpt = md.excerpt;
    rec.readingMinutes = Math.max(1, Math.ceil(countWords(rec.body) / 200));
  }

  // 6. Collections: posts, newest date first, equal dates by slug.
  const posts = kept.filter((r) => r.isPost);
  posts.sort((a, b) => {
    if (a.kv.date !== b.kv.date) return a.kv.date < b.kv.date ? 1 : -1;
    if (a.slug !== b.slug) return a.slug < b.slug ? -1 : 1;
    return 0;
  });

  // 7. Tags: each post's tags, each slug once, in its own order; a tag is all
  // the posts whose tags have its slug, named as first met in collection order.
  const tagBySlug = new Map();
  const tagOrder = [];
  for (let i = 0; i < posts.length; i++) {
    const rec = posts[i];
    const names = rec.kv.tags || [];
    const seen = new Set();
    const recSlugs = [];
    for (let j = 0; j < names.length; j++) {
      const slug = slugify(names[j], slugs);
      if (seen.has(slug)) continue;
      seen.add(slug);
      recSlugs.push({ slug, spelling: names[j] });
      let tag = tagBySlug.get(slug);
      if (!tag) {
        tag = { name: names[j], slug, url: base + '/tags/' + slug + '/', count: 0, posts: [] };
        tagBySlug.set(slug, tag);
        tagOrder.push(tag);
      }
      tag.count++;
      tag.posts.push(rec);
    }
    rec.tagSlugs = recSlugs;
  }
  const tagList = tagOrder.slice();
  tagList.sort((a, b) => {
    if (a.count !== b.count) return b.count - a.count;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });

  // Cards and page objects.
  const siteCtx = { title: site.title, base_url: base };
  const recent = posts.slice(0, recentN);
  for (let i = 0; i < kept.length; i++) {
    const rec = kept[i];
    const tags = [];
    if (rec.isPost) {
      for (let j = 0; j < rec.tagSlugs.length; j++) tags.push(tagBySlug.get(rec.tagSlugs[j].slug));
    } else {
      const names = rec.kv.tags || [];
      const seen = new Set();
      for (let j = 0; j < names.length; j++) {
        const slug = slugify(names[j], slugs);
        if (seen.has(slug)) continue;
        seen.add(slug);
        const tag = tagBySlug.get(slug);
        tags.push(tag || { name: names[j], slug, url: '' });
      }
    }
    rec.card = {
      title: rec.kv.title,
      url: rec.url,
      date: rec.kv.date || '',
      date_long: rec.kv.date ? dateLong(rec.kv.date) : '',
      summary: rec.kv.summary || '',
      excerpt: rec.excerpt,
      reading_minutes: rec.readingMinutes,
      tags,
    };
  }
  const recentCards = recent.map((r) => r.card);
  for (let i = 0; i < posts.length; i++) {
    const rec = posts[i];
    const newer = i > 0 ? posts[i - 1] : null;
    const older = i < posts.length - 1 ? posts[i + 1] : null;
    const nb = (p) => (p ? { title: p.kv.title, url: p.url, date: p.kv.date, date_long: dateLong(p.kv.date) } : null);
    rec.page = Object.assign({}, rec.card, {
      slug: rec.slug,
      content: rec.content,
      toc: rec.toc,
      newer: nb(newer),
      older: nb(older),
      is_post: true,
    });
  }
  for (let i = 0; i < kept.length; i++) {
    const rec = kept[i];
    if (rec.isPost) continue;
    rec.page = Object.assign({}, rec.card, {
      slug: rec.slug,
      content: rec.content,
      toc: rec.toc,
      newer: null,
      older: null,
      is_post: false,
    });
  }

  // 8. Layouts.
  const output = {};
  const renderInto = (outPath, templateName, ctx) => {
    const nodes = templates.get(templateName);
    if (!nodes) return;
    const out = [];
    renderNodes(nodes, ctx, [], templates, out, 1);
    output[outPath] = out.join('');
  };
  for (let i = 0; i < kept.length; i++) {
    const rec = kept[i];
    renderInto(rec.outPath, rec.layout, { site: siteCtx, tags: tagList, recent: recentCards, page: rec.page });
  }
  const pageCount = Math.max(1, Math.ceil(posts.length / perPage));
  for (let k = 1; k <= pageCount; k++) {
    const slice = posts.slice((k - 1) * perPage, k * perPage);
    const pager = {
      number: k,
      total: pageCount,
      url: k === 1 ? base + '/' : base + '/page/' + k + '/',
      newer_url: k === 1 ? '' : k === 2 ? base + '/' : base + '/page/' + (k - 1) + '/',
      older_url: k === pageCount ? '' : base + '/page/' + (k + 1) + '/',
    };
    renderInto(
      k === 1 ? 'index.html' : 'page/' + k + '/index.html',
      'index',
      { site: siteCtx, tags: tagList, recent: recentCards, posts: slice.map((r) => r.card), pager },
    );
  }
  for (let i = 0; i < tagList.length; i++) {
    const tag = tagList[i];
    renderInto('tags/' + tag.slug + '/index.html', 'tag', {
      site: siteCtx,
      tags: tagList,
      recent: recentCards,
      tag: { name: tag.name, slug: tag.slug, url: tag.url, count: tag.count, posts: tag.posts.map((r) => r.card) },
    });
  }
  renderInto('tags/index.html', 'tags', { site: siteCtx, tags: tagList, recent: recentCards });

  // Static files, unless a built page has their path.
  let staticCount = 0;
  for (let i = 0; i < statics.length; i++) {
    const f = statics[i];
    if (Object.hasOwn(output, f.path)) {
      report.push(`shadowed ${f.path}: a built page has its path`);
      continue;
    }
    output[f.path] = f.content;
    staticCount++;
  }

  // 9. The report.
  for (const key of broken) {
    const nl = key.indexOf('\n');
    report.push(`broken-link ${key.slice(0, nl)} -> ${key.slice(nl + 1)}`);
  }
  report.sort();
  const pageTotal = kept.length - posts.length;
  report.push(`built ${pageTotal} pages, ${posts.length} posts, ${tagList.length} tags and ${staticCount} static files`);
  output['build-report.txt'] = report.map((l) => l + '\n').join('');

  return output;
}
