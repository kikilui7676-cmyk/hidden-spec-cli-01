// main.ts is mend, the CLI SPEC.md specifies: one patch tool for every AI edit format (unified diff,
// SEARCH/REPLACE blocks, V4A patches and JSON tool calls). Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]` with the working directory as the root of a tree of text files.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines (SPEC.md section 3): split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Move pairs (old, new) recorded by move edits that ran, for the `R` line of section 2. */
  moves: Array<readonly [string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** A file as lines: its own break, its lines, and whether it ends with a break (SPEC.md section 3). */
interface FileState {
  lines: string[];
  br: '\n' | '\r\n';
  fin: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', fin: false };
  const nl = text.indexOf('\n');
  const br: '\n' | '\r\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const fin = text.endsWith(br);
  const parts = text.split(br);
  if (fin) parts.pop();
  return { lines: parts, br, fin };
}

function writeFile(st: FileState): string {
  if (st.lines.length === 0) return '';
  return st.lines.join(st.br) + (st.fin ? st.br : '');
}

/* Section 5: matching lines at three tiers. */

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

/** Every position at which `o` occurs in `lines` at `tier`; occurrences may overlap. */
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  outer: for (let i = 0; i + o.length <= lines.length; i += 1) {
    for (let j = 0; j < o.length; j += 1) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) continue outer;
    }
    out.push(i);
  }
  return out;
}

/** The first tier at which `o` occurs at least once, and its positions there. */
function findTier(lines: string[], o: string[], strict: boolean): { tier: number; at: number[] } | null {
  for (const t of strict ? [0] : [0, 1, 2]) {
    const at = occurrences(lines, o, t);
    if (at.length > 0) return { tier: t, at };
  }
  return null;
}

/** One body line of a unified hunk or a V4A chunk; `raw` marks a line that was empty in the patch. */
interface BodyItem {
  tag: ' ' | '-' | '+';
  text: string;
  raw: boolean;
}

/**
 * The lines a matched hunk or chunk writes: context lines are the file's own matched lines, and at tier 2
 * every other new line is re-indented from the patch's first old line's lead to the file's (section 5).
 */
function replacement(fileLines: string[], pos: number, items: BodyItem[], tier: number): string[] {
  let f = '';
  let p = '';
  if (tier === 2) {
    f = leadWs(fileLines[pos]!);
    const firstOld = items.find((it) => it.tag !== '+');
    p = firstOld === undefined ? '' : leadWs(firstOld.text);
  }
  const out: string[] = [];
  let oi = 0;
  for (const it of items) {
    if (it.tag === ' ') {
      out.push(fileLines[pos + oi]!);
      oi += 1;
    } else if (it.tag === '-') {
      oi += 1;
    } else {
      let s = it.text;
      if (tier === 2 && s.trim() !== '' && s.startsWith(p)) s = f + s.slice(p.length);
      out.push(s);
    }
  }
  return out;
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* Section 6: unified diffs. */

/** A hunk body entry: a body line, or a `\` marker that refers to the body line before it. */
type Entry = BodyItem | { tag: '\\' };

/** Whether a `\` entry immediately follows the last entry whose tag is in `tags`. */
function backslashAfter(entries: Entry[], tags: string[]): boolean {
  for (let k = entries.length - 1; k >= 0; k -= 1) {
    if (tags.includes(entries[k]!.tag)) return entries[k + 1]?.tag === '\\';
  }
  return false;
}

/** Read a hunk body starting at index `start`; returns the entries and the first index after the body. */
function scanBody(lines: string[], start: number): { entries: Entry[]; next: number } {
  const entries: Entry[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) break;
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (line === '') {
      entries.push({ tag: ' ', text: '', raw: true });
      i += 1;
      continue;
    }
    const c = line[0]!;
    if (c === ' ' || c === '-' || c === '+') {
      entries.push({ tag: c, text: line.slice(1), raw: false });
      i += 1;
      continue;
    }
    if (c === '\\') {
      entries.push({ tag: '\\' });
      i += 1;
      continue;
    }
    break;
  }
  let end = entries.length;
  while (end > 0) {
    const e = entries[end - 1]!;
    if (e.tag === ' ' && e.raw) end -= 1;
    else break;
  }
  return { entries: entries.slice(0, end), next: i };
}

