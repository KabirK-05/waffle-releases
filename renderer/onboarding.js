// First-run setup, rebuilt from Cluely's onboarding (its /onboarding/* routes, onboarding.css and
// the Tailwind classes on each page) with Cluely's account sign-in left out. Steps, in Cluely's order:
//   welcome       Cluely's sign-in page without the sign-in: brand, heading, Continue
//   ai            new: pick the Claude or ChatGPT subscription and get it signed in
//   permissions   "Let's get you set up": microphone, system audio, screen (Cluely: accessibility, mic, screen)
//   ask           "Press ↵ to get an instant answer"
//   hide          ⌘\ hides and shows the overlay
//   move          ⌘ + arrows move it
//   listen        start a listening session
//   notes         end it to get notes
//   undetectable  the eye toggle, then finish (Cluely continues to its plans and billing; Waffle has none)
// Everything is built as DOM nodes, so the page's CSP needs no inline markup or styles.

const api = window.waffle;
const isMac = api.platform === 'darwin';
const root = document.getElementById('root');
const STEPS = ['welcome', 'ai', 'permissions', 'ask', 'hide', 'move', 'listen', 'notes', 'undetectable'];

// ---------- helpers ----------

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value !== false && value != null) el.setAttribute(key, value === true ? '' : value);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of [children].flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function svg(viewBox, elements, cls = '', { fill = false } = {}) {
  const el = document.createElementNS(SVG_NS, 'svg');
  el.setAttribute('viewBox', viewBox);
  el.setAttribute('aria-hidden', 'true');
  el.setAttribute('class', `${fill ? 'ob-fill' : 'ob-ico'} ${cls}`.trim());
  for (const [tag, attrs] of elements) {
    const child = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) child.setAttribute(key, value);
    el.append(child);
  }
  return el;
}

// Lucide icons (ISC), the same ones Cluely's onboarding imports.
const LUCIDE = {
  'chevron-right': [['path', { d: 'm9 18 6-6-6-6' }]],
  'chevron-left': [['path', { d: 'm15 18-6-6 6-6' }]],
  'corner-down-left': [['path', { d: 'M20 4v7a4 4 0 0 1-4 4H4' }], ['path', { d: 'm9 10-5 5 5 5' }]],
  'arrow-down': [['path', { d: 'M12 5v14' }], ['path', { d: 'm19 12-7 7-7-7' }]],
  'arrow-up': [['path', { d: 'm5 12 7-7 7 7' }], ['path', { d: 'M12 19V5' }]],
  'arrow-left': [['path', { d: 'm12 19-7-7 7-7' }], ['path', { d: 'M19 12H5' }]],
  'arrow-right': [['path', { d: 'M5 12h14' }], ['path', { d: 'm12 5 7 7-7 7' }]],
  image: [['rect', { width: 18, height: 18, x: 3, y: 3, rx: 2, ry: 2 }], ['circle', { cx: 9, cy: 9, r: 2 }], ['path', { d: 'm21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21' }]],
  eye: [['path', { d: 'M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0' }], ['circle', { cx: 12, cy: 12, r: 3 }]],
  'layout-grid': [['rect', { width: 7, height: 7, x: 3, y: 3, rx: 1 }], ['rect', { width: 7, height: 7, x: 14, y: 3, rx: 1 }], ['rect', { width: 7, height: 7, x: 14, y: 14, rx: 1 }], ['rect', { width: 7, height: 7, x: 3, y: 14, rx: 1 }]],
  'audio-lines': [['path', { d: 'M2 10v3' }], ['path', { d: 'M6 6v11' }], ['path', { d: 'M10 3v18' }], ['path', { d: 'M14 8v7' }], ['path', { d: 'M18 5v13' }], ['path', { d: 'M22 10v3' }]],
  mic: [['path', { d: 'M12 19v3' }], ['path', { d: 'M19 10v2a7 7 0 0 1-14 0v-2' }], ['rect', { x: 9, y: 2, width: 6, height: 13, rx: 3 }]],
  monitor: [['rect', { width: 20, height: 14, x: 2, y: 3, rx: 2 }], ['line', { x1: 8, x2: 16, y1: 21, y2: 21 }], ['line', { x1: 12, x2: 12, y1: 17, y2: 21 }]],
  check: [['path', { d: 'M20 6 9 17l-5-5' }]],
  pause: [['rect', { x: 14, y: 3, width: 5, height: 18, rx: 1 }], ['rect', { x: 5, y: 3, width: 5, height: 18, rx: 1 }]],
  square: [['rect', { width: 18, height: 18, x: 3, y: 3, rx: 2 }]],
  'calendar-days': [['path', { d: 'M8 2v4' }], ['path', { d: 'M16 2v4' }], ['rect', { width: 18, height: 18, x: 3, y: 4, rx: 2 }], ['path', { d: 'M3 10h18' }], ['path', { d: 'M8 14h.01' }], ['path', { d: 'M12 14h.01' }], ['path', { d: 'M16 14h.01' }], ['path', { d: 'M8 18h.01' }], ['path', { d: 'M12 18h.01' }], ['path', { d: 'M16 18h.01' }]],
  'file-text': [['path', { d: 'M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z' }], ['path', { d: 'M14 2v5a1 1 0 0 0 1 1h5' }], ['path', { d: 'M10 9H8' }], ['path', { d: 'M16 13H8' }], ['path', { d: 'M16 17H8' }]],
};
const icon = (name, cls = '') => svg('0 0 24 24', LUCIDE[name], cls);

