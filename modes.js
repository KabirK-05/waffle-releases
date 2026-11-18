// Modes: the built-in ones from prompts.js plus your own. A mode has a hidden mode prompt (rules,
// built-in modes only), a context you can read and edit (first-person notes about the situation),
// and reference files the model sees while the mode is active. General has neither context nor
// files: it is Waffle's default behaviour.
//
// Stored in user data: modes.json (custom modes, edited contexts, file list) and a mode-files
// folder holding each original file, plus the extracted text for text-like formats. Text, Markdown,
// code, Word (.docx) and PowerPoint (.pptx) files become text in the system prompt; PDFs are sent
// to the model as documents.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const prompts = require('./prompts');

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_FILES_PER_MODE = 20;
const MAX_TEXT_PER_FILE = 120_000; // characters of extracted text kept per file
const MAX_TEXT_TOTAL = 300_000; // across all of a mode's files
const MAX_LABEL = 60;
const MAX_CONTEXT = 20_000;

const TEXT_EXTENSIONS = new Set(
  (
    'txt md markdown mdx rst csv tsv json jsonl yaml yml toml ini cfg conf log xml html htm css scss ' +
    'js mjs cjs jsx ts tsx py rb go rs java kt kts swift m mm c h cc cpp hpp cs php sql sh bash zsh ' +
    'ps1 r scala lua dart vue svelte tex ipynb gradle proto graphql'
  ).split(' '),
);

/** Which formats can be attached, as shown to the user and used by the file picker. */
const FILE_TYPES = {
  label: 'PDF, Word (.docx), PowerPoint (.pptx), text, Markdown, and code files. Up to 20 MB each.',
  extensions: ['pdf', 'docx', 'pptx', ...TEXT_EXTENSIONS],
};

/** How the built-in modes appear in the list: group heading and icon. */
const BUILTIN_LOOK = {
  // Cluely's list: General on its own, then "Looking for work", then the rest with no heading ("More" is not shown).
  general: { group: '', icon: 'hero-s-document-text' },
  interview: { group: 'Looking for work', icon: 'hero-o-academic-cap' },
  behavioral: { group: 'Looking for work', icon: 'hero-o-chat-bubble-left-right' },
  coding: { group: 'Looking for work', icon: 'hero-o-code-bracket' },
  systemDesign: { group: 'Looking for work', icon: 'hero-o-cpu-chip' },
  caseInterview: { group: 'Looking for work', icon: 'hero-o-presentation-chart-line' },
  recruiterScreen: { group: 'Looking for work', icon: 'hero-o-clipboard-document-check' },
  sales: { group: 'More', icon: 'hero-o-building-storefront' },
  recruiting: { group: 'More', icon: 'hero-o-briefcase' },
  meeting: { group: 'More', icon: 'hero-o-video-camera' },
  lecture: { group: 'More', icon: 'hero-o-book-open' },
};
const CUSTOM_GROUP = 'Your modes';

function kindOf(name) {
  const ext = path.extname(name).slice(1).toLowerCase();
  if (ext === 'pdf') return 'pdf';
  if (ext === 'docx' || ext === 'pptx') return ext;
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  return null;
}

// ---------- text extraction ----------

/** Read the named entries out of a .zip (docx and pptx are zips of XML). */
function unzip(buf, want) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('This file is damaged or not a real Office document.');
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let n = 0; n < count && offset + 46 <= buf.length; n += 1) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buf.readUInt16LE(offset + 10);
    const size = buf.readUInt32LE(offset + 20);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const local = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;
    if (!want(name)) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    // The output cap stops a small file from expanding into gigabytes.
    if (method === 0) out.set(name, data);
    else if (method === 8) out.set(name, zlib.inflateRawSync(data, { maxOutputLength: 64 * 1024 * 1024 }));
  }
  return out;
}