interface Hunk {
  a: number;
  entries: Entry[];
}

interface Section {
  diffOld?: string;
  diffNew?: string;
  minus?: string;
  plus?: string;
  renameFrom?: string;
  renameTo?: string;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

/** The path a `--- ` or `+++ ` header line names: after the four characters, to the first tab, spaces removed. */
function headerPath(line: string): string {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  return p.trim();
}

function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  const pairAt = (i: number): boolean => (lines[i] ?? '').startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = { diffOld: m[1]!, diffNew: m[2]!, newFile: false, delFile: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const body = scanBody(lines, i + 1);
      cur.hunks.push({ a: Number(m[1]!), entries: body.entries });
      i = body.next;
      inHeader = false;
      continue;
    }
    if (pairAt(i)) {
      if (cur !== null && inHeader && cur.minus === undefined) {
        cur.minus = headerPath(line);
        cur.plus = headerPath(lines[i + 1]!);
      } else {
        cur = { newFile: false, delFile: false, hunks: [], minus: headerPath(line), plus: headerPath(lines[i + 1]!) };
        sections.push(cur);
        inHeader = true;
      }
      i += 2;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.delFile = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections;
}

/** Apply one hunk to `st`; `d` is the section's line delta so far. Returns the hunk's own delta. */
function applyHunk(st: FileState, hunk: Hunk, d: number, strict: boolean, path: string): number {
  const items = hunk.entries.filter((e): e is BodyItem => e.tag !== '\\');
  const o = items.filter((it) => it.tag !== '+').map((it) => it.text);
  const nLen = items.filter((it) => it.tag !== '-').length;
  if (o.length === 0) {
    const pre = st.lines.length;
    const at = Math.max(0, Math.min(hunk.a + d, pre));
    const add = items.filter((it) => it.tag === '+').map((it) => it.text);
    st.lines.splice(at, 0, ...add);
    if (at >= pre) st.fin = !backslashAfter(hunk.entries, [' ', '+']);
    return add.length;
  }
  const found = findTier(st.lines, o, strict);
  if (found === null) throw new Fail('no-match', path);
  const target = hunk.a - 1 + d;
  let pos = found.at[0]!;
  let best = Math.abs(pos - target);
  for (const cand of found.at) {
    const dd = Math.abs(cand - target);
    if (dd < best) {
      best = dd;
      pos = cand;
    }
  }
  const pre = st.lines.length;
  const rep = replacement(st.lines, pos, items, found.tier);
  st.lines.splice(pos, o.length, ...rep);
  if (pos + o.length === pre) st.fin = !backslashAfter(hunk.entries, [' ', '+']);
  return nLen - o.length;
}

const stripPrefix = (p: string): string => (p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);

function unifiedEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    let oldP: string | undefined;
    let newP: string | undefined;
    if (sec.minus !== undefined) {
      oldP = stripPrefix(sec.minus);
      newP = stripPrefix(sec.plus!);
    } else if (sec.renameFrom !== undefined || sec.renameTo !== undefined) {
      oldP = sec.renameFrom ?? sec.diffOld;
      newP = sec.renameTo ?? sec.diffNew;
    } else {
      oldP = sec.diffOld;
      newP = sec.diffNew;
    }
    const creation = sec.newFile || oldP === '/dev/null';
    const deletion = !creation && (sec.delFile || newP === '/dev/null');
    if (creation) {
      const path = newP!;
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      const made: string[] = [];
      for (const h of sec.hunks) {
        for (const e of h.entries) if (e.tag === '+') made.push(e.text);
      }
      let fin = true;
      outer: for (let hi = sec.hunks.length - 1; hi >= 0; hi -= 1) {
        const es = sec.hunks[hi]!.entries;
        for (let ei = es.length - 1; ei >= 0; ei -= 1) {
          if (es[ei]!.tag === '+') {
            fin = es[ei + 1]?.tag !== '\\';
            break outer;
          }
        }
      }
      tree.now.set(path, writeFile({ lines: made, br: '\n', fin }));
      return;
    }
    if (deletion) {
      const path = oldP!;
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
      return;
    }
    const from = oldP!;
    const to = newP!;
    if (!safe(from)) throw new Fail('unsafe', from);
    if (to !== from && !safe(to)) throw new Fail('unsafe', to);
    const text = tree.get(from);
    if (text === null) throw new Fail('missing', from);
    if (to !== from && tree.get(to) !== null) throw new Fail('exists', to);
    const st = parseFile(text);
    let d = 0;
    for (const h of sec.hunks) d += applyHunk(st, h, d, strict, from);
    const out = writeFile(st);
    if (to !== from) {
      tree.now.set(to, out);
      tree.now.set(from, null);
      tree.moves.push([from, to]);
    } else {
      tree.now.set(from, out);
    }
  };
}