// Lucide's users icon (ISC) for the notes demo, and the backslash keycap glyph.
const usersIcon = (cls) =>
  svg('0 0 24 24', [
    ['path', { d: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2' }],
    ['circle', { cx: 9, cy: 7, r: 4 }],
    ['path', { d: 'M22 21v-2a4 4 0 0 0-3-3.87' }],
    ['path', { d: 'M16 3.13a4 4 0 0 1 0 7.75' }],
  ], cls);
const backslashIcon = (cls) => svg('0 0 9 19', [['path', { d: 'M8.75601 18.92H6.49001L7.86036e-06 -1.3113e-06H2.26601L8.75601 18.92Z' }]], cls, { fill: true });

/** Waffle's mark ("app-mark" in icons.js, as in the overlay toolbar) stands wherever Cluely shows its logo. */
function waffleMark(cls) {
  const data = window.WAFFLE_ICONS['app-mark'];
  return svg(data.v, data.els, `ob-mark ${cls}`, { fill: true });
}

// ---------- drawn pictures ----------
// The permission steps and the ask demo show macOS dialogs, a System Settings list and an app
// on screen. They are drawn here in HTML and CSS (classes .ob-mac-*, .ob-ed-*), not pictures.

/** A macOS alert: an optional icon, a bold title, body text and buttons. */
function macAlert({ cls, iconEl, title, body, buttons, wide = false }) {
  return h(
    'div',
    { class: `ob-mac-alert ${wide ? 'ob-mac-alert-wide' : ''} ${cls} ob-pop`, 'aria-hidden': 'true' },
    iconEl && h('div', { class: 'ob-mac-alert-icon' }, iconEl),
    h(
      'div',
      { class: 'ob-mac-alert-text' },
      h('p', { class: 'ob-mac-alert-title' }, title),
      h('p', { class: 'ob-mac-alert-body' }, body),
      h('div', { class: 'ob-mac-alert-buttons' }, buttons.map(([label, tone]) => h('span', { class: `ob-mac-btn ${tone || ''}` }, label))),
    ),
  );
}

function micAlert() {
  const tile = h('div', { class: 'ob-mac-tile' }, icon('mic', 'ob-mac-tile-glyph'), h('span', { class: 'ob-mac-badge' }));
  return macAlert({
    cls: 'ob-dialog-sm',
    iconEl: tile,
    title: '“Waffle” would like to access the Microphone.',
    body: 'Waffle transcribes your microphone while you are listening to a meeting.',
    buttons: [["Don't Allow"], ['Allow']],
  });
}

function restartAlert() {
  return macAlert({
    cls: 'ob-dialog-sm',
    title: '“Waffle” may not be able to record the contents of your screen until it is quit.',
    body: 'You can choose to quit “Waffle” now, or do it on your own later.',
    buttons: [['Quit and Reopen', 'blue'], ['Later']],
  });
}

function screenAlert() {
  const lock = h('div', { class: 'ob-mac-lock' }, h('span', { class: 'ob-mac-lock-shackle' }), h('span', { class: 'ob-mac-lock-body' }), h('span', { class: 'ob-mac-rec' }));
  return macAlert({
    cls: 'ob-perm-dialog',
    wide: true,
    iconEl: lock,
    title: '“Waffle” would like to record this computer’s screen and audio.',
    body: 'Grant access to this application in Privacy & Security settings, located in System Settings.',
    buttons: [['Open System Settings'], ['Deny', 'blue']],
  });
}

/** System Settings → Privacy & Security → Screen & System Audio Recording, Waffle switched on. */
function settingsList(extra = '') {
  const other = (hue, on) =>
    h('div', { class: 'ob-mac-row ob-mac-row-blur' }, h('span', { class: 'ob-mac-app', 'data-hue': hue }), h('span', { class: 'ob-mac-name' }), h('span', { class: `ob-mac-switch ${on ? 'on' : ''}` }));
  return h(
    'div',
    { class: `ob-mac-settings ob-perm-settings ob-pop ${extra}`, 'aria-hidden': 'true' },
    h('div', { class: 'ob-mac-side' }),
    h(
      'div',
      { class: 'ob-mac-pane' },
      h('p', { class: 'ob-mac-pane-title' }, 'Screen & System Audio Recording'),
      h('p', { class: 'ob-mac-pane-sub' }, 'Allow the applications below to record the content of your screen and audio, even while using other applications.'),
      h(
        'div',
        { class: 'ob-mac-list' },
        other('a', true),
        other('b', true),
        h('div', { class: 'ob-mac-row' }, h('span', { class: 'ob-mac-app ob-mac-app-waffle' }, waffleMark('ob-mac-app-mark')), h('span', { class: 'ob-mac-name ob-mac-name-on' }, 'Waffle'), h('span', { class: 'ob-mac-switch on' })),
        other('c', true),
        other('d', false),
      ),
    ),
  );
}

/** A video editor on screen for the ask demo: panels, two monitors and a timeline. */
function editorScreen() {
  const lines = (n) => Array.from({ length: n }, (_, i) => h('span', { class: `ob-ed-line w${(i * 37) % 4}` }));
  const clips = (row) => row.map(([w, tone]) => h('span', { class: `ob-ed-clip ${tone}`, 'data-w': w }));
  return h(
    'div',
    { class: 'ob-editor', 'aria-hidden': 'true' },
    h(
      'div',
      { class: 'ob-ed-top' },
      h('div', { class: 'ob-ed-panel' }, lines(9)),
      h('div', { class: 'ob-ed-monitor ob-ed-forest' }, h('span', { class: 'ob-ed-scrub' })),
      h('div', { class: 'ob-ed-monitor ob-ed-sky' }, h('span', { class: 'ob-ed-scrub' })),
    ),
    h(
      'div',
      { class: 'ob-ed-bottom' },
      h('div', { class: 'ob-ed-bin' }, Array.from({ length: 6 }, (_, i) => h('span', { class: `ob-ed-thumb t${i % 3}` }))),
      h(
        'div',
        { class: 'ob-ed-timeline' },
        h('span', { class: 'ob-ed-playhead' }),
        h('div', { class: 'ob-ed-track' }, clips([[2, 'v'], [5, 'v'], [1, 'v'], [3, 'v'], [4, 'v']])),
        h('div', { class: 'ob-ed-track' }, clips([[2, 'a'], [5, 'a'], [1, 'a'], [3, 'a'], [4, 'a']])),
        h('div', { class: 'ob-ed-track ob-ed-empty' }),
      ),
    ),
  );
}

/** The account logos from icons.js, in their brand colours. */
function brandLogo(name, cls) {
  const data = window.WAFFLE_ICONS[name];
  const el = svg(data.v, data.els, `ob-logo ${name} ${cls}`, { fill: true });
  return el;
}

/** A stroke icon from icons.js (key-round, copy) for the few Lucide icons not drawn above. */
function waffleIcon(name, cls = '') {
  const data = window.WAFFLE_ICONS[name];
  return svg(data.v, data.els, cls, { fill: Boolean(data.fill) });
}

/** Copy text to the clipboard (the user just clicked, so the browser allows it). */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = h('textarea', {});
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
}

/**
 * A password field with Save, for an API key. `save(key)` stores it (the key goes straight to
 * the main process, which encrypts it; it is never shown again or logged).
 */
function keyField({ placeholder, save, label = 'Save' }) {
  const input = h('input', { type: 'password', class: 'ob-key-input', placeholder, spellcheck: 'false', autocomplete: 'off' });
  const saveBtn = h('button', { type: 'button', class: 'ob-key-save', disabled: true }, label);
  const error = h('p', { class: 'ob-key-error', hidden: true });
  const submit = async () => {
    const value = input.value.trim();
    if (!value) return;
    saveBtn.disabled = true;
    error.hidden = true;
    try {
      await save(value);
      input.value = '';
    } catch (err) {
      error.textContent = cleanError(err);
      error.hidden = false;
    }
    saveBtn.disabled = !input.value.trim();
  };
  input.addEventListener('input', () => {
    saveBtn.disabled = !input.value.trim();
    error.hidden = true;
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submit();
  });
  saveBtn.addEventListener('click', submit);
  return { el: h('div', { class: 'ob-key-field' }, h('div', { class: 'ob-key-row' }, input, saveBtn), error), input };
}

/** Which service a pasted key belongs to, by its prefix. */
function keyKind(key) {
  if (/^sk-ant-/.test(key)) return 'anthropic';
  if (/^sk-/.test(key)) return 'openai';
  return null;
}

const modKey = isMac ? '⌘' : 'Ctrl';
const isMod = (event) => (isMac ? event.metaKey : event.ctrlKey);

// ---------- state ----------

let state = null;
const listeners = new Set();
let disposers = []; // cleanups for the step on screen

function watch(fn) {
  listeners.add(fn);
  fn(state);
  disposers.push(() => listeners.delete(fn));
}

function onDispose(fn) {
  disposers.push(fn);
}

function later(fn, ms) {
  const id = setTimeout(fn, ms);
  onDispose(() => clearTimeout(id));
  return id;
}

function every(fn, ms) {
  const id = setInterval(fn, ms);
  onDispose(() => clearInterval(id));
  return id;
}

function listen(target, type, fn, options) {
  target.addEventListener(type, fn, options);
  onDispose(() => target.removeEventListener(type, fn, options));
}

/** Keys held right now, as Cluely's useKeyPressed tracks them (by event.key). */
function trackKeys(onChange) {
  const held = new Set();
  const timers = new Map();
  const set = (key, down) => {
    if (down === held.has(key)) return;
    down ? held.add(key) : held.delete(key);
    onChange(held);
  };
  listen(window, 'keydown', (event) => {
    set(event.key, true);
    // macOS sends no keyup for a key pressed while ⌘ is held, so let those go on a timer.
    if (event.metaKey && event.key !== 'Meta') {
      clearTimeout(timers.get(event.key));
      timers.set(event.key, setTimeout(() => set(event.key, false), 180));
    }
  });
  listen(window, 'keyup', (event) => {
    set(event.key, false);
    if (event.key === 'Meta') for (const key of [...held]) set(key, false);
  });
  listen(window, 'blur', () => {
    for (const key of [...held]) set(key, false);
  });
  onDispose(() => timers.forEach((id) => clearTimeout(id)));
  return held;
}

/** Fade a heading out (up 6px) and the new text in (from 6px below), like AnimatePresence mode="wait". */
function swapText(el, children) {
  el.classList.add('ob-swap-out');
  later(() => {
    el.replaceChildren();
    append(el, children);
    el.classList.remove('ob-swap-out');
    el.classList.add('ob-swap-from');
    void el.offsetWidth;
    el.classList.remove('ob-swap-from');
  }, 200);
}

const lines = (a, b) => [a, h('br'), b];

// ---------- shared pieces (onboarding-page, onboarding-button, onboarding-icons) ----------

const layout = (cls, ...children) => h('div', { class: `ob-layout ${cls}` }, children);
const left = (cls, ...children) => h('div', { class: `ob-left ${cls}` }, children);

function right(cls, ...children) {
  return h(
    'div',
    { class: `ob-right ${cls}` },
    h('div', { class: 'ob-grid' }),
    h('div', { class: 'ob-glow' }),
    h('div', { class: 'ob-right-content' }, children),
  );
}

const caption = (...children) => h('div', { class: 'ob-caption' }, children);

/** Cluely's onboarding button: primary (blue), ghost or secondary; full width (h-11) or fit. */
function button({ variant = 'primary', size = 'default', cls = '', onClick, disabled = false } = {}, ...children) {
  return h('button', { type: 'button', class: `ob-btn ob-btn-${variant} ob-btn-${size} ${cls}`, onClick, disabled }, children);
}

const continueButton = (onClick, label = 'Continue', cls = 'ob-btn-demo') => button({ cls, onClick }, label, icon('chevron-right', 'ob-s4'));
const waitButton = (label) => h('button', { type: 'button', class: 'ob-wait', disabled: true }, label);
const backButton = (step) => h('button', { type: 'button', class: 'ob-back', onClick: () => go(step) }, icon('chevron-left', 'ob-s4'), h('span', {}, 'Back'));

const brand = () => h('div', { class: 'ob-brand' }, waffleMark('ob-brand-mark'), h('span', {}, 'Waffle'));

/** The left column of every demo page: heading, line of help, then the action. */
function demoColumn(heading, sub, ...rest) {
  return h('div', { class: 'ob-col' }, heading, sub, rest);
}

const demoHeading = (children, cls = '') => {
  const span = h('span', { class: 'ob-swap' }, children);
  return [h('h1', { class: `ob-h1 ${cls}` }, span), span];
};

// ---------- the overlay mock-ups ----------

const caret = (cls = '') => h('span', { class: `ob-caret ${cls}`, 'aria-hidden': 'true' });
const chip = (child, cls = '') => h('span', { class: `ob-chip ${cls}` }, child);
const tool = (child, cls = '') => h('div', { class: `ob-tool ${cls}` }, child);
const divider = (cls = '') => h('div', { class: `ob-divider ${cls}`, 'aria-hidden': 'true' });

/** Three rings that grow out of a control to say "click me" (Cluely's ToggleHintPulse). */
const pulse = (cls = 'ob-pulse-sm') => h('span', { class: `ob-pulse ${cls}`, 'aria-hidden': 'true' }, [0, 1, 2].map((i) => h('span', { class: `ob-ring ob-ring-${i}` })));

/** The frosted card the ask box sits in (desktop-ui's card). */
const card = (...children) => h('div', { class: 'ob-card' }, children);

/** The small ask box used by the hide, move, listen, notes and undetectable demos. */
function askBox(inputRow, ...rest) {
  return card(h('div', { class: 'ob-box' }, inputRow, rest));
}

function inputRow(cls = '') {
  return h(
    'div',
    { class: `ob-input ${cls}` },
    caret(),
    h('span', { class: 'ob-input-text' }, 'Ask anything'),
    h('div', { class: 'ob-input-send' }, chip(icon('corner-down-left', 'ob-s3 ob-stroke-23'))),
  );
}

function historyLabel() {
  return h('div', { class: 'ob-history' }, h('span', {}, 'History'), chip(icon('arrow-down', 'ob-s3')));
}

/** The toolbar under the small ask box. `middle` replaces the centre group when given. */
function smallToolbar({ middle, end } = {}) {
  return h(
    'div',
    { class: 'ob-toolbar' },
    h('div', { class: 'ob-toolbar-start' }, tool(waffleMark('ob-s18'))),
    middle === undefined
      ? h('div', { class: 'ob-tools' }, tool(icon('image', 'ob-s18')), tool(icon('eye', 'ob-s18')), tool(icon('layout-grid', 'ob-s18')), divider(), tool(icon('audio-lines', 'ob-s19')))
      : middle,
    h('div', { class: 'ob-toolbar-end' }, end || historyLabel()),
  );
}

/**
 * The video call behind the demos: a call window drawn here (to the geometry and colours of the
 * clip Cluely ships), with two generated, silent, looping webcam tiles in it.
 */
function meetingVideo() {
  const tile = (src) => {
    const video = h('video', { class: 'ob-call-video', src, autoplay: true, loop: true, muted: true, playsinline: true });
    video.muted = true;
    return h('div', { class: 'ob-call-tile' }, video);
  };
  const VIDEO_OFF = [['path', { d: 'M10.66 6H14a2 2 0 0 1 2 2v2.5l5.248-3.062A.5.5 0 0 1 22 7.87v8.196' }], ['path', { d: 'M16 16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2' }], ['path', { d: 'm2 2 20 20' }]];
  return h(
    'div',
    { class: 'ob-meeting', 'aria-hidden': 'true' },
    h(
      'div',
      { class: 'ob-call' },
      h('div', { class: 'ob-call-bar' }, h('span', { class: 'ob-call-dot red' }), h('span', { class: 'ob-call-dot yellow' }), h('span', { class: 'ob-call-dot green' })),
      h('div', { class: 'ob-call-stage' }, tile('onboarding/call-1.webm'), tile('onboarding/call-2.webm')),
      h(
        'div',
        { class: 'ob-call-controls' },
        h('span', { class: 'ob-call-ctl' }, icon('mic'), 'Unmute'),
        h('span', { class: 'ob-call-ctl' }, svg('0 0 24 24', VIDEO_OFF), 'Start Video'),
        h('span', { class: 'ob-call-end' }, 'End'),
      ),
    ),
  );
}

/** A meeting with an ask box laid over its top edge (listen, notes and undetectable demos). */
function meetingStage(box, ...overlays) {
  return h('div', { class: 'ob-stage' }, meetingVideo(), h('div', { class: 'ob-stage-box' }, box, overlays));
}

/**
 * A blue "click here" tip under a toolbar control. The box clips its contents, so the tip sits in
 * the stage beside it and is placed under the control once laid out.
 */
function callout(text) {
  const tip = h('div', { class: 'ob-callout', hidden: true }, h('span', { class: 'ob-callout-arrow', 'aria-hidden': 'true' }), text);
  let target = null;
  const place = () => {
    if (!target || !target.isConnected || !tip.parentElement) return;
    const box = tip.parentElement.getBoundingClientRect();
    const r = target.getBoundingClientRect();
    tip.style.left = `${r.left + r.width / 2 - box.left}px`;
    tip.style.top = `${r.bottom - box.top + 12}px`;
  };
  listen(window, 'resize', place);
  return {
    el: tip,
    /** Point at `el`, or hide the tip with null. */
    point(el) {
      target = el;
      tip.hidden = !el;
      requestAnimationFrame(() => requestAnimationFrame(place));
    },
  };
}

/** Cluely's ghost "Skip >" link under a step's button; `delay` ms before it fades in. */
function skipLink(onSkip, delay = 600) {
  const skip = button({ variant: 'ghost', size: 'fit', cls: 'ob-skip', onClick: onSkip }, 'Skip', icon('chevron-right', 'ob-s4'));
  const wrap = h('div', { class: 'ob-skip-wrap ob-skip-quick' }, skip);
  later(() => wrap.classList.add('is-ready', 'is-shown'), delay);
  return {
    el: wrap,
    show(visible) {
      wrap.classList.toggle('is-gone', !visible);
      skip.disabled = !visible;
    },
  };
}

/** Session controls: pause, stop and a running clock. */
function sessionControls({ onStop, startAt = 0, stopPulse = false, onStopButton } = {}) {
  let seconds = startAt;
  const clock = h('span', { class: 'ob-clock' }, fmt(seconds));
  every(() => {
    seconds += 1;
    clock.textContent = fmt(seconds);
  }, 1000);
  const stopButton = h('button', { type: 'button', class: `ob-session-stop ${stopPulse ? 'ob-stop-hint' : ''}`, 'aria-label': 'Stop recording', onClick: onStop }, stopPulse && pulse('ob-pulse-sm ob-pulse-blue'), svg('0 0 24 24', LUCIDE.square, 'ob-s25 ob-rel', { fill: true }));
  onStopButton?.(stopButton);
  return h(
    'div',
    { class: 'ob-session' },
    h('button', { type: 'button', class: 'ob-session-pause', 'aria-label': 'Pause audio session' }, svg('0 0 24 24', LUCIDE.pause, 'ob-s35', { fill: true })),
    stopButton,
    clock,
  );
}

const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

/** Cluely's real-time demo: an ask box over a meeting that presses ↵ and answers, on a loop. */
function realTimeDemo() {
  const DURATION = { chat: 2400, home: 900, press: 260 };
  const NEXT = { chat: 'home', home: 'press', press: 'chat' };
  let phase = 'home';

  const back = h('div', { class: 'ob-rt-back' }, icon('arrow-left', 'ob-s45'));
  const send = h('div', { class: 'ob-rt-send' }, icon('corner-down-left', 'ob-s35'));
  const head = h(
    'div',
    { class: 'ob-rt-head' },
    back,
    h('div', { class: 'ob-rt-ask' }, caret('ob-caret-lg ob-caret-bright'), h('span', {}, 'Ask anything about your screen')),
    send,
  );
  const body = h(
    'div',
    { class: 'ob-rt-body' },
    h(
      'div',
      { class: 'ob-rt-answer' },
      h('div', { class: 'ob-rt-viewed' }, icon('eye', 'ob-s4'), 'Viewed screen'),
      h('p', {}, 'Waffle is your invisible AI assistant. It sees your screen, listens to your meetings, and answers in context — so you can stay focused without breaking flow.'),
    ),
    h('div', { class: 'ob-rt-assist' }, 'Assist'),
  );
  const keycap = (text, cls = '') => h('span', { class: `ob-keycap ${cls}` }, text);
  const endHistory = h('div', { class: 'ob-rt-end' }, h('span', { class: 'ob-rt-end-label' }, 'History'), keycap(icon('arrow-down', 'ob-s35'), 'ob-keycap-sq'));
  const endChat = h('div', { class: 'ob-rt-end' }, h('span', { class: 'ob-rt-end-label' }, 'New Chat'), h('span', { class: 'ob-keys' }, keycap(isMac ? '⌘' : 'Ctrl'), keycap('R')));
  const rtTool = (child) => h('div', { class: 'ob-rt-tool' }, child);
  const foot = h(
    'div',
    { class: 'ob-rt-foot' },
    waffleMark('ob-s5'),
    h('div', { class: 'ob-rt-tools' }, rtTool(icon('image')), rtTool(icon('eye')), rtTool(icon('layout-grid')), h('div', { class: 'ob-rt-divider' }), rtTool(icon('audio-lines', 'ob-s21'))),
    endHistory,
    endChat,
  );
  const box = h('div', { class: 'ob-rt-card' }, head, body, foot);

  function paint() {
    const chat = phase === 'chat';
    box.classList.toggle('is-chat', chat);
    send.classList.toggle('is-pressed', phase === 'press');
    back.hidden = !chat;
    endHistory.hidden = chat;
    endChat.hidden = !chat;
    body.classList.toggle('is-shown', chat);
  }
  function tick() {
    later(() => {
      phase = NEXT[phase];
      paint();
      tick();
    }, DURATION[phase]);
  }
  paint();
  tick();

  return h(
    'div',
    { class: 'ob-rt' },
    h('div', { class: 'ob-rt-stage' }, meetingVideo(), h('div', { class: 'ob-rt-over' }, box)),
    caption(h('h2', { class: 'ob3-secondary-header ob-rt-caption' }, lines('Your real-time AI assistant,', 'always ready to help'))),
  );
}

// ---------- steps ----------

let current = null;

function go(step) {
  for (const dispose of disposers) dispose();
  disposers = [];
  current = STEPS.includes(step) ? step : 'welcome';
  if (state.onboardingStep !== current) api.patchState({ onboardingStep: current });
  root.replaceChildren(h('div', { class: 'ob-drag' }), STEP_VIEWS[current]());
}

const next = () => go(STEPS[STEPS.indexOf(current) + 1]);

/** Cluely's sign-in page with the sign-in taken out: brand, welcome, Continue. */
function welcomeStep() {
  return layout(
    '',
    left(
      'ob-justify-between',
      h('div'),
      h(
        'div',
        { class: 'ob-welcome' },
        h(
          'div',
          { class: 'ob-welcome-head' },
          brand(),
          h(
            'div',
            { class: 'ob-welcome-titles' },
            h('h1', { class: 'ob3-secondary-header ob-title-4xl' }, 'Welcome to Waffle'),
            h('h2', { class: 'ob-welcome-sub' }, 'The ultimate AI assistant'),
          ),
        ),
        h('div', { class: 'ob-full' }, continueButton(next, 'Continue', '')),
      ),
      h('div'),
    ),
    right('ob-p5', realTimeDemo()),
  );
}

/** One of Cluely's permission rows: icon, title, description and a switch on the right. */
function settingRow({ iconEl, title, description, onClick }) {
  const badge = h(
    'div',
    { class: 'ob-row-badge', hidden: true },
    h('div', { class: 'ob-row-badge-dot' }, svg('0 0 16 16', [['path', { d: 'M12.9 4.56 6.6 10.85 3.1 7.34', stroke: 'currentColor', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'stroke-width': '2.8', fill: 'none' }]], 'ob-s25')),
  );
  const desc = h('p', { class: 'ob-row-desc' }, description);
  const thumb = h('span', { class: 'ob-switch-thumb' });
  const toggle = h('div', { class: 'ob-switch', 'aria-hidden': 'true' }, thumb);
  const btn = h(
    'button',
    { type: 'button', class: 'ob-row', onClick: () => btn.classList.contains('is-live') && onClick() },
    h('div', { class: 'ob-row-main' }, h('div', { class: 'ob-row-icon' }, iconEl, badge), h('div', { class: 'ob-row-text' }, h('h3', {}, title), desc)),
    toggle,
  );
  const wrap = h('div', { class: 'ob-row-wrap' }, btn);
  return {
    el: wrap,
    desc,
    /** live: clickable; checked: switch on; done: green badge; dim: a later step, faded and shrunk. */
    set({ live, checked, done, dim, description: text }) {
      btn.classList.toggle('is-live', live);
      btn.disabled = !live;
      wrap.classList.toggle('is-dim', dim);
      toggle.classList.toggle('is-on', checked);
      toggle.classList.toggle('is-faded', !live && !checked);
      badge.hidden = !done;
      if (text !== undefined) desc.textContent = text;
    },
  };
}

const PROVIDERS = {
  claude: { name: 'Claude', cli: 'Claude Code', logo: 'logo-claude', title: 'Use your Claude subscription' },
  chatgpt: { name: 'ChatGPT', cli: 'Codex CLI', logo: 'logo-chatgpt', title: 'Use your ChatGPT subscription' },
};
const cleanError = (err) => String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/** New step in place of Cluely's account sign-in: choose the subscription Waffle answers with. */
function aiStep() {
  const keyReady = (s) => (s.provider === 'api' && s.hasKey) || (s.provider === 'openai' && s.hasSpeechKey);
  let choice = ['claude', 'chatgpt'].includes(state.provider) ? state.provider : keyReady(state) ? 'key' : null;
  if (!choice) choice = ['claude', 'chatgpt'].find((p) => state.auth[p]?.signedIn) || null;
  const notes = { claude: '', chatgpt: '' }; // a message from the last sign-in attempt
  const waiting = { claude: false, chatgpt: false };
  api.refreshProviders();

  const pick = (provider) => {
    choice = provider;
    if (provider !== 'key') api.patchState({ provider });
    paint(state);
    if (provider === 'key') requestAnimationFrame(() => keyInput.input.focus());
  };
  const rows = Object.fromEntries(
    Object.entries(PROVIDERS).map(([id, info]) => [
      id,
      settingRow({ iconEl: brandLogo(info.logo, 'ob-s5'), title: info.title, description: '', onClick: () => pick(id) }),
    ]),
  );

  // Third option: an Anthropic or OpenAI API key instead of a subscription.
  const keyRow = settingRow({ iconEl: waffleIcon('key-round'), title: 'Use an API key instead', description: '', onClick: () => pick('key') });
  const keyInput = keyField({
    placeholder: 'Paste your API key',
    save: async (key) => {
      const kind = keyKind(key);
      if (!kind) throw new Error('That doesn’t look like an Anthropic (sk-ant-…) or OpenAI (sk-…) API key.');
      if (kind === 'anthropic') await api.setApiKey(key);
      else await api.setSpeechKey(key); // Waffle's one OpenAI key, also used for transcription
      await api.patchState({ provider: kind === 'anthropic' ? 'api' : 'openai' });
    },
  });
  const keyBox = h('div', { class: 'ob-extra' }, keyInput.el);

  // When the chosen CLI is missing: its install command, with a copy button.
  const installCode = h('code', { class: 'ob-install-code' });
  const copyBtn = h('button', { type: 'button', class: 'ob-copy', 'aria-label': 'Copy command' }, waffleIcon('copy', 'ob-s35'), h('span', {}, 'Copy'));
  const installLabel = h('p', { class: 'ob-install-label' });
  const installBox = h('div', { class: 'ob-extra' }, installLabel, h('div', { class: 'ob-install' }, installCode, copyBtn));
  copyBtn.addEventListener('click', async () => {
    await copyText(installCode.textContent);
    copyBtn.replaceChildren(icon('check', 'ob-s35'), h('span', {}, 'Copied'));
    later(() => copyBtn.replaceChildren(waffleIcon('copy', 'ob-s35'), h('span', {}, 'Copy')), 1600);
  });
  const skip = skipLink(next);

  async function signIn(provider) {
    waiting[provider] = true;
    notes[provider] = `Finish signing in to ${PROVIDERS[provider].cli} in the Terminal window and your browser. This updates on its own.`;
    paint(state);
    try {
      await api.signInProvider(provider);
    } catch (err) {
      waiting[provider] = false;
      notes[provider] = cleanError(err);
      paint(state);
    }
  }

  const action = button({ onClick: () => {} });
  function setAction(label, onClick, { disabled = false, chevron = false } = {}) {
    action.replaceChildren();
    append(action, [label, chevron && icon('chevron-right', 'ob-s4')]);
    action.onclick = onClick;
    action.disabled = disabled;
  }

  function paint(s) {
    for (const [id, row] of Object.entries(rows)) {
      const auth = s.auth[id] || {};
      if (auth.signedIn) waiting[id] = false;
      const status = auth.checking
        ? 'Checking…'
        : notes[id] && !auth.signedIn
          ? notes[id]
          : !auth.installed
            ? `${PROVIDERS[id].cli} isn’t installed yet.`
            : auth.disconnected
              ? `Signed in to ${PROVIDERS[id].cli}, disconnected from Waffle.`
              : `${PROVIDERS[id].cli}: ${auth.detail || ''}`;
      row.set({ live: true, checked: choice === id, done: Boolean(auth.signedIn), dim: false, description: status });
      row.el.classList.toggle('is-chosen', choice === id);
    }
    const keyStatus = keyReady(s)
      ? `${s.provider === 'api' ? 'Anthropic' : 'OpenAI'} key saved.`
      : s.hasKey || s.hasSpeechKey
        ? `${s.hasKey ? 'Anthropic' : 'OpenAI'} key saved. Pick this to answer with it.`
        : 'Pay per use with an Anthropic or OpenAI key.';
    keyRow.set({ live: true, checked: choice === 'key', done: keyReady(s), dim: false, description: keyStatus });
    keyRow.el.classList.toggle('is-chosen', choice === 'key');

    const cliChoice = choice === 'claude' || choice === 'chatgpt' ? s.auth[choice] || {} : null;
    const missingCli = cliChoice && !cliChoice.checking && !cliChoice.installed;
    installBox.hidden = !missingCli;
    if (missingCli) {
      installLabel.textContent = `Install ${PROVIDERS[choice].cli} in Terminal, then come back:`;
      installCode.textContent = (cliChoice.detail || '').replace(/^[^:]*:\s*/, '');
    }
    keyBox.hidden = choice !== 'key' || keyReady(s);

    let ready = false;
    if (!choice) setAction('Continue', null, { disabled: true, chevron: true });
    else if (choice === 'key') {
      ready = keyReady(s);
      if (ready) setAction('Continue', next, { chevron: true });
      else if (s.hasKey || s.hasSpeechKey) setAction(`Use the saved ${s.hasKey ? 'Anthropic' : 'OpenAI'} key`, () => api.patchState({ provider: s.hasKey ? 'api' : 'openai' }));
      else setAction('Paste a key above', null, { disabled: true });
    } else {
      const auth = cliChoice;
      const info = PROVIDERS[choice];
      ready = Boolean(auth.signedIn);
      if (auth.checking) setAction('Checking…', null, { disabled: true });
      else if (auth.signedIn) setAction('Continue', () => (api.patchState({ provider: choice }), next()), { chevron: true });
      else if (!auth.installed) setAction('Check again', () => api.refreshProviders());
      else if (waiting[choice]) setAction('Waiting for sign-in…', () => signIn(choice));
      else if (auth.disconnected) setAction(`Connect ${info.name}`, () => api.connectProvider(choice));
      else setAction(`Sign in with ${info.name}`, () => signIn(choice));
    }
    skip.show(!ready);
  }
  watch(paint);
  listen(window, 'focus', () => api.refreshProviders());

  return layout(
    '',
    left(
      'ob-justify-center',
      h(
        'div',
        { class: 'ob-setup' },
        h('h1', { class: 'ob3-secondary-header ob-title-4xl' }, 'Choose your AI'),
        h('div', { class: 'ob-rows' }, rows.claude.el, rows.chatgpt.el, keyRow.el),
        installBox,
        keyBox,
        h('div', { class: 'ob-full' }, action, skip.el),
      ),
    ),
    right('ob-p5', realTimeDemo()),
  );
}

/** Cluely's macOS cursor, drawn over the permission pictures to point at what to click. */
function cursorSvg() {
  const el = document.createElementNS(SVG_NS, 'svg');
  el.setAttribute('viewBox', '0 0 45 48');
  el.setAttribute('width', '45');
  el.setAttribute('height', '48');
  el.setAttribute('aria-hidden', 'true');
  el.setAttribute('class', 'ob-cursor-svg');
  const add = (parent, tag, attrs) => {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    parent.append(node);
    return node;
  };
  const defs = add(el, 'defs', {});
  const filter = add(defs, 'filter', { id: 'ob-cursor-shadow', x: 0, y: 0, width: 45, height: 48, filterUnits: 'userSpaceOnUse', 'color-interpolation-filters': 'sRGB' });
  add(filter, 'feFlood', { 'flood-opacity': 0, result: 'BackgroundImageFix' });
  add(filter, 'feColorMatrix', { in: 'SourceAlpha', type: 'matrix', values: '0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0', result: 'hardAlpha' });
  add(filter, 'feOffset', { dy: 2 });
  add(filter, 'feGaussianBlur', { stdDeviation: 6 });
  add(filter, 'feComposite', { in2: 'hardAlpha', operator: 'out' });
  add(filter, 'feColorMatrix', { type: 'matrix', values: '0 0 0 0 0.387565 0 0 0 0 0.762108 0 0 0 0 0.935677 0 0 0 0.4 0' });
  add(filter, 'feBlend', { mode: 'normal', in2: 'BackgroundImageFix', result: 'effect1_dropShadow' });
  add(filter, 'feBlend', { mode: 'normal', in: 'SourceGraphic', in2: 'effect1_dropShadow', result: 'shape' });
  const grad = add(defs, 'radialGradient', { id: 'ob-cursor-fill', cx: 0, cy: 0, r: 1, gradientUnits: 'userSpaceOnUse', gradientTransform: 'matrix(-14.7669 -26.368 22.9633 -12.5987 24.5634 29.9302)' });
  add(grad, 'stop', { offset: '0.198365', 'stop-color': '#1838C6' });
  add(grad, 'stop', { offset: '0.633521', 'stop-color': '#4D95FA' });
  add(grad, 'stop', { offset: '1', 'stop-color': 'white' });
  const g = add(el, 'g', { filter: 'url(#ob-cursor-shadow)' });
  add(g, 'path', { d: 'M12.9173 31.4558L12.0036 12.9242C11.8899 10.6176 14.5002 9.18544 16.4163 10.5032L31.81 21.0904C33.7497 22.3382 33.2143 25.2814 30.9568 25.7813L23.8152 26.9042C23.1633 27.0067 22.5685 27.333 22.1352 27.8259L17.3886 33.2254C15.764 34.8554 12.9585 33.7451 12.9173 31.4558Z', fill: 'url(#ob-cursor-fill)' });
  add(g, 'path', { d: 'M12.7529 12.8877C12.6706 11.217 14.5737 10.1463 15.9912 11.1211L31.3848 21.708L31.4043 21.7217C32.772 22.6017 32.4109 24.6768 30.8096 25.0439L23.6982 26.1631C22.8745 26.2927 22.1219 26.7059 21.5723 27.3311L16.8457 32.7061C15.6763 33.8619 13.696 33.0491 13.667 31.4424V31.4307L13.666 31.4189L12.7529 12.8877Z', stroke: '#86DAE0', 'stroke-width': '1.5', class: 'ob-cursor-edge' });
  return el;
}

const STATUS = (value) => (value === 'granted' ? 'granted' : value === 'denied' || value === 'restricted' ? 'denied' : 'unknown');

/** "Let's get you set up": microphone, system audio and screen, one after another. */
function permissionsStep() {
  const DEVICES = [
    { device: 'microphone', title: 'Allow Waffle to hear audio', description: 'Waffle can listen to audio when you start a session.', icon: 'mic', ask: 'Allow microphone access', settings: 'Open microphone settings' },
    { device: 'systemAudio', title: 'Allow Waffle to hear your computer', description: 'Waffle can hear the other side of a call while you listen.', icon: 'audio-lines', ask: 'Allow system audio access', settings: 'Open system audio settings' },
    { device: 'screen', title: 'Allow Waffle to see your screen', description: "Waffle can answer questions about what you're viewing.", icon: 'monitor', ask: 'Allow screen access', settings: 'Open screen settings' },
  ];
  let screenRequested = false; // asked for Screen Recording in this visit
  let focusedBack = false; // and came back to the window since

  const statusOf = (s, device) => {
    if (!isMac) return 'granted';
    if (device === 'systemAudio') return s.systemAudioAsked ? 'granted' : 'unknown';
    return STATUS(s.permissions[device]);
  };

  function ask(device, status) {
    if (device === 'screen') {
      screenRequested = true;
      focusedBack = false;
    }
    if (status === 'denied') return api.openSystemSettings(device === 'systemAudio' ? 'screen' : device);
    if (device === 'microphone') api.askForMicrophone();
    else if (device === 'systemAudio') api.askForSystemAudio();
    else api.askForScreenAccess();
  }

  const rows = DEVICES.map((d) => {
    const row = settingRow({ iconEl: icon(d.icon), title: d.title, description: d.description, onClick: () => ask(d.device, statusOf(state, d.device)) });
    return { ...d, row };
  });

  const action = button({});
  const stage = h('div', { class: 'ob-perm-stage' });

  const cursor = h('div', { class: 'ob-cursor' }, cursorSvg());
  let shownStage = null;

  // Where the cursor points in each picture, from the centre (Cluely's numbers where it has the step).
  const CURSOR = { microphone: [80, 115], systemAudio: [200, 24], restart: [120, 60], screen: [175, 128], done: [65, 72] };

  function picture(key) {
    if (key === 'done') {
      return h(
        'div',
        { class: 'ob-all-set ob-pop-spring' },
        h('div', { class: 'ob-all-set-badge' }, svg('0 0 24 24', LUCIDE.check, 'ob-s10 ob-stroke-375')),
        h('p', {}, 'All set!'),
      );
    }
    if (key === 'restart') return restartAlert();
    if (key === 'microphone') return micAlert();
    if (key === 'systemAudio') return h('div', { class: 'ob-perm-pair' }, settingsList());
    return h('div', { class: 'ob-perm-pair' }, screenAlert(), h('hr', { class: 'ob-perm-hr' }), settingsList('ob-delay'));
  }

  function paint(s) {
    const statuses = rows.map((r) => statusOf(s, r.device));
    const missing = statuses.findIndex((st) => st !== 'granted');
    const restart = isMac && statuses[2] === 'denied' && screenRequested && focusedBack;
    rows.forEach((r, i) => {
      const granted = statuses[i] === 'granted';
      r.row.set({ live: !granted && !(missing !== -1 && i > missing), checked: granted, done: granted, dim: missing !== -1 && i > missing });
    });

    const current = missing === -1 ? null : rows[missing];
    action.replaceChildren();
    if (restart) {
      append(action, 'Quit and reopen');
      action.onclick = () => api.relaunch();
    } else if (!current) {
      append(action, ['Continue', icon('chevron-right', 'ob-s4')]);
      action.onclick = next;
    } else {
      append(action, statuses[missing] === 'denied' ? current.settings : current.ask);
      action.onclick = () => ask(current.device, statuses[missing]);
    }

    const key = restart ? 'restart' : current ? current.device : 'done';
    if (key !== shownStage) {
      const old = stage.firstChild;
      shownStage = key;
      const show = () => stage.replaceChildren(picture(key));
      if (old) {
        old.classList.add('ob-pop-out');
        later(show, 300);
      } else show();
    }
    const [x, y] = CURSOR[key];
    cursor.style.setProperty('--x', `${x}px`);
    cursor.style.setProperty('--y', `${y}px`);
    cursor.classList.add('is-shown');
  }

  watch(paint);
  api.checkPermissions();
  listen(window, 'focus', () => {
    if (screenRequested) focusedBack = true;
    api.checkPermissions();
    paint(state);
  });

  return layout(
    '',
    left(
      'ob-justify-center',
      h(
        'div',
        { class: 'ob-setup' },
        h('h1', { class: 'ob3-secondary-header ob-title-4xl' }, "Let's get you set up"),
        h('div', { class: 'ob-rows' }, rows.map((r) => r.row.el)),
        action,
      ),
    ),
    right('', h('div', { class: 'ob-perm-right' }, stage, cursor)),
  );
}

const MOD_CAPS = isMac
  ? { CommandOrControl: '⌘', Command: '⌘', Cmd: '⌘', Control: '⌃', Ctrl: '⌃', Alt: '⌥', Option: '⌥', Shift: '⇧' }
  : { CommandOrControl: 'Ctrl', Command: 'Win', Cmd: 'Win', Control: 'Ctrl', Ctrl: 'Ctrl', Alt: 'Alt', Option: 'Alt', Shift: 'Shift' };
const KEY_CAPS = { Up: '↑', Down: '↓', Left: '←', Right: '→', Backspace: '⌫', Space: 'Space', Tab: 'Tab' };

/** An Electron accelerator ("CommandOrControl+Enter") as keycaps and the modifiers and key to match. */
function parseAccelerator(accelerator) {
  const parts = accelerator.split('+');
  const key = parts.pop();
  const mods = { meta: false, ctrl: false, alt: false, shift: false };
  for (const mod of parts) {
    if (mod === 'CommandOrControl') isMac ? (mods.meta = true) : (mods.ctrl = true);
    else if (mod === 'Command' || mod === 'Cmd') mods.meta = true;
    else if (mod === 'Control' || mod === 'Ctrl') mods.ctrl = true;
    else if (mod === 'Alt' || mod === 'Option') mods.alt = true;
    else if (mod === 'Shift') mods.shift = true;
  }
  const keyCap = key === 'Enter' || key === 'Return' ? icon('corner-down-left', 'ob-press-key-ico') : KEY_CAPS[key] || key;
  return { mods, key, caps: [...parts.map((mod) => MOD_CAPS[mod] || mod), keyCap] };
}

function matchesAccelerator(event, { mods, key }) {
  if (event.metaKey !== mods.meta || event.ctrlKey !== mods.ctrl || event.altKey !== mods.alt || event.shiftKey !== mods.shift) return false;
  const pressed = /^Key[A-Z]$/.test(event.code) ? event.code.slice(3) : /^Digit\d$/.test(event.code) ? event.code.slice(5) : event.key.replace(/^Arrow/, '');
  return pressed.toLowerCase() === (key === 'Return' ? 'enter' : key.toLowerCase());
}

/** "Press ⌘↵ to get an instant answer": the ask shortcut answers about the screenshot, again moves on. */
function askStep() {
  let phase = 'idle';
  const ANSWER = [
    'To smooth the cut from the rainforest clip into the sky shot, drop a **Cross Dissolve** between `IMG_1170.MOV` and `IMG_1262.MOV` on `V1`.',
    '',
    '- Open Effect Controls and set Duration to `30` frames',
    '- Set Alignment to **Center at Cut** so the blend straddles the edit',
    '- Hold `Alt` and drag the audio keyframes on `A1` down `~6 dB` across the same range',
    '',
    'Use `Q` / `W` to ripple-trim either side so the rest of the timeline stays locked, and the transition lands cleanly on the beat at `00:02:16:18`.',
  ].join('\n');

  const trigger = () => {
    if (phase === 'idle') {
      phase = 'done';
      paint();
    } else next();
  };
  // The overlay's ask shortcut (⌘↵ unless changed in Settings), not a bare Enter.
  const ask = parseAccelerator(state.shortcuts?.ask || 'CommandOrControl+Enter');
  listen(window, 'keydown', (event) => {
    if (matchesAccelerator(event, ask)) {
      event.preventDefault();
      trigger();
    } else if (event.key === 'Backspace') {
      event.preventDefault();
      phase = 'idle';
      paint();
    }
  });

  const actionSlot = h('div', { class: 'ob-action' });
  const answer = h('div', { class: 'ob-mode-answer' });
  answer.innerHTML = window.renderMarkdown(ANSWER); // markdown.js escapes the text before adding markup
  const body = h('div', { class: 'ob-mode-body' }, h('div', { class: 'ob-mode-viewed' }, icon('eye', 'ob-s4'), h('span', {}, 'Viewed screen')), answer);
  const sendBtn = h(
    'button',
    { type: 'button', class: 'ob-mode-send', 'aria-label': 'Send message', onClick: trigger },
    h('div', { class: 'ob-mode-ripple', 'aria-hidden': 'true' }, [0, 1, 2].map((i) => h('div', { class: `ob-mode-ring ob-ring-${i}` }))),
    h('span', { class: 'ob-mode-key ob-mode-key-strong' }, icon('corner-down-left', 'ob-s4 ob-stroke-23')),
  );
  const modeTool = (child, active) => h('div', { class: `ob-mode-tool ${active ? 'is-active' : ''}` }, child);
  const inner = h(
    'div',
    { class: 'ob-mode-box' },
    h('div', { class: 'ob-mode-input' }, caret('ob-caret-lg'), h('span', {}, 'Ask anything...')),
    body,
    h(
      'div',
      { class: 'ob-mode-toolbar' },
      h('div', { class: 'ob-mode-toolbar-start' }, modeTool(waffleMark('ob-s5'))),
      h('div', { class: 'ob-mode-tools' }, modeTool(icon('image', 'ob-s5'), true), modeTool(icon('eye', 'ob-s5')), modeTool(icon('layout-grid', 'ob-s5')), h('div', { class: 'ob-divider' }), modeTool(icon('audio-lines', 'ob-s21'))),
      h('div', { class: 'ob-mode-toolbar-end' }, h('span', {}, 'History'), h('span', { class: 'ob-mode-key ob-mode-key-hist' }, icon('arrow-down', 'ob-s3'))),
    ),
  );

  function paint() {
    const done = phase === 'done';
    inner.classList.toggle('is-done', done);
    body.hidden = !done;
    sendBtn.hidden = done;
    actionSlot.replaceChildren(done ? continueButton(next, 'Next') : waitButton('Use the shortcut to continue'));
  }
  paint();

  return layout(
    '',
    left(
      'ob-justify-between',
      h('div'),
      h(
        'div',
        { class: 'ob-col' },
        h(
          'h1',
          { class: 'ob-h1 ob-press' },
          h('span', {}, 'Press'),
          h('span', { class: 'ob-press-keys' }, ask.caps.map((cap) => h('span', { class: 'ob-press-key' }, typeof cap === 'string' ? h('span', { class: 'ob-press-glyph' }, cap) : cap))),
          h('span', {}, 'to get'),
          h('span', { class: 'ob-basis-full' }),
          h('span', {}, 'an instant answer'),
        ),
        h('h2', { class: 'ob-sub' }, 'Waffle uses your screen context to respond, no prompt needed.'),
        actionSlot,
      ),
      h('div'),
    ),
    right(
      'ob-px6',
      h(
        'div',
        { class: 'ob-mode-wrap' },
        h(
          'div',
          { class: 'ob-mode-stage' },
          h(
            'div',
            { class: 'ob-shot' },
            h('div', { class: 'ob-shot-bar' }, h('span', { class: 'ob-dot ob-dot-red' }), h('span', { class: 'ob-dot ob-dot-yellow' }), h('span', { class: 'ob-dot ob-dot-green' })),
            h('div', { class: 'ob-shot-img' }, editorScreen()),
          ),
          h('div', { class: 'ob-mode-over ob-rise' }, h('div', { class: 'ob-rel' }, card(inner), sendBtn)),
        ),
      ),
    ),
  );
}

/** A keycap from the hide and move demos; lights up blue while held. */
function keycap(kind, child) {
  return h('kbd', { class: `ob-kbd ob-kbd-${kind}` }, h('div', { class: 'ob-kbd-face' }, child));
}

const modifierKey = () =>
  keycap('mod', isMac ? [h('span', { class: 'ob-kbd-cmd' }, '⌘'), h('span', { class: 'ob-kbd-word' }, 'command')] : h('span', { class: 'ob-kbd-ctrl' }, 'Ctrl'));

/** "Hide Waffle using the following hotkeys": ⌘\ twice (hide, then show). */
function hideStep() {
  let count = 0;
  let hidden = false;
  const mod = modifierKey();
  const slash = keycap('square', backslashIcon('ob-s6'));
  const keys = h('div', { class: 'ob-keys-row' }, mod, h('span', { class: 'ob-plus' }, '+'), slash);
  const [heading, headingText] = demoHeading(lines('Hide Waffle using', 'the following hotkeys'), 'ob-min-h');
  const actionSlot = h('div', {});
  const skip = button({ variant: 'ghost', size: 'fit', cls: 'ob-skip', onClick: next }, 'Skip', icon('chevron-right', 'ob-s4'));
  const skipWrap = h('div', { class: 'ob-skip-wrap' }, skip);
  const box = h('div', { class: 'ob-hide-box' }, askBox(inputRow(), smallToolbar()));

  trackKeys((held) => {
    const modDown = held.has('Meta') || held.has('Control');
    mod.classList.toggle('is-active', modDown);
    slash.classList.toggle('is-active', held.has('\\'));
    keys.classList.toggle('is-pressed', modDown || held.has('\\'));
  });
  listen(window, 'keydown', (event) => {
    if (!isMod(event) || event.code !== 'Backslash' || event.repeat) return;
    event.preventDefault();
    hidden = !hidden;
    count += 1;
    if (count === 1) swapText(headingText, lines('Now, open Waffle', 'back using the hotkeys'));
    paint();
  });

  function paint() {
    box.classList.toggle('is-hidden', hidden);
    actionSlot.replaceChildren(count >= 2 ? continueButton(next) : waitButton('Use the shortcut to continue'));
    const showSkip = count < 2;
    skipWrap.classList.toggle('is-shown', showSkip);
    skip.disabled = !showSkip;
  }
  paint();
  later(() => skipWrap.classList.add('is-ready'), 0);

  return layout(
    'ob-rel',
    backButton('ask'),
    left(
      'ob-justify-between',
      h('div'),
      demoColumn(heading, h('p', { class: 'ob-sub' }, 'You can open and hide Waffle anytime.'), keys, h('div', { class: 'ob-action' }, actionSlot, skipWrap)),
      h('div'),
    ),
    right('ob-demo-right ob-px6', h('div', { class: 'ob-center-wrap' }, box)),
  );
}

/** "Now, try to move Waffle around": ⌘ + arrows nudge the box 18px, up to 72px each way. */
function moveStep() {
  const STEP = 18;
  const LIMIT = 72;
  let pos = { x: 0, y: 0 };
  let moved = false;
  const mod = modifierKey();
  const arrow = (name) => keycap('arrow', icon(name, 'ob-s4'));
  const arrows = { ArrowUp: arrow('arrow-up'), ArrowLeft: arrow('arrow-left'), ArrowDown: arrow('arrow-down'), ArrowRight: arrow('arrow-right') };
  const actionSlot = h('div', { class: 'ob-action' });
  const mover = h('div', { class: 'ob-mover' }, askBox(inputRow(), smallToolbar()));
  const guide = (cls, iconName, lineCls) => h('div', { class: `ob-guide ${cls}` }, icon(iconName, 'ob-s35'), h('span', { class: lineCls }));

  trackKeys((held) => {
    mod.classList.toggle('is-active', held.has('Meta') || held.has('Control'));
    for (const [key, el] of Object.entries(arrows)) el.classList.toggle('is-active', held.has(key));
  });
  const DELTA = { ArrowUp: [0, -STEP], ArrowDown: [0, STEP], ArrowLeft: [-STEP, 0], ArrowRight: [STEP, 0] };
  listen(window, 'keydown', (event) => {
    if (!isMod(event) || !DELTA[event.key]) return;
    event.preventDefault();
    const [dx, dy] = DELTA[event.key];
    pos = { x: Math.min(Math.max(pos.x + dx, -LIMIT), LIMIT), y: Math.min(Math.max(pos.y + dy, -LIMIT), LIMIT) };
    moved = true;
    paint();
  });

  function paint() {
    mover.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
    actionSlot.replaceChildren(moved ? continueButton(next) : waitButton('Use the shortcut to continue'));
  }
  paint();

  return layout(
    'ob-rel',
    backButton('hide'),
    left(
      'ob-justify-between',
      h('div'),
      demoColumn(
        h('h1', { class: 'ob-h1' }, lines('Now, try to move', 'Waffle around')),
        h('p', { class: 'ob-sub' }, 'You can move it in any direction.'),
        h(
          'div',
          { class: 'ob-keys-row' },
          mod,
          h('span', { class: 'ob-plus' }, '+'),
          h('div', { class: 'ob-arrows' }, arrows.ArrowUp, h('div', { class: 'ob-arrows-row' }, arrows.ArrowLeft, arrows.ArrowDown, arrows.ArrowRight)),
        ),
        actionSlot,
      ),
      h('div'),
    ),
    right(
      'ob-demo-right ob-px6',
      h(
        'div',
        { class: 'ob-center-wrap' },
        h(
          'div',
          { class: 'ob-move-area' },
          guide('ob-guide-up', 'arrow-up', 'ob-guide-v ob-guide-v-up'),
          guide('ob-guide-down', 'arrow-down', 'ob-guide-v ob-guide-v-down'),
          guide('ob-guide-left', 'arrow-left', 'ob-guide-h ob-guide-h-left'),
          guide('ob-guide-right', 'arrow-right', 'ob-guide-h ob-guide-h-right'),
          mover,
        ),
      ),
    ),
  );
}

/** "Waffle can also listen to you": click the audio icon to start a session. */
function listenStep() {
  let listening = false;
  const [heading, headingText] = demoHeading(lines('Waffle can also', 'listen to you'));
  const sub = h('p', { class: 'ob-sub ob-sub-28' }, 'Click the audio icon to start a session. Waffle listens to your microphone and the person on the other side.');
  const actionSlot = h('div', { class: 'ob-action' });
  const tools = h('div', { class: 'ob-tools' });
  const start = () => {
    if (listening) return;
    listening = true;
    swapText(headingText, lines('Waffle is now', 'listening in'));
    sub.textContent = 'Waffle is hearing both your microphone and the person on the other side, and will use that audio context to help assist you.';
    paint();
  };
  const audioBtn = h('button', { type: 'button', class: 'ob-tool ob-tool-btn ob-tool-hint', 'aria-label': 'Start listening session', onClick: start }, pulse('ob-pulse-sm ob-pulse-blue'), icon('audio-lines', 'ob-s19 ob-rel'));
  const tip = callout('Click to start listening');
  const skip = skipLink(next);

  function paint() {
    tools.replaceChildren(tool(icon('image', 'ob-s18')), tool(icon('eye', 'ob-s18')), tool(icon('layout-grid', 'ob-s18')), divider(), listening ? sessionControls() : audioBtn);
    actionSlot.replaceChildren(listening ? continueButton(next) : waitButton('Click the audio icon to continue'), skip.el);
    skip.show(!listening);
    tip.point(listening ? null : audioBtn);
  }
  paint();

  return layout(
    'ob-rel',
    backButton('move'),
    left('ob-justify-between', h('div'), demoColumn(heading, sub, actionSlot), h('div')),
    right('ob-demo-right ob-px5', meetingStage(askBox(inputRow(), smallToolbar({ middle: tools })), tip.el)),
  );
}

/** "Now end the session to generate notes": stop, and the summary unfolds. */
function notesStep() {
  let ended = false;
  const SUMMARY = [
    '## Key takeaways',
    '',
    '- Locked the **Q3 launch** for September 12; design review owns the visual pass.',
    '- **Roy** to send a recap with owners and dates by EOW.',
    '- Open question: who reviews the final copy before publish?',
    '',
    '## Decisions',
    '',
    'The team is aligned on prioritizing the redesigned dashboard over the new export flow this cycle.',
  ].join('\n');

  const [heading, headingText] = demoHeading(lines('Now end the session', 'to generate notes'));
  const sub = h('p', { class: 'ob-sub ob-sub-26' }, 'Click stop to end the session. Waffle will summarize what was said on both sides.');
  const actionSlot = h('div', { class: 'ob-action' });

  const summary = h('div', { class: 'notes-demo-summary' });
  summary.innerHTML = window.renderMarkdown(SUMMARY); // escaped by markdown.js
  const chipRow = (iconEl, text) => h('span', { class: 'ob-note-chip' }, h('span', { class: 'ob-note-chip-ico' }, iconEl), h('span', {}, text));
  const notes = h(
    'div',
    { class: 'ob-notes' },
    h(
      'article',
      {},
      h(
        'div',
        { class: 'ob-notes-article' },
        h(
        'header',
        { class: 'ob-notes-head' },
        h('h2', {}, 'Q3 Launch Sync'),
        h('div', { class: 'ob-note-chips' }, chipRow(icon('calendar-days', 'ob-s35'), 'Today, 12:30 PM'), chipRow(usersIcon('ob-s35'), 'Roy + Neel')),
      ),
        h('section', {}, h('h3', { class: 'ob-notes-label' }, 'Summary'), summary),
      ),
    ),
  );
  const input = h('div', { class: 'ob-input ob-input-notes' }, caret(), h('span', { class: 'ob-input-text' }, 'Ask anything'), h('div', { class: 'ob-input-send' }, chip(icon('corner-down-left', 'ob-s3 ob-stroke-23'))));
  const toolbarMiddle = h('div', { class: 'ob-tools' });
  const toolbarEnd = h('div', {});
  const end = () => {
    if (ended) return;
    ended = true;
    swapText(headingText, lines('Waffle just wrote', 'your notes for you'));
    sub.textContent = 'Action items, follow-ups, and open questions are saved to your history.';
    paint();
  };
  const toolbar = smallToolbar({ middle: toolbarMiddle, end: toolbarEnd });
  const tip = callout('Click to end the session');
  const skip = skipLink(next);
  let stopBtn = null;

  function paint() {
    input.classList.toggle('is-ended', ended);
    for (const child of [...input.children]) child.hidden = ended;
    notes.classList.toggle('is-open', ended);
    toolbarMiddle.replaceChildren(
      ...(ended
        ? []
        : [tool(icon('image', 'ob-s18')), tool(icon('eye', 'ob-s18')), tool(icon('layout-grid', 'ob-s18')), divider(), sessionControls({ onStop: end, startAt: 4, stopPulse: true, onStopButton: (b) => (stopBtn = b) })]),
    );
    toolbarEnd.replaceChildren(ended ? h('button', { type: 'button', class: 'ob-show-transcript' }, icon('file-text', 'ob-s35 ob-stroke-225'), 'Show Transcript') : historyLabel());
    actionSlot.replaceChildren(ended ? continueButton(next) : waitButton('Click stop to continue'), skip.el);
    skip.show(!ended);
    tip.point(ended ? null : stopBtn);
  }
  paint();

  return layout(
    'ob-rel',
    backButton('listen'),
    left('ob-justify-between', h('div'), demoColumn(heading, sub, actionSlot), h('div')),
    right('ob-demo-right ob-px5', meetingStage(card(h('div', { class: 'ob-box' }, input, notes, toolbar)), tip.el)),
  );
}

/** "Now, make Waffle undetectable": the eye toggle; Continue finishes setup. */
function undetectableStep() {
  let on = false;
  const [heading, headingText] = demoHeading(lines('Now, make Waffle', 'undetectable'));
  const sub = h('p', { class: 'ob-sub ob-sub-26' }, 'Click the eye icon in the toolbar to toggle undetectability.');
  const actionSlot = h('div', { class: 'ob-action ob-action-11' });
  const hint = pulse('ob-pulse-sm ob-pulse-blue');
  const eyeBtn = h('button', { type: 'button', class: 'ob-tool ob-tool-btn ob-tool-hint', 'aria-label': 'Toggle undetectability', onClick: () => toggle() }, hint, icon('eye', 'ob-s18 ob-rel'));
  const ring = h('div', { class: 'ob-undetect-ring', 'aria-hidden': 'true' });
  const tip = callout('Click the eye');
  const skip = skipLink(() => api.finishOnboarding());
  const wrap = h(
    'div',
    { class: 'ob-undetect' },
    ring,
    askBox(inputRow(), smallToolbar({ middle: h('div', { class: 'ob-tools' }, tool(icon('image', 'ob-s18')), eyeBtn, tool(icon('layout-grid', 'ob-s18')), divider(), tool(icon('audio-lines', 'ob-s19'))) })),
  );

  function toggle() {
    on = !on;
    swapText(headingText, on ? lines('Waffle is completely', 'undetectable') : lines('Now, make Waffle', 'undetectable'));
    sub.textContent = on ? 'No one on the call can see Waffle or detect it in screen recordings.' : 'Click the eye icon in the toolbar to toggle undetectability.';
    paint();
  }
  function paint() {
    wrap.classList.toggle('is-on', on);
    eyeBtn.classList.toggle('is-on', on);
    hint.hidden = on;
    eyeBtn.classList.toggle('ob-tool-hint', !on);
    actionSlot.replaceChildren(on ? continueButton(() => api.finishOnboarding()) : waitButton('Click the eye icon to continue'), skip.el);
    skip.show(!on);
    tip.point(on ? null : eyeBtn);
  }
  paint();

  return layout(
    'ob-rel',
    backButton('notes'),
    left('ob-justify-between', h('div'), demoColumn(heading, sub, actionSlot), h('div')),
    right('ob-demo-right ob-px5', meetingStage(wrap, tip.el)),
  );
}

const STEP_VIEWS = {
  welcome: welcomeStep,
  ai: aiStep,
  permissions: permissionsStep,
  ask: askStep,
  hide: hideStep,
  move: moveStep,
  listen: listenStep,
  notes: notesStep,
  undetectable: undetectableStep,
};

// ---------- boot ----------

(async function boot() {
  state = await api.getState();
  api.onState((nextState) => {
    state = nextState;
    for (const fn of listeners) fn(state);
  });
  window.addEventListener('focus', () => api.checkPermissions()); // as Cluely's onboarding root does
  go(state.onboardingStep);
})();