function decodeXml(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Paragraph text from Word or PowerPoint XML: paragraph ends become newlines, tags are dropped. */
function xmlText(xml, paragraphTag) {
  return decodeXml(
    xml
      .replace(new RegExp(`</${paragraphTag}>`, 'g'), '\n')
      .replace(/<w:tab\/>/g, '\t')
      .replace(/<(w:br|a:br)\/>/g, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractText(kind, buf) {
  if (kind === 'text') {
    if (buf.subarray(0, 8000).includes(0)) throw new Error('This looks like a binary file, not text.');
    return buf.toString('utf8').replace(/^﻿/, '');
  }
  if (kind === 'docx') {
    const xml = unzip(buf, (name) => name === 'word/document.xml').get('word/document.xml');
    if (!xml) throw new Error('No document text found in this Word file.');
    return xmlText(xml.toString('utf8'), 'w:p');
  }
  if (kind === 'pptx') {
    const slideNumber = (name) => Number(name.match(/slide(\d+)\.xml$/)[1]);
    const slides = [...unzip(buf, (name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))].sort(
      ([a], [b]) => slideNumber(a) - slideNumber(b),
    );
    if (!slides.length) throw new Error('No slides found in this PowerPoint file.');
    return slides.map(([name, xml]) => `Slide ${slideNumber(name)}:\n${xmlText(xml.toString('utf8'), 'a:p')}`).join('\n\n');
  }
  return '';
}

// ---------- store ----------

class ModeStore {
  constructor(dir) {
    this.file = path.join(dir, 'modes.json');
    this.filesDir = path.join(dir, 'mode-files');
    this.data = this.load();
  }

  load() {
    let saved = {};
    try {
      saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      /* first run, or unreadable: start empty */
    }
    return {
      // Custom modes saved before contexts existed kept their text in `prompt`.
      custom: Array.isArray(saved.custom)
        ? saved.custom
            .filter((m) => m && typeof m.id === 'string')
            .map(({ prompt, ...m }) => ({ ...m, context: typeof m.context === 'string' ? m.context : prompt || '' }))
        : [],
      contexts: saved.contexts && typeof saved.contexts === 'object' ? saved.contexts : {},
      files: saved.files && typeof saved.files === 'object' ? saved.files : {},
    };
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 });
  }

  has(id) {
    return id in prompts.MODES || this.data.custom.some((m) => m.id === id);
  }

  /** Everything the UI and the request builder need about one mode. */
  get(id) {
    const builtin = prompts.MODES[id];
    const custom = builtin ? null : this.data.custom.find((m) => m.id === id);
    if (!builtin && !custom) return this.get('general');
    const defaultContext = builtin ? builtin.context || '' : '';
    const edited = builtin ? typeof this.data.contexts[id] === 'string' : false;
    return {
      id,
      builtin: Boolean(builtin),
      editable: id !== 'general',
      label: builtin ? builtin.label : custom.label,
      description: builtin ? builtin.description : 'Your own mode.',
      group: builtin ? BUILTIN_LOOK[id]?.group || '' : CUSTOM_GROUP,
      icon: builtin ? BUILTIN_LOOK[id]?.icon || 'hero-o-document' : 'hero-o-document',
      modePrompt: builtin ? builtin.prompt : '', // hidden; list() leaves it out
      context: builtin ? (edited ? this.data.contexts[id] : defaultContext) : custom.context || '',
      defaultContext,
      edited,
      question: (builtin || prompts.MODES.general).question,
      files: (this.data.files[id] || []).map(({ id: fileId, name, size, kind, chars, truncated }) => ({
        id: fileId,
        name,
        size,
        kind,
        chars,
        truncated: Boolean(truncated),
      })),
    };
  }

  /** Built-in modes in their usual order, then your own, oldest first. Hidden prompts are left out. */
  list() {
    return [...prompts.MODE_IDS, ...this.data.custom.map((m) => m.id)].map((id) => {
      const { modePrompt, ...mode } = this.get(id); // eslint-disable-line no-unused-vars
      return mode;
    });
  }

  create(label) {
    const id = `custom-${crypto.randomUUID()}`;
    const name = String(label || '').trim().slice(0, MAX_LABEL) || 'New mode';
    this.data.custom.push({ id, label: name, context: '', createdAt: Date.now() });
    this.save();
    return id;
  }

  update(id, { label, context } = {}) {
    if (!this.has(id)) throw new Error('That mode no longer exists.');
    if (id === 'general') throw new Error('General has no context to edit. Create a mode instead.');
    if (prompts.MODES[id]) {
      if (typeof context === 'string') {
        const text = context.slice(0, MAX_CONTEXT);
        // Matching the default again counts as not edited, so later default changes apply.
        if (text === (prompts.MODES[id].context || '')) delete this.data.contexts[id];
        else this.data.contexts[id] = text;
      }
    } else {
      const mode = this.data.custom.find((m) => m.id === id);
      if (typeof label === 'string' && label.trim()) mode.label = label.trim().slice(0, MAX_LABEL);
      if (typeof context === 'string') mode.context = context.slice(0, MAX_CONTEXT);
    }
    this.save();
  }

  /** Put a built-in mode's context back to the default. */
  reset(id) {
    delete this.data.contexts[id];
    this.save();
  }

  remove(id) {
    if (prompts.MODES[id]) throw new Error('Built-in modes cannot be deleted.');
    for (const file of this.data.files[id] || []) this.deleteStored(file);
    delete this.data.files[id];
    this.data.custom = this.data.custom.filter((m) => m.id !== id);
    this.save();
  }

  /** Copy a file into the store and extract its text. Throws with a message for the user. */
  addFile(id, filePath) {
    if (!this.has(id)) throw new Error('That mode no longer exists.');
    if (id === 'general') throw new Error('General has no files. Create a mode to add your own documents.');
    const name = path.basename(String(filePath));
    const kind = kindOf(name);
    if (!kind) throw new Error(`${name}: this file type isn't supported.`);
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new Error(`${name}: not a file.`);
    if (stat.size > MAX_FILE_BYTES) throw new Error(`${name}: larger than 20 MB.`);
    const list = (this.data.files[id] ||= []);
    if (list.length >= MAX_FILES_PER_MODE) throw new Error(`A mode can have up to ${MAX_FILES_PER_MODE} files.`);

    const buf = fs.readFileSync(filePath);
    let text = '';
    if (kind !== 'pdf') {
      try {
        text = extractText(kind, buf);
      } catch (err) {
        throw new Error(`${name}: ${err.message}`);
      }
      if (!text.trim()) throw new Error(`${name}: no text found in this file.`);
    }
    const truncated = text.length > MAX_TEXT_PER_FILE;
    const fileId = crypto.randomUUID();
    const stored = `${fileId}${path.extname(name).toLowerCase()}`;
    fs.mkdirSync(this.filesDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(this.filesDir, stored), buf, { mode: 0o600 });
    if (kind !== 'pdf') {
      fs.writeFileSync(path.join(this.filesDir, `${fileId}.txt`), text.slice(0, MAX_TEXT_PER_FILE), { mode: 0o600 });
    }
    list.push({ id: fileId, name, size: stat.size, kind, stored, chars: Math.min(text.length, MAX_TEXT_PER_FILE), truncated, addedAt: Date.now() });
    this.save();
    return name;
  }

  removeFile(id, fileId) {
    const list = this.data.files[id] || [];
    const file = list.find((f) => f.id === fileId);
    if (!file) return;
    this.deleteStored(file);
    this.data.files[id] = list.filter((f) => f.id !== fileId);
    this.save();
  }

  deleteStored(file) {
    for (const name of [file.stored, `${file.id}.txt`]) {
      try {
        fs.rmSync(path.join(this.filesDir, name), { force: true });
      } catch {
        /* already gone */
      }
    }
  }

  /**
   * What the model gets from a mode's files: text for the system prompt (text-like files, up to
   * the total cap) and the PDFs, which each provider attaches in its own way.
   */
  references(id) {
    const files = this.data.files[id] || [];
    if (!files.length) return { text: '', pdfs: [] };
    const parts = [];
    const pdfs = [];
    let budget = MAX_TEXT_TOTAL;
    for (const file of files) {
      if (file.kind === 'pdf') {
        pdfs.push({ name: file.name, path: path.join(this.filesDir, file.stored) });
        parts.push(`<file name="${file.name}">(PDF, attached separately as a document)</file>`);
        continue;
      }
      let text = '';
      try {
        text = fs.readFileSync(path.join(this.filesDir, `${file.id}.txt`), 'utf8');
      } catch {
        continue; // removed from disk; skip it rather than fail the question
      }
      const kept = text.slice(0, Math.max(0, budget));
      budget -= kept.length;
      const cut = kept.length < text.length || file.truncated;
      parts.push(`<file name="${file.name}">\n${kept}${cut ? '\n[…the rest of this file was cut to fit]' : ''}\n</file>`);
    }
    const text =
      'Reference files the user attached to this mode. Use them when they are relevant to the question; ' +
      "don't mention them otherwise.\n\n" +
      parts.join('\n\n');
    return { text, pdfs };
  }
}

module.exports = { ModeStore, FILE_TYPES };