/* Section 7: SEARCH/REPLACE blocks. */

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, writeFile({ lines: [...newLines], br: '\n', fin: true }));
      return;
    }
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    const st = parseFile(text);
    const found = findTier(st.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.at.length > 1) throw new Fail('ambiguous', path);
    const pos = found.at[0]!;
    const items: BodyItem[] = [
      ...oldLines.map((t) => ({ tag: '-' as const, text: t, raw: false })),
      ...newLines.map((t) => ({ tag: '+' as const, text: t, raw: false })),
    ];
    const rep = replacement(st.lines, pos, items, found.tier);
    st.lines.splice(pos, oldLines.length, ...rep);
    tree.now.set(path, writeFile(st));
  };
}

function parseSR(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let regionStart = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const at = i;
    let eq = -1;
    for (let j = at + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${at + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${at + 1}`);
    let path: string | null = null;
    for (let j = at - 1; j >= regionStart; j -= 1) {
      if (blank(lines[j]!)) continue;
      const t = lines[j]!.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${at + 1}`);
    edits.push(srEdit(path, lines.slice(at + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    regionStart = rep + 1;
    i = rep + 1;
  }
  return edits;
}

/* Section 8: V4A patches. */

interface VChunk {
  anchor: string | null;
  eof: boolean;
  items: BodyItem[];
}

/** The first occurrence of `o` at or after `from`, at the first tier with one; an end-of-file chunk's must end at the last line. */
function findChunk(lines: string[], o: string[], strict: boolean, from: number, eof: boolean): { tier: number; pos: number } | null {
  for (const t of strict ? [0] : [0, 1, 2]) {
    for (const pos of occurrences(lines, o, t)) {
      if (pos < from) continue;
      if (eof && pos + o.length !== lines.length) continue;
      return { tier: t, pos };
    }
  }
  return null;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isHead = (l: string): boolean => l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    let kind: 'add' | 'del' | 'update';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'del';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const headLine = i + 1;
    i += 1;
    const content: { text: string; line: number }[] = [];
    while (i < last && !isHead(lines[i]!)) {
      content.push({ text: lines[i]!, line: i + 1 });
      i += 1;
    }
    while (content.length > 0 && blank(content[content.length - 1]!.text)) content.pop();
    if (kind === 'add') {
      const made: string[] = [];
      for (const c of content) {
        if (c.text.startsWith('+')) made.push(c.text.slice(1));
        else if (c.text === '') made.push('');
        else throw new Exit2(`error: parse ${c.line}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, writeFile({ lines: made, br: '\n', fin: true }));
      });
      continue;
    }
    if (kind === 'del') {
      if (content.length > 0) throw new Exit2(`error: parse ${content[0]!.line}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
      continue;
    }
    // An Update File section: an optional Move to as its first line, then chunks.
    let moveTo: string | undefined;
    const chunks: VChunk[] = [];
    let cur: VChunk | null = null;
    let seen = false;
    const closeChunk = (): void => {
      if (cur === null) return;
      let end = cur.items.length;
      while (end > 0 && cur.items[end - 1]!.raw) end -= 1;
      cur.items = cur.items.slice(0, end);
      chunks.push(cur);
      cur = null;
    };
    for (const c of content) {
      const l = c.text;
      if (!seen && cur === null && chunks.length === 0 && l.startsWith('*** Move to: ')) {
        moveTo = l.slice('*** Move to: '.length).trim();
        seen = true;
        continue;
      }
      seen = true;
      if (l.startsWith('@@')) {
        closeChunk();
        const anchor = l.slice(2).trim();
        cur = { anchor: anchor === '' ? null : anchor, eof: false, items: [] };
        continue;
      }
      if (l.trim() === '*** End of File') {
        if (cur === null) cur = { anchor: null, eof: true, items: [] };
        cur.eof = true;
        closeChunk();
        continue;
      }
      if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
        if (cur === null) {
          if (chunks.length > 0) throw new Exit2(`error: parse ${c.line}`);
          cur = { anchor: null, eof: false, items: [] };
        }
        if (l === '') cur.items.push({ tag: ' ', text: '', raw: true });
        else cur.items.push({ tag: l[0] as ' ' | '-' | '+', text: l.slice(1), raw: false });
        continue;
      }
      throw new Exit2(`error: parse ${c.line}`);
    }
    closeChunk();
    if (chunks.length === 0 && moveTo === undefined) throw new Exit2(`error: parse ${headLine}`);
    edits.push((tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (moveTo !== undefined && !safe(moveTo)) throw new Fail('unsafe', moveTo);
      const text = tree.get(path);
      if (text === null) throw new Fail('missing', path);
      if (moveTo !== undefined && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
      const st = parseFile(text);
      let cursor = 0;
      for (const ch of chunks) {
        if (ch.anchor !== null) {
          let at = -1;
          for (const t of strict ? [0] : [0, 1, 2]) {
            for (let k = cursor; k < st.lines.length; k += 1) {
              if (lineEq(st.lines[k]!, ch.anchor, t)) {
                at = k;
                break;
              }
            }
            if (at >= 0) break;
          }
          if (at < 0) throw new Fail('no-match', path);
          cursor = at + 1;
        }
        const o = ch.items.filter((it) => it.tag !== '+').map((it) => it.text);
        if (o.length === 0) {
          const add = ch.items.filter((it) => it.tag === '+').map((it) => it.text);
          const pos = ch.eof ? st.lines.length : Math.min(cursor, st.lines.length);
          st.lines.splice(pos, 0, ...add);
          cursor = pos + add.length;
          continue;
        }
        const found = findChunk(st.lines, o, strict, cursor, ch.eof);
        if (found === null) throw new Fail('no-match', path);
        const rep = replacement(st.lines, found.pos, ch.items, found.tier);
        st.lines.splice(found.pos, o.length, ...rep);
        cursor = found.pos + rep.length;
      }
      const out = writeFile(st);
      if (moveTo !== undefined) {
        tree.now.set(moveTo, out);
        tree.now.set(path, null);
        tree.moves.push([path, moveTo]);
      } else {
        tree.now.set(path, out);
      }
    });
  }
  return edits;
}

/* Section 9: JSON edits. */

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const fin = before !== '' && before.endsWith(br);
      if (fin) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (fin ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* Sections 1, 2 and 10: the command line, the outcome, and the all-or-nothing write. */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? parseUnified(lines).map((s) => unifiedEdit(s, strict))
          : kind === 'search-replace'
            ? parseSR(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.slice();
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  interface Row {
    key: string;
    text: string;
  }
  const rows: Row[] = [];
  const paired = new Set<string>();
  for (const [o, n] of tree.moves) {
    if (paired.has(o) || paired.has(n)) continue;
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(n) === null && tree.get(n) !== null) {
      rows.push({ key: n, text: `R ${o} -> ${n}` });
      paired.add(o);
      paired.add(n);
    }
  }
  for (const p of tree.now.keys()) {
    if (paired.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key), Buffer.from(y.key)));
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
