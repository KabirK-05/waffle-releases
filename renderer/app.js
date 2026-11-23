// One renderer bundle for every window. The hash route picks the view:
//   #chat      the always-on-top ask box, with answers growing beneath it
//   #settings  the regular settings window (optionally #settings/<section>)

const api = window.waffle;
const isMac = api.platform === 'darwin';
const root = document.getElementById('root');

// ---------- small helpers ----------

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value !== false && value != null) el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return el;
}

const SYMBOLS = isMac
  ? { CommandOrControl: '⌘', Command: '⌘', Control: '⌃', Alt: '⌥', Shift: '⇧' }
  : { CommandOrControl: 'Ctrl', Command: 'Win', Control: 'Ctrl', Alt: 'Alt', Shift: 'Shift' };
const KEY_SYMBOLS = { Enter: '↵', Up: '↑', Down: '↓', Left: '←', Right: '→', Space: 'Space', Backspace: '⌫' };

function formatAccelerator(accelerator) {
  if (!accelerator) return '—';
  const parts = accelerator.split('+').map((part) => SYMBOLS[part] || KEY_SYMBOLS[part] || part);
  return isMac ? parts.join('') : parts.join('+');
}

/** Turn a keydown into an Electron accelerator, or null if it is not a usable combination. */
function acceleratorFromEvent(event) {
  const mods = [];
  if (isMac ? event.metaKey : event.ctrlKey) mods.push('CommandOrControl');
  if (isMac && event.ctrlKey) mods.push('Control');
  if (event.altKey) mods.push('Alt');
  if (event.shiftKey) mods.push('Shift');

  const { code } = event;
  let key = null;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit\d$/.test(code)) key = code.slice(5);
  else if (/^F\d{1,2}$/.test(code)) key = code;
  else {
    key = {
      ArrowUp: 'Up',
      ArrowDown: 'Down',
      ArrowLeft: 'Left',
      ArrowRight: 'Right',
      Enter: 'Enter',
      Space: 'Space',
      Backslash: '\\',
      Slash: '/',
      Comma: ',',
      Period: '.',
      Semicolon: ';',
      Quote: "'",
      BracketLeft: '[',
      BracketRight: ']',
      Minus: '-',
      Equal: '=',
      Backquote: '`',
      Tab: 'Tab',
    }[code];
  }
  if (!key) return null;
  if (!mods.length && !/^F\d/.test(key)) return null; // a bare key would swallow normal typing
  return [...mods, key].join('+');
}

// Icons are Lucide (stroke) and Heroicons (filled, "hero-*"), loaded from icons.js. Only the
// thinking spark is Waffle's own, drawn on a 16px grid. Built as DOM nodes, so the CSP needs no
// inline markup.
const LEGACY_ICONS = {
  spark: ['M8 1.5v4', 'M8 10.5v4', 'M1.5 8h4', 'M10.5 8h4', 'M3.4 3.4l2.8 2.8', 'M9.8 9.8l2.8 2.8', 'M12.6 3.4l-2.8 2.8', 'M6.2 9.8l-2.8 2.8'],
};

function icon(name) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  const data = window.WAFFLE_ICONS[name];
  if (data) {
    svg.setAttribute('viewBox', data.v);
    const kind = data.fill ? 'ico solid' : data.hero ? 'ico hero' : 'ico';
    svg.setAttribute('class', name.startsWith('logo-') ? `${kind} logo ${name}` : kind); // logos carry their brand colour
    for (const [tag, attrs] of data.els) {
      const el = document.createElementNS(NS, tag);
      for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
      svg.append(el);
    }
    return svg;
  }
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', 'ico legacy');
  if (!LEGACY_ICONS[name]) {
    console.warn(`Unknown icon: ${name}`); // draw nothing rather than break the page
    return svg;
  }
  for (const d of LEGACY_ICONS[name]) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

// ---------- shared state ----------

let state = null;
const subscribers = new Set();

async function initState() {
  state = await api.getState();
  document.body.classList.toggle('glass', Boolean(state.settingsGlass));
  document.body.classList.toggle('overlay-glass', Boolean(state.overlayGlass));
  api.onState((next) => {
    state = next;
    document.body.classList.toggle('glass', Boolean(next.settingsGlass));
    document.body.classList.toggle('overlay-glass', Boolean(next.overlayGlass));
    for (const fn of subscribers) fn(state);
  });
}

const subscribe = (fn) => {
  subscribers.add(fn);
  fn(state);
};

// ---------- chat ----------

function renderChat() {
  // idle -> capturing -> waiting -> streaming -> done | error
  let phase = 'idle';
  let turn = null; // { answer, meta, actions, raw, usedScreen } for the newest question
  let paintQueued = false;
  let expanded = true; // whether the conversation shows beneath the input (when there is one)

  // Every question and answer in this chat stays here, so earlier turns are a scroll away.
  const thread = h('div', { class: 'thread' });
  // Shown, with a fade at the bottom, whenever there is more of the answer below.
  const jumpBtn = h('button', { class: 'jump-down', hidden: true, 'aria-label': 'Scroll to the end', onClick: jumpToEnd }, icon('arrow-down'));
  const body = h('div', { class: 'chat-body' }, thread, jumpBtn);
  // While an answer streams in, the newest question is held at the top so you can read (and speak)
  // from the start; the view never chases the end. Any scrolling of your own releases it.
  let anchor = null;

  const backBtn = h('button', { class: 'back', 'data-tip': 'Back', onClick: onBack }, icon('arrow-left'));
  const input = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false' });
  const sendBtn = h('button', { class: 'send', onClick: onSend }, icon('corner-down-left'));
  const searchMark = h('span', { class: 'search-mark', 'aria-hidden': 'true' }, icon('search'));
  // Cluely's "Tab to focus": while a conversation is open and the bar isn't focused, the placeholder
  // becomes an outlined Tab key and "to focus". Tab (a global shortcut in main) or a click focuses it.
  const tabHint = h(
    'span',
    {
      class: 'tab-hint',
      hidden: true,
      onMousedown: (event) => {
        event.preventDefault();
        if (!document.hasFocus()) api.focusChatInput();
        input.focus();
      },
    },
    h('span', { class: 'keycap outline' }, 'Tab'),
    h('span', { class: 'tab-hint-text' }, 'to focus'),
  );
  let sentExpanded = null;
  function syncTabHint() {
    const tabWorks = state.tabToFocus || (state.isInvisible && state.noFocusWhenInvisible);
    const show = panel.classList.contains('expanded') && tabWorks && !input.value && document.activeElement !== input;
    tabHint.hidden = !show;
    input.classList.toggle('hint-on', show);
  }

  // History: saved conversations, newest first, grouped by day and searchable from the input.
  let view = 'chat'; // 'chat' | 'history' | 'transcript' | 'summary'
  let historyEntries = [];
  let historyRows = [];
  let selectedRow = 0;
  let historyRequest = 0;
  const historyList = h('div', { class: 'history-list', role: 'listbox', 'aria-label': 'Chat history' });
  const historyPane = h('div', { class: 'history-pane' }, historyList);

  // Leftmost: settings, with a small Settings / Hide menu that appears above it on hover.
  // Waffle's own mark, one colour like the other toolbar icons (as Cluely shows its logo there, 18px).
  const menuBtn = h('button', { class: 'tool app-mark-btn', 'aria-label': 'Settings', onClick: () => api.openSettings() }, icon('app-mark'));
  const quickMenu = h(
    'div',
    { class: 'quick-menu', hidden: true },
    h('button', { class: 'quick-item', onClick: () => (hideQuickMenu(true), api.openSettings()) }, icon('sliders-horizontal'), 'Settings'),
    h('button', { class: 'quick-item', onClick: () => (hideQuickMenu(true), api.hideOverlay()) }, icon('x'), 'Hide'),
  );
  const screenBtn = h('button', { class: 'tool', onClick: toggleScreen }, icon('image'));
  // Turning undetectability off takes two clicks, like deleting a mode, so a stray click can't expose
  // the overlay mid-call. The first click arms it and the label turns red; leaving the button disarms.
  let invisibleArmed = false;
  const disarmInvisible = () => {
    if (!invisibleArmed) return;
    invisibleArmed = false;
    invisibleBtn.classList.remove('armed');
    invisibleBtn.setAttribute('data-tip', state.isInvisible ? 'Undetectable' : 'Detectable');
  };
  const invisibleBtn = h(
    'button',
    {
      class: 'tool',
      onClick: () => {
        if (!state.isInvisible) return api.patchState({ isInvisible: true });
        if (!invisibleArmed) {
          invisibleArmed = true;
          invisibleBtn.classList.add('armed');
          invisibleBtn.setAttribute('data-tip', 'Click again to turn off undetectability');
          return;
        }
        disarmInvisible();
        api.patchState({ isInvisible: false });
      },
      onMouseleave: disarmInvisible,
    },
    icon('eye'),
  );
  // Shows the current mode; modes are chosen in Settings → Modes.
  // Opens the quick mode menu (its own small window, see main.js) right under this button.
  const modeBtn = h('button', { class: 'tool mode-tool', 'aria-haspopup': 'menu', onClick: openModeMenu }, icon('modes-grid'));
  // A DOMRect's fields are getters, which don't survive the trip to the main process; send numbers.
  function openModeMenu() {
    const { left, top, width, height } = modeBtn.getBoundingClientRect();
    api.toggleModeMenu({ x: left, y: top, width, height });
  }
  const listenBtn = h('button', { class: 'tool', onClick: () => api.toggleListen() }, icon('audio-lines'));

  // Listening session: the live transcript, and pause / stop / timer in the toolbar.
  let openingMeeting = null; // id of a saved session being opened from History
  let transcript = null; // { entries: [{ speaker, start, end, text }], partial: { me, them } } or null
  let followTranscript = true; // keep the newest line in view unless you scroll up
  const transcriptList = h('div', { class: 'transcript-list', role: 'log', 'aria-label': 'Meeting transcript' });
  const copyTranscriptBtn = h('button', { class: 'text-btn dim copy-transcript', onClick: copyTranscript }, icon('copy'), 'Copy Transcript');
  // A finished session's transcript opens like its summary page: title and chips on top.
  const transcriptMetaTitle = h('h1', { class: 'summary-title' });
  const transcriptDateChip = h('span', { class: 'chip' }, icon('calendar'), h('span'));
  const transcriptPeopleChip = h('span', { class: 'chip' }, icon('users'), h('span'));
  const transcriptMeta = h('div', { class: 'meeting-meta' }, transcriptMetaTitle, h('div', { class: 'chips' }, transcriptDateChip, transcriptPeopleChip));
  const transcriptPane = h(
    'div',
    { class: 'transcript-pane' },
    transcriptMeta,
    h('div', { class: 'transcript-head' }, h('span', { class: 'transcript-title' }, 'Transcript'), copyTranscriptBtn),
    transcriptList,
  );
  const pauseBtn = h('button', { class: 'tool session-pause', onClick: () => api.togglePause() }, icon('pause'));
  const stopBtn = h('button', { class: 'session-stop', 'data-tip': 'Stop listening', onClick: () => api.toggleListen() }, h('span', { class: 'stop-square' }));
  const timer = h('span', { class: 'session-timer' }, '0:00');
  const sessionControls = h('div', { class: 'session-controls', hidden: true }, pauseBtn, stopBtn, timer);
  const viewChatBtn = h('button', { class: 'text-btn view-toggle', onClick: () => showView('chat') }, icon('message-circle'), 'View Chat');
  const viewTranscriptBtn = h('button', { class: 'text-btn view-toggle', onClick: () => showView('transcript') }, icon('file'), 'View Transcript');

  // A finished session: its summary, and a bar to go back, switch views or resume recording.
  const summaryTitle = h('h1', { class: 'summary-title' });
  const dateChip = h('span', { class: 'chip' }, icon('calendar'), h('span'));
  const peopleChip = h('span', { class: 'chip' }, icon('users'), h('span'));
  const copySummaryBtn = h('button', { class: 'text-btn dim copy-transcript', onClick: copySummary }, icon('copy'), 'Copy Summary');
  const summaryBody = h('div', { class: 'summary-body answer' });
  const summaryPane = h(
    'div',
    { class: 'summary-pane' },
    h(
      'div',
      { class: 'summary-scroll' },
      summaryTitle,
      h('div', { class: 'chips' }, dateChip, peopleChip),
      h('div', { class: 'transcript-head summary-head' }, h('span', { class: 'transcript-title' }, 'Summary'), copySummaryBtn),
      summaryBody,
    ),
  );
  const barBackBtn = h('button', { class: 'text-btn', onClick: closeMeetingView }, icon('arrow-left'), 'Back');
  const showTranscriptBtn = h('button', { class: 'text-btn', onClick: () => showView('transcript') }, icon('file'), 'Show Transcript');
  const showSummaryBtn = h('button', { class: 'text-btn', onClick: () => showView('summary') }, icon('hero-o-document'), 'Show Summary');
  const resumeBtn = h('button', { class: 'text-btn resume', onClick: () => api.resumeMeeting() }, icon('play'), 'Resume session');
  const meetingBar = h(
    'div',
    { class: 'meeting-bar', hidden: true },
    barBackBtn,
    h('div', { class: 'meeting-bar-end' }, showTranscriptBtn, showSummaryBtn, resumeBtn),
  );
  const historyArrow = h('span', { class: 'keycap' }, icon('arrow-down'));
  const historyBtn = h('button', { class: 'text-btn history', onClick: openHistory }, 'History', historyArrow);
  const newKeys = h('span', { class: 'keycaps' });
  const newChatBtn = h('button', { class: 'text-btn new-chat', onClick: () => api.newChat() }, 'New Chat', newKeys);
  const openBtn = h('button', { class: 'text-btn', onClick: () => openRow(selectedRow) }, 'Open', h('span', { class: 'keycap' }, icon('corner-down-left')));
  const historyNewKeys = h('span', { class: 'keycaps' });
  const historyNewBtn = h('button', { class: 'text-btn dim', onClick: () => api.newChat() }, icon('message-square-plus'), 'New chat', historyNewKeys);
  const historyActions = h('div', { class: 'history-actions' }, openBtn, h('span', { class: 'divider' }), historyNewBtn);

  const panel = h(
    'section',
    { class: 'chat' },
    h(
      'div',
      { class: 'box' },
      h('div', { class: 'ask-row' }, backBtn, input, tabHint, sendBtn, searchMark),
      body,
      historyPane,
      transcriptPane,
      summaryPane,
      h(
        'div',
        { class: 'toolbar' },
        h('div', { class: 'toolbar-side' }, menuBtn),
        h('div', { class: 'tool-group' }, screenBtn, invisibleBtn, modeBtn, h('span', { class: 'divider' }), listenBtn, sessionControls),
        h('div', { class: 'toolbar-side end' }, historyBtn, newChatBtn, historyActions, viewChatBtn, viewTranscriptBtn),
      ),
      meetingBar,
    ),
    quickMenu, // outside the box so its rounded clip doesn't cut the menu off
  );
  root.append(panel);

  const busy = () => phase === 'capturing' || phase === 'waiting' || phase === 'streaming';

  let quickTimer = null;
  function showQuickMenu() {
    clearTimeout(quickTimer);
    if (!quickMenu.hidden) return;
    quickMenu.hidden = false;
    const p = panel.getBoundingClientRect();
    const b = menuBtn.getBoundingClientRect();
    quickMenu.style.left = `${b.left - p.left - 4}px`;
    quickMenu.style.top = `${Math.max(2, b.top - p.top - quickMenu.offsetHeight - 4)}px`;
  }
  function hideQuickMenu(now = false) {
    clearTimeout(quickTimer);
    // A short delay lets the pointer travel from the button up into the menu.
    quickTimer = setTimeout(() => (quickMenu.hidden = true), now ? 0 : 160);
  }
  for (const el of [menuBtn, quickMenu]) {
    el.addEventListener('mouseenter', showQuickMenu);
    el.addEventListener('mouseleave', () => hideQuickMenu());
  }

  const askRow = panel.querySelector('.ask-row');
  const toolbar = panel.querySelector('.toolbar');
  // Cluely's sizes: a conversation stops at 500px and scrolls; History grows to fit up to 760px.
  const MAX_CHAT_WINDOW = 500;
  const MAX_HISTORY_WINDOW = 760; // matches CHAT_MAX_HEIGHT in main.js
  const SESSION_PAGE_HEIGHT = 758; // a finished session's summary or transcript page
  let windowRaised = false; // the last resize asked main to make room for a session page
  let windowHeight = 0;
  let bodyCapped = false; // the answer is taller than the screen allows, so the thread scrolls

  /** Height the conversation (or history list) wants: its last child's bottom, plus padding. */
  function naturalBodyHeight() {
    const list = view === 'history' ? historyList : thread;
    const last = list.lastElementChild;
    let height = last ? last.offsetTop + last.offsetHeight + 10 : 0;
    // An open screenshot preview floats over the answer; make room if it hangs past the end.
    if (view !== 'history' && openPreview) {
      const box = openPreview.preview;
      height = Math.max(height, openPreview.el.offsetTop + box.offsetTop + box.offsetHeight + 12);
    }
    return height;
  }

  let openPreview = null; // the turn whose screenshot preview is showing

  function closePreview() {
    if (!openPreview) return;
    openPreview.preview.remove();
    openPreview.preview = null;
    openPreview.shot.setAttribute('aria-expanded', 'false');
    openPreview = null;
    document.removeEventListener('mousedown', onPreviewOutside, true);
    document.removeEventListener('keydown', onPreviewKey, true);
    fit();
  }

  function onPreviewOutside(event) {
    if (openPreview && !openPreview.preview.contains(event.target) && !openPreview.shot.contains(event.target)) closePreview();
  }

  function onPreviewKey(event) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      closePreview();
    }
  }

  /** Show the screenshot sent with a question in a small framed popover under its label. */
  async function togglePreview(t) {
    if (openPreview === t) return closePreview();
    closePreview();
    const box = h('div', { class: 'shot-preview', role: 'dialog', 'aria-label': 'Screenshot attached to your question' });
    box.style.top = `${t.shot.offsetTop + t.shot.offsetHeight + 8}px`;
    box.style.left = `${t.shot.offsetLeft}px`;
    const frame = h('div', { class: 'shot-frame loading' });
    box.append(frame);
    t.el.append(box);
    t.preview = box;
    t.shot.setAttribute('aria-expanded', 'true');
    openPreview = t;
    document.addEventListener('mousedown', onPreviewOutside, true);
    document.addEventListener('keydown', onPreviewKey, true);
    fit();

    const url = t.screenshotId ? await api.screenshotPreview(t.screenshotId) : null;
    if (openPreview !== t) return; // closed while loading
    frame.classList.remove('loading');
    if (!url) {
      frame.append(
        h('p', { class: 'shot-missing' }, t.screenshotId ? 'Screenshot unavailable' : "Screenshots aren't saved with history"),
      );
      fit();
      return;
    }
    const img = h('img', { alt: 'Screenshot attached to your question', src: url });
    img.addEventListener('load', fit);
    frame.append(img);
  }

  /**
   * Ask for exactly the height the box needs. The box fills its window and the main process
   * eases the window to this height, so growth is smooth and the native glass behind the window
   * always matches the box.
   */
  function fit() {
    const bar = meetingBar.hidden ? toolbar : meetingBar;
    const chrome = askRow.offsetHeight + bar.offsetHeight; // the box is exactly its bands: 56 + 48 = 104, as Cluely
    // A finished session's summary and transcript pages are a fixed 758pt, as in Cluely; the
    // window slides up to fit them if it sits too low.
    if (!meetingBar.hidden) {
      const height = Math.min(SESSION_PAGE_HEIGHT, screen.availHeight - 28);
      if (height !== windowHeight || !windowRaised) {
        windowHeight = height;
        windowRaised = true;
        api.resizeChat(height, true);
      }
      bodyCapped = false;
      updateFade();
      return;
    }
    if (windowRaised) {
      windowRaised = false;
      windowHeight = -1; // always tell main, so the window goes back to where it was
    }
    const cap = view === 'history' ? MAX_HISTORY_WINDOW : MAX_CHAT_WINDOW;
    const full = view === 'history' || view === 'transcript' || view === 'summary'; // these open at their full height
    const room = Math.min(cap, screen.availTop + screen.availHeight - window.screenY - 14);
    const natural = naturalBodyHeight();
    bodyCapped = natural > room - chrome;
    const open = full || panel.classList.contains('expanded');
    // History and the transcript open at their full height; a conversation grows with its content.
    const bodyHeight = full ? Math.max(0, room - chrome) : open ? Math.max(0, Math.min(natural, room - chrome)) : 0;
    const wanted = chrome + bodyHeight;
    if (wanted !== windowHeight) {
      windowHeight = wanted;
      api.resizeChat(wanted);
    }
    holdAnchor(); // keeps a new follow-up at the top while the window grows
  }

  /** The tallest the conversation area can be right now (window cap and screen room, minus chrome). */
  function conversationRoom() {
    const bar = meetingBar.hidden ? toolbar : meetingBar;
    const chrome = askRow.offsetHeight + bar.offsetHeight; // the box is exactly its bands: 56 + 48 = 104, as Cluely
    const room = Math.min(MAX_CHAT_WINDOW, screen.availTop + screen.availHeight - window.screenY - 14);
    return Math.max(0, room - chrome);
  }



  /** The box grows downward into a conversation once there is one, and folds back on request. */
  function refreshLayout() {
    const hasTurns = thread.childElementCount > 0;
    const inHistory = view === 'history';
    const inTranscript = view === 'transcript';
    const inSummary = view === 'summary';
    const open = hasTurns && expanded && !inHistory && !inTranscript && !inSummary;
    // While a meeting is (or was just) transcribed, the right side switches between its two views.
    const meeting = Boolean(state.isListening || transcript);
    // A finished session's transcript and summary get their own bar: Back, switch view, Resume.
    const finished = Boolean(transcript) && !state.isListening && (inTranscript || inSummary);
    toolbar.hidden = finished;
    meetingBar.hidden = !finished;
    showTranscriptBtn.hidden = !inSummary;
    showSummaryBtn.hidden = !inTranscript;
    panel.classList.toggle('expanded', open);
    if (open !== sentExpanded) {
      sentExpanded = open;
      api.patchState({ chatExpanded: open }); // drives the "Tab to focus" hint
    }
    panel.classList.toggle('history-open', inHistory);
    panel.classList.toggle('transcript-open', inTranscript);
    panel.classList.toggle('summary-open', inSummary);
    panel.classList.toggle('meeting-done', finished);
    historyBtn.hidden = meeting || open || inHistory; // with nothing asked yet it stays put, folded
    newChatBtn.hidden = meeting || !open;
    historyActions.hidden = !inHistory;
    viewChatBtn.hidden = !meeting || !inTranscript;
    viewTranscriptBtn.hidden = !meeting || inTranscript || inHistory;
    input.placeholder = inHistory
      ? 'Ask or search anything'
      : meeting
        ? open
          ? 'Ask a follow-up about the meeting'
          : 'Ask anything about the meeting'
        : open
          ? 'Ask follow-up'
          : state.useScreen
            ? 'Ask anything about your screen'
            : 'Ask anything';
    sendBtn.replaceChildren(icon(busy() ? 'square' : 'corner-down-left'));
    sendBtn.setAttribute('data-tip', busy() ? 'Stop' : 'Ask');
    syncTabHint();
    fit();
  }

  function onBack() {
    if (view === 'history') closeHistory();
    else if (view === 'transcript' && state.isListening) showView('chat');
    else if (view === 'transcript' || view === 'summary') closeMeetingView();
    else setExpanded(false);
  }

  /** Leave a finished session's summary or transcript for History, with that session selected. */
  async function closeMeetingView() {
    const id = transcript?.id;
    expanded = false;
    api.closeMeeting();
    openHistory();
    await loadHistory('');
    const index = historyRows.findIndex(({ entry }) => entry.id === id);
    if (index >= 0) {
      selectRow(index);
      historyRows[index].row.scrollIntoView({ block: 'nearest' });
    }
  }

  const peopleLabel = () => {
    const speakers = new Set((transcript?.entries || []).map((e) => e.speaker));
    return [speakers.has('me') && 'Me', speakers.has('them') && 'Them'].filter(Boolean).join(', ') || 'Me';
  };

  function renderSummary() {
    if (!transcript) return;
    const state_ = transcript.summaryState;
    const title = transcript.title || (state_ === 'pending' ? 'Summarizing…' : 'Untitled session');
    const date = new Date(transcript.startedAt || Date.now()).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    summaryTitle.textContent = title;
    transcriptMetaTitle.textContent = title;
    dateChip.lastChild.textContent = date;
    transcriptDateChip.lastChild.textContent = date;
    peopleChip.lastChild.textContent = peopleLabel();
    transcriptPeopleChip.lastChild.textContent = peopleLabel();
    copySummaryBtn.disabled = !transcript.summary;
    if (state_ === 'ready' && transcript.summary) {
      summaryBody.innerHTML = window.renderMarkdown(transcript.summary);
    } else if (state_ === 'failed') {
      summaryBody.replaceChildren(
        h('p', { class: 'summary-note error' }, `Could not summarize: ${transcript.summaryError || 'unknown error'}`),
        h('button', { class: 'text-btn dim', onClick: () => api.summarizeMeeting() }, icon('rotate-ccw'), 'Try again'),
      );
    } else if (!transcript.entries.length) {
      summaryBody.replaceChildren(h('p', { class: 'summary-note' }, 'Nothing was transcribed in this session.'));
    } else {
      summaryBody.replaceChildren(h('p', { class: 'summary-note' }, 'Writing a summary…'));
    }
  }

  async function copySummary() {
    if (!transcript?.summary) return;
    await navigator.clipboard.writeText(`${transcript.title}\n\n${transcript.summary}`);
    copySummaryBtn.lastChild.textContent = 'Copied';
    setTimeout(() => (copySummaryBtn.lastChild.textContent = 'Copy Summary'), 1200);
  }

  /** Switch between the conversation and the meeting transcript. */
  function showView(next) {
    view = next;
    if (next === 'chat') expanded = thread.childElementCount > 0;
    refreshLayout();
    if (next === 'transcript') {
      followTranscript = true;
      transcriptList.scrollTop = transcriptList.scrollHeight;
    } else if (expanded) thread.scrollTop = thread.scrollHeight;
  }

  const clock = (seconds) => {
    const total = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = String(total % 60).padStart(2, '0');
    return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${secs}` : `${minutes}:${secs}`;
  };
  const speakerLabel = (speaker) => (speaker === 'me' ? 'Me' : 'Them');

  /** Lines to show: settled text, then words still being spoken. A speaker's lines that follow
   * each other with no gap are joined into one. */
  function transcriptLines() {
    if (!transcript) return [];
    const lines = [];
    for (const entry of transcript.entries) {
      const last = lines[lines.length - 1];
      if (last && last.speaker === entry.speaker && entry.start - last.end < 1) {
        last.text = `${last.text} ${entry.text}`;
        last.end = entry.end;
      } else lines.push({ ...entry });
    }
    const partials = ['me', 'them']
      .map((speaker) => transcript.partial?.[speaker] && { speaker, ...transcript.partial[speaker], partial: true })
      .filter((p) => p && p.text);
    return lines.concat(partials).sort((a, b) => a.start - b.start);
  }

  const PARAGRAPH_CHARS = 180; // about three lines; past this the next sentence starts a new line
  const RUN_ON_CHARS = 360; // speech with no full stops is broken at a word past this

  /** One speaker's turn as short paragraphs, each starting at a new sentence. Greedy, so the
   * breaks stay put while the words still being spoken grow. */
  function transcriptParagraphs(text) {
    const sentences = String(text).trim().split(/(?<=[.!?…])\s+/);
    const paragraphs = [];
    let current = '';
    for (const sentence of sentences) {
      if (current && current.length + sentence.length + 1 > PARAGRAPH_CHARS) {
        paragraphs.push(current);
        current = sentence;
      } else current = current ? `${current} ${sentence}` : sentence;
      // A long stretch with no sentence end: break at the last space before the limit.
      while (current.length > RUN_ON_CHARS) {
        const cut = current.lastIndexOf(' ', RUN_ON_CHARS);
        if (cut <= 0) break;
        paragraphs.push(current.slice(0, cut));
        current = current.slice(cut + 1);
      }
    }
    if (current) paragraphs.push(current);
    return paragraphs;
  }

  function renderTranscript() {
    const atEnd = transcriptList.scrollHeight - transcriptList.scrollTop - transcriptList.clientHeight < 24;
    const lines = transcriptLines();
    const rows = lines.map((line) =>
      h(
        'div',
        { class: line.partial ? 't-row partial' : 't-row' },
        h('span', { class: 't-time' }, clock(line.start)),
        h('div', { class: 't-body' }, h('div', { class: 't-who' }, speakerLabel(line.speaker)), h('div', { class: 't-text' }, ...transcriptParagraphs(line.text).map((p) => h('p', { class: 't-para' }, p)))),
      ),
    );
    if (!rows.length) {
      const waiting = state.listenPaused ? 'Paused. Resume to keep transcribing.' : state.isListening ? 'Listening… The transcript appears here as people speak.' : 'Nothing was transcribed.';
      rows.push(h('div', { class: 'transcript-empty' }, waiting));
    }
    transcriptList.replaceChildren(...rows);
    copyTranscriptBtn.disabled = !lines.length;
    if (followTranscript || atEnd) transcriptList.scrollTop = transcriptList.scrollHeight;
  }

  async function copyTranscript() {
    const text = transcriptLines()
      .map((line) => `[${clock(line.start)}] ${speakerLabel(line.speaker)}: ${line.text}`)
      .join('\n');
    await navigator.clipboard.writeText(text);
    copyTranscriptBtn.lastChild.textContent = 'Copied';
    setTimeout(() => (copyTranscriptBtn.lastChild.textContent = 'Copy Transcript'), 1200);
  }

  function setTranscript(next) {
    transcript = next;
    if (next && next.id === openingMeeting) view = 'summary';
    if (!transcript && (view === 'transcript' || view === 'summary') && !state.isListening) view = 'chat';
    renderTranscript();
    renderSummary();
    refreshLayout();
  }

  let timerHandle = null;
  function paintTimer() {
    const { base = 0, since = null } = state.listenClock || {};
    timer.textContent = clock((base + (since ? Date.now() - since : 0)) / 1000);
  }

  function openHistory() {
    view = 'history';
    input.value = '';
    selectedRow = 0;
    refreshLayout();
    loadHistory('');
    input.focus();
  }

  function closeHistory() {
    view = 'chat';
    input.value = '';
    refreshLayout();
  }

  async function loadHistory(query) {
    const request = ++historyRequest;
    const entries = await api.listHistory(query);
    if (request !== historyRequest || view !== 'history') return; // a newer search won
    historyEntries = entries;
    // The conversation on screen is listed even when history saving is off.
    if (!query && thread.childElementCount && !entries.some((e) => e.id === state.currentChatId)) {
      const first = thread.querySelector('.asked')?.textContent || 'Current chat';
      historyEntries = [{ id: '', title: first === 'Assist' ? 'Current chat' : first, startedAt: Date.now(), updatedAt: Date.now() }, ...entries];
    }
    selectedRow = 0;
    renderHistory(query);
  }

  const dayLabel = (ms) =>
    new Date(ms).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: '2-digit', year: 'numeric' }).toUpperCase();
  const timeLabel = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const minutesLabel = (e) => `${Math.max(1, Math.round((e.updatedAt - e.startedAt) / 60000))}m`;

  function renderHistory(query) {
    historyRows = [];
    const children = [];
    let lastDay = '';
    for (const entry of historyEntries) {
      const day = dayLabel(entry.updatedAt);
      if (day !== lastDay) {
        children.push(h('div', { class: 'history-day' }, day));
        lastDay = day;
      }
      const index = historyRows.length;
      const row = h(
        'button',
        { class: 'history-row', role: 'option', onClick: () => openRow(index), onMouseenter: () => selectRow(index) },
        h('span', { class: 'doc-mark' }, icon(entry.kind === 'meeting' ? 'audio-lines' : 'hero-o-document')),
        h('span', { class: 'row-title' }, entry.title),
        h('span', { class: 'row-chip' }, entry.kind === 'meeting' ? `${Math.max(1, Math.round((entry.durationMs || 0) / 60000))}m` : minutesLabel(entry)),
        h('span', { class: 'row-time' }, timeLabel(entry.updatedAt)),
      );
      historyRows.push({ entry, row });
      children.push(row);
    }
    if (!historyRows.length) {
      children.push(
        h(
          'div',
          { class: 'history-empty' },
          query ? `No chats match “${query}”. Press ↵ to ask it instead.` : 'No chats yet. Your conversations will show up here.',
        ),
      );
    }
    historyList.replaceChildren(...children);
    openBtn.disabled = !historyRows.length;
    selectRow(0);
    fit();
  }

  function selectRow(index) {
    if (!historyRows.length) return;
    selectedRow = Math.max(0, Math.min(index, historyRows.length - 1));
    historyRows.forEach(({ row }, i) => row.setAttribute('aria-selected', String(i === selectedRow)));
  }

  async function openRow(index) {
    const item = historyRows[index];
    if (!item) return;
    const { entry } = item;
    if (entry.kind === 'meeting') {
      // Opening resets the chat; whichever of the reset and the session arrives last, the
      // session's summary is what ends up on screen.
      openingMeeting = entry.id;
      const opened = await api.openMeeting(entry.id);
      if (!opened) {
        openingMeeting = null;
        return loadHistory(input.value);
      }
      input.value = '';
      setTranscript(opened);
      setTimeout(() => (openingMeeting = null), 1000);
      return;
    }
    // The conversation already on screen just unfolds, keeping its live context.
    if (!entry.id || (entry.id === state.currentChatId && thread.childElementCount)) {
      closeHistory();
      setExpanded(true);
      return;
    }
    const saved = await api.openHistory(entry.id);
    if (!saved) return loadHistory(input.value);
    showSavedChat(saved.turns);
    closeHistory();
    setExpanded(true);
  }

  /** Rebuild the thread from a saved conversation. */
  function showSavedChat(turns) {
    turn = null;
    thread.replaceChildren();
    for (const saved of turns) {
      startTurn(saved.question, saved.usedScreen);
      turn.raw = saved.answer;
      turn.answer.innerHTML = window.renderMarkdown(saved.answer);
      decorateCode(turn.answer);
      setPhase('done', '');
    }
  }

  function onHistoryKey(event) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      selectRow(selectedRow + (event.key === 'ArrowDown' ? 1 : -1));
      historyRows[selectedRow]?.row.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      const query = input.value.trim();
      if (historyRows.length) openRow(selectedRow);
      else if (query) {
        closeHistory();
        input.value = query;
        submit();
      }
    } else if (event.key === 'Escape') {
      closeHistory();
    }
  }

  function setExpanded(open) {
    expanded = open;
    refreshLayout();
    if (open) thread.scrollTop = thread.scrollHeight;
  }

  function setPhase(next, text, isError = false) {
    phase = next;
    if (turn) {
      // Until the first words arrive, an animated mark stands in for a status caption.
      const thinking = next === 'capturing' || next === 'waiting';
      turn.thinking.hidden = !thinking;
      if (thinking && text) turn.thinking.title = text;
      turn.shot.hidden = thinking || !turn.usedScreen || next === 'error';
      if (isError && !turn.raw) {
        turn.answer.classList.add('failed');
        turn.answer.textContent = text;
      }
      turn.actions.hidden = busy() || !turn.raw;
    }
    refreshLayout();
  }

  const finish = (text) => setPhase('done', text);

  /**
   * The answer without the hidden <followups> block the model appends. While streaming, a
   * half-arrived opening tag at the very end is held back too, so it never flashes on screen.
   */
  function visibleAnswer(raw) {
    const tag = '<followups>';
    const start = raw.toLowerCase().indexOf('<followups');
    if (start >= 0) return raw.slice(0, start).trimEnd();
    const lt = raw.lastIndexOf('<');
    return lt >= 0 && tag.startsWith(raw.slice(lt).toLowerCase()) ? raw.slice(0, lt) : raw;
  }

  const followUpKey = (index) => formatAccelerator(state.shortcuts[`followUp${index + 1}`]);

  /** An option's label, with inline Markdown and maths drawn like the answer's ($O(n)$, `code`). */
  function followUpText(text) {
    const span = h('span', { class: 'follow-text' });
    span.innerHTML = window.renderInlineMarkdown(text); // escapes HTML before adding markup
    window.renderMath(span);
    return span;
  }

  /** Numbered options under the newest answer; click one or press its hotkey to ask it. */
  function showFollowUps(options) {
    if (!turn || !options.length) return;
    turn.followUps = options;
    turn.followUpList = h(
      'div',
      { class: 'follow-ups', role: 'list', 'aria-label': 'Suggested follow-ups' },
      options.map((text, index) =>
        h(
          'button',
          { class: 'follow-up', role: 'listitem', onClick: () => askFollowUp(index) },
          h('kbd', { class: 'keycap' }, followUpKey(index)),
          followUpText(text),
        ),
      ),
    );
    turn.el.append(turn.followUpList);
    fit();
    holdAnchor();
  }

  /** Options only belong to the newest answer; drop them once anything else is asked. */
  function clearFollowUps() {
    if (turn && turn.followUpList) {
      turn.followUpList.remove();
      turn.followUpList = null;
      turn.followUps = null;
    }
    api.clearFollowUps();
  }

  function askFollowUp(index) {
    const question = turn && turn.followUps && turn.followUps[index];
    if (!question || busy()) return;
    if (view === 'history') closeHistory();
    submit(question);
  }

  /** Number the lines of each code block and give it a copy button. */
  function decorateCode(container) {
    for (const pre of container.querySelectorAll('pre')) {
      const code = pre.querySelector('code');
      const text = code.textContent;
      code.replaceChildren(...window.highlightLines(text, code.dataset.lang || ''));
      pre.append(copyButton(() => text, 'code-copy'));
    }
    window.renderMath(container); // formulas are drawn once the answer's HTML is in place
  }

  function copyButton(getText, extra = '') {
    const btn = h('button', { class: `tool small ${extra}`, 'data-tip': 'Copy' }, icon('copy'));
    btn.addEventListener('click', async () => {
      await navigator.clipboard.writeText(getText());
      btn.setAttribute('data-tip', 'Copied');
      setTimeout(() => btn.setAttribute('data-tip', 'Copy'), 1200);
    });
    return btn;
  }

  function paint() {
    paintQueued = false;
    if (!turn) return;
    turn.answer.innerHTML = window.renderMarkdown(visibleAnswer(turn.raw));
    decorateCode(turn.answer);
    fit();
    holdAnchor();
  }

  /** Keep the newest question at the top (as far as the content allows), then refresh the fade. */
  let sliding = false; // a follow-up is sliding into place; don't fight the smooth scroll

  function holdAnchor() {
    if (anchor != null && !sliding) thread.scrollTop = anchor;
    updateFade();
  }

  function updateFade() {
    const more = thread.scrollHeight - thread.scrollTop - thread.clientHeight > 4;
    body.classList.toggle('more-below', more);
    jumpBtn.hidden = !more;
  }

  function jumpToEnd() {
    anchor = null;
    thread.scrollTo({ top: thread.scrollHeight, behavior: 'smooth' });
  }

  function queuePaint() {
    if (!paintQueued) {
      paintQueued = true;
      requestAnimationFrame(paint);
    }
  }

  function onSend() {
    if (busy()) stop();
    else submit();
  }

  function stop() {
    api.stopChat();
    finish('Stopped');
  }

  /** Ask what is typed in the box, or `picked` (a follow-up option) while leaving any draft alone. */
  async function submit(picked) {
    if (phase === 'capturing') return;
    if (view === 'transcript') view = 'chat'; // the answer shows in the conversation
    const question = typeof picked === 'string' ? picked : input.value;
    if (typeof picked !== 'string') input.value = '';
    expanded = true; // a new answer never lands in a folded box
    startTurn(question.trim(), state.useScreen);

    let screenshotId = null;
    if (state.useScreen) {
      setPhase('capturing', 'Reading your screen…');
      try {
        ({ id: screenshotId } = await api.captureScreenshot());
        if (turn) turn.screenshotId = screenshotId;
      } catch (err) {
        setPhase('error', err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), true);
        return;
      }
    }
    setPhase('waiting', 'Thinking…');
    api.sendChat({ question, screenshotId });
  }

  /** Add a new question to the bottom of the thread and scroll to it. */
  function startTurn(question, usedScreen) {
    clearFollowUps();
    const next = { raw: '', usedScreen };
    next.thinking = thinkingMark();
    next.answer = h('div', { class: 'answer' });
    next.meta = h('div', { class: 'turn-meta', hidden: true });
    // "Viewed screen": click to see the screenshot that went with this question.
    next.shot = h(
      'button',
      { class: 'turn-shot', hidden: true, 'aria-expanded': 'false', onClick: () => togglePreview(next) },
      icon('image'),
      'Viewed screen',
    );
    next.actions = h('div', { class: 'answer-actions', hidden: true }, copyButton(() => next.raw));
    turn = next;
    next.el = h(
      'div',
      { class: 'turn' },
      h('div', { class: question ? 'asked' : 'asked assist' }, question || 'Assist'),
      next.shot,
      next.meta,
      next.thinking,
      next.answer,
      next.actions,
    );
    // A follow-up starts on a clean page: it gets at least a full view of height (only the newest
    // turn keeps that space, as in Cluely), so the conversation can slide up until the question
    // sits at the top with its answer streaming in underneath.
    const followUp = thread.childElementCount > 0;
    for (const el of thread.querySelectorAll('.turn')) el.style.minHeight = '';
    if (followUp) next.el.style.minHeight = `${Math.max(0, Math.max(conversationRoom(), thread.clientHeight) - 16)}px`;
    thread.append(next.el);
    anchor = Math.max(0, next.el.offsetTop - 8);
    if (followUp) {
      sliding = true;
      refreshLayout();
      thread.scrollTo({ top: anchor, behavior: 'smooth' });
      setTimeout(() => {
        sliding = false;
        holdAnchor();
      }, 450);
    } else {
      refreshLayout();
      holdAnchor();
    }
  }

  /** Claude-style spark for Claude answers, a pulsing dot for ChatGPT and OpenAI. */
  function thinkingMark() {
    const mark =
      state.provider === 'chatgpt' || state.provider === 'openai'
        ? h('span', { class: 'think-dot' })
        : h('span', { class: 'think-spark' }, icon('spark'));
    return h('div', { class: 'thinking', hidden: true, role: 'status', 'aria-label': 'Thinking' }, mark);
  }

  function toggleScreen() {
    api.patchState({ useScreen: !state.useScreen });
  }

  api.onSubmit(() => submit());
  api.onFollowUp(({ index }) => askFollowUp(index));
  api.onStatus(({ text }) => setPhase('waiting', text));
  api.onStreamStart(() => setPhase('waiting', 'Thinking…'));
  api.onStreamDelta(({ text }) => {
    if (!turn) return;
    if (phase !== 'streaming') setPhase('streaming', '');
    turn.raw += text;
    queuePaint();
  });
  api.onStreamDone(({ truncated, followUps }) => {
    if (turn) turn.raw = visibleAnswer(turn.raw); // Copy takes the answer without the hidden block
    paint();
    finish(truncated ? 'Cut off at the length limit' : 'Done');
    if (truncated && turn) {
      turn.meta.textContent = 'Cut off at the length limit';
      turn.meta.hidden = false;
    }
    showFollowUps(Array.isArray(followUps) ? followUps : []);
  });
  api.onStreamError(({ message, needsKey }) => {
    setPhase('error', message, true);
    if (needsKey) api.openSettings('general');
  });
  api.onStartNew(() => {
    if (openingMeeting) view = 'summary';
    else view = view === 'transcript' && state.isListening ? 'transcript' : 'chat';
    closePreview();
    turn = null;
    anchor = null;
    thread.replaceChildren();
    input.value = '';
    setPhase('idle', '');
  });
  api.onFocusInput(() => input.focus());
  api.onBlurInput(() => input.blur());
  api.onScroll((delta) => {
    anchor = null;
    thread.scrollBy({ top: delta, behavior: 'smooth' });
  });
  // Scrolling yourself (wheel, trackpad, scrollbar, keys) lets go of the held question.
  for (const type of ['wheel', 'touchmove', 'mousedown', 'keydown']) thread.addEventListener(type, () => (anchor = null), { passive: true });
  thread.addEventListener('scroll', updateFade, { passive: true });
  transcriptList.addEventListener(
    'scroll',
    () => (followTranscript = transcriptList.scrollHeight - transcriptList.scrollTop - transcriptList.clientHeight < 24),
    { passive: true },
  );
  api.onTranscript(setTranscript);
  api.getTranscript().then(setTranscript);

  // The window may refuse focus while invisible; ask the main process to let this click in.
  input.addEventListener('mousedown', () => {
    if (!document.hasFocus()) api.focusChatInput();
  });
  input.addEventListener('input', () => {
    if (view === 'history') loadHistory(input.value.trim());
    syncTabHint();
  });
  input.addEventListener('focus', syncTabHint);
  input.addEventListener('blur', syncTabHint);
  window.addEventListener('blur', syncTabHint);
  input.addEventListener('keydown', (event) => {
    if (view === 'history') return onHistoryKey(event);
    if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) submit();
    if (event.key === 'Escape') {
      if (busy()) stop();
      else input.blur();
    }
  });

  let wasListening = false;
  subscribe((s) => {
    const caps = () => (s.shortcuts.newChat || '').split('+').filter(Boolean).map((part) => h('kbd', { class: 'keycap' }, formatAccelerator(part)));
    newKeys.replaceChildren(...caps());
    historyNewKeys.replaceChildren(...caps());
    listenBtn.classList.toggle('on', s.isListening);
    listenBtn.setAttribute('data-tip', s.audioNotice || (s.isListening ? 'Stop listening' : 'Listen'));
    // A session takes over the listen button: pause, stop and the running time.
    listenBtn.hidden = s.isListening;
    sessionControls.hidden = !s.isListening;
    pauseBtn.replaceChildren(icon(s.listenPaused ? 'play' : 'pause'));
    pauseBtn.setAttribute('data-tip', s.listenPaused ? 'Resume' : 'Pause');
    sessionControls.classList.toggle('paused', s.listenPaused);
    stopBtn.setAttribute('data-tip', s.audioNotice || 'Stop listening');
    paintTimer();
    clearInterval(timerHandle);
    timerHandle = s.isListening && !s.listenPaused ? setInterval(paintTimer, 500) : null;
    // Starting a session opens the transcript.
    if (s.isListening && !wasListening) showView('transcript');
    // Stopping keeps the transcript on screen (unless History is open).
    if (!s.isListening && wasListening && view !== 'history') showView('transcript');
    wasListening = s.isListening;
    renderTranscript();
    invisibleBtn.classList.toggle('on', s.isInvisible); // white while undetectable, grey while visible
    panel.classList.toggle('undetectable', s.isInvisible); // Cluely rounds the box to 18px while undetectable
    syncTabHint();
    invisibleBtn.replaceChildren(icon(s.isInvisible ? 'hat-glasses' : 'eye'));
    if (!invisibleArmed) invisibleBtn.setAttribute('data-tip', s.isInvisible ? 'Undetectable' : 'Detectable');
    const mode = (s.modes || []).find((m) => m.id === s.mode);
    modeBtn.setAttribute('data-tip', mode ? mode.label : 'General');
    // The grid fills in whenever a mode other than General is on.
    modeBtn.classList.toggle('on', s.mode !== 'general'); // Cluely: the grid is white while a mode is on
    screenBtn.classList.toggle('on', s.useScreen);
    screenBtn.setAttribute('data-tip', s.useScreen ? 'Screen on' : 'Screen off');
    if (turn && turn.followUpList) {
      turn.followUpList.querySelectorAll('kbd').forEach((kbd, index) => (kbd.textContent = followUpKey(index)));
    }
    refreshLayout();
  });
  new ResizeObserver(fit).observe(panel);
  refreshLayout();
}

// ---------- settings ----------

/** Shortcut rows, in display order: [label, icon]. */
const SHORTCUT_LABELS = {
  toggleOverlay: ['Toggle visibility of Waffle', 'app-window-mac'],
  ask: ['Ask Waffle about your screen or audio', 'message-circle-more'],
  newChat: ['Start a new chat', 'message-square-plus'],
  toggleListen: ['Start or stop listening', 'mic'],
  moveUp: ['Move the window position up', 'square-chevron-up'],
  moveDown: ['Move the window position down', 'square-chevron-down'],
  moveLeft: ['Move the window position left', 'square-chevron-left'],
  moveRight: ['Move the window position right', 'square-chevron-right'],
  scrollUp: ['Scroll the response window up', 'arrow-up-from-line'],
  scrollDown: ['Scroll the response window down', 'arrow-down-from-line'],
  followUp1: ['Ask suggested follow-up 1', 'list-ordered'],
  followUp2: ['Ask suggested follow-up 2', 'list-ordered'],
  followUp3: ['Ask suggested follow-up 3', 'list-ordered'],
};

/**
 * A themed dropdown in place of the system one. The <select> stays the source of truth (code
 * keeps setting .value, replacing options and listening for 'change'); this draws a borderless
 * trigger and a dark menu from it, and keeps the label in step with it.
 */
function themedSelect(select) {
  const label = h('span', { class: 'dd-label' });
  const trigger = h('button', { class: 'dd-trigger', type: 'button', 'aria-haspopup': 'listbox', 'aria-expanded': 'false' }, label, icon('chevron-down'));
  const wrap = h('div', { class: 'dd' }, trigger, select);
  select.hidden = true;
  const sync = () => {
    const chosen = select.selectedOptions[0];
    const logo = chosen?.dataset.icon;
    label.replaceChildren(...(logo ? [icon(logo)] : []), chosen?.textContent || '');
  };
  const native = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  Object.defineProperty(select, 'value', {
    get() {
      return native.get.call(this);
    },
    set(value) {
      native.set.call(this, value);
      sync();
    },
  });
  new MutationObserver(sync).observe(select, { childList: true, subtree: true, characterData: true, attributes: true });
  sync();

  let menu = null;
  let items = [];
  let active = -1;

  function close() {
    if (!menu) return;
    menu.remove();
    menu = null;
    trigger.setAttribute('aria-expanded', 'false');
    trigger.classList.remove('open');
    document.removeEventListener('mousedown', onOutside, true);
    window.removeEventListener('blur', close);
    window.removeEventListener('resize', close);
    document.removeEventListener('scroll', close, true);
  }

  function choose(option) {
    if (option.disabled) return;
    close();
    if (select.value !== option.value) {
      select.value = option.value;
      select.dispatchEvent(new Event('change'));
    }
    trigger.focus();
  }

  function highlight(index) {
    active = index;
    items.forEach((item, i) => item.classList.toggle('active', i === index));
    items[index]?.scrollIntoView({ block: 'nearest' });
  }

  function open() {
    const options = [...select.options];
    items = options.map((option) =>
      h(
        'button',
        {
          class: 'dd-item',
          type: 'button',
          role: 'option',
          disabled: option.disabled,
          'aria-selected': String(option.selected),
          onClick: () => choose(option),
        },
        h('span', { class: 'dd-text' }, option.dataset.icon && icon(option.dataset.icon), option.textContent),
        option.selected && icon('check'),
      ),
    );
    items.forEach((el, i) => el.addEventListener('mouseenter', () => highlight(i)));
    menu = h('div', { class: 'dd-menu', role: 'listbox' }, items);
    document.body.append(menu);
    const box = trigger.getBoundingClientRect();
    const width = Math.max(200, box.width);
    menu.style.minWidth = `${width}px`;
    const left = Math.max(8, Math.min(box.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8));
    const below = window.innerHeight - box.bottom - 8;
    const top = below >= Math.min(menu.offsetHeight, 220) ? box.bottom + 4 : Math.max(8, box.top - menu.offsetHeight - 4);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    trigger.setAttribute('aria-expanded', 'true');
    trigger.classList.add('open');
    highlight(Math.max(0, options.findIndex((o) => o.selected)));
    document.addEventListener('mousedown', onOutside, true);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    document.addEventListener('scroll', close, true);
  }

  function onOutside(event) {
    if (!menu.contains(event.target) && !trigger.contains(event.target)) close();
  }

  trigger.addEventListener('click', () => (menu ? close() : open()));
  trigger.addEventListener('keydown', (event) => {
    const options = [...select.options];
    if (!menu && ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
      event.preventDefault();
      open();
      return;
    }
    if (!menu) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      let next = active;
      do next = (next + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
      while (options[next].disabled && next !== active);
      highlight(next);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (options[active]) choose(options[active]);
    } else if (event.key === 'Tab') {
      close();
    }
  });
  return wrap;
}

/** A settings row: optional icon tile, title and hint on the left, a control on the right. */
const row = (title, hint, control, iconName) =>
  h(
    'div',
    { class: 'row' },
    iconName && h('span', { class: 'row-ico' }, icon(iconName)),
    h('div', { class: 'label' }, title && h('b', {}, title), hint && (typeof hint === 'string' ? h('small', {}, hint) : hint)),
    control && control.tagName === 'SELECT' ? themedSelect(control) : control,
  );

/** A titled block of rows, the way every settings page is laid out. */
const section = (title, ...rows) =>
  h('section', { class: 'set-section' }, title && h('h2', { class: 'group-title' }, title), h('div', { class: 'group' }, rows.flat(Infinity)));

function toggleRow(title, hint, key, iconName) {
  const button = h('button', {
    class: 'switch',
    role: 'switch',
    'aria-label': title,
    onClick: () => api.patchState({ [key]: !state[key] }),
  });
  subscribe((s) => button.setAttribute('aria-checked', String(Boolean(s[key]))));
  return row(title, hint, button, iconName);
}

const PROVIDERS = {
  claude: { account: 'Claude', cli: 'Claude Code' },
  chatgpt: { account: 'ChatGPT', cli: 'Codex CLI' },
};

const cleanError = (err) => err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

function generalPane() {
  const listenBtn = h('button', { class: 'btn', onClick: () => api.toggleListen() });
  const engine = h(
    'select',
    { onChange: () => api.patchState({ speechEngine: engine.value }) },
    h('option', { value: 'apple' }, 'On this Mac'),
    h('option', { value: 'api' }, 'Speech API'),
  );
  api.refreshProviders();
  const provider = h(
    'select',
    { onChange: () => api.patchState({ provider: provider.value }) },
    h('option', { value: 'claude', 'data-icon': 'logo-claude' }, 'Claude subscription'),
    h('option', { value: 'chatgpt', 'data-icon': 'logo-chatgpt' }, 'ChatGPT subscription'),
    h('option', { value: 'api', 'data-icon': 'logo-claude' }, 'Anthropic API key'),
    h('option', { value: 'openai', 'data-icon': 'logo-chatgpt' }, 'OpenAI API key'),
  );
  const providerNote = h('p', { class: 'note' });

  const effort = h(
    'select',
    { onChange: () => api.patchState({ effort: effort.value }) },
    h('option', { value: 'low' }, 'Low (fastest)'),
    h('option', { value: 'medium' }, 'Medium'),
    h('option', { value: 'high' }, 'High'),
  );

  // Model picker. Claude models (API key or subscription) are stored in `model`, Codex models in
  // `codexModel` and OpenAI API models in `openaiModel`, where an empty value means the default.
  const modelKey = (p) => ({ chatgpt: 'codexModel', openai: 'openaiModel' })[p] || 'model';
  const listFor = (p) => (p === 'chatgpt' || p === 'openai' ? p : 'claude');
  const modelLists = {}; // 'claude' | 'chatgpt' | 'openai' -> { models, defaultModel }
  let listedWithKey = null; // whether the OpenAI list was fetched with a key saved
  const modelHint = h('small', {});
  const model = h('select', { onChange: () => api.patchState({ [modelKey(state.provider)]: model.value }) });
  let rendered = '';

  function loadModels(list) {
    if (modelLists[list]) return;
    modelLists[list] = { models: [], defaultModel: '', loading: true };
    api
      .listModels(list)
      .then((result) => (modelLists[list] = result))
      .catch(() => (modelLists[list] = { models: [], defaultModel: '' }))
      .finally(() => renderModels(state));
  }

  function renderModels(s) {
    const list = listFor(s.provider);
    const logo = list === 'claude' ? 'logo-claude' : 'logo-chatgpt';
    if (list === 'openai' && listedWithKey !== s.hasSpeechKey) {
      delete modelLists.openai; // the list depends on the key
      listedWithKey = s.hasSpeechKey;
    }
    loadModels(list);
    const { models = [], defaultModel = '', loading } = modelLists[list];
    const value = s[modelKey(s.provider)] || '';
    const key = JSON.stringify([list, value, models.map((m) => m.id), defaultModel, loading]);
    if (key === rendered) return;
    rendered = key;
    const options = [];
    if (list === 'chatgpt') {
      options.push(h('option', { value: '', 'data-icon': logo }, defaultModel ? `Codex default (${defaultModel})` : 'Codex default'));
    }
    if (list === 'openai') {
      options.push(h('option', { value: '', 'data-icon': logo }, defaultModel ? `Newest (${defaultModel})` : 'Newest'));
    }
    for (const m of models) options.push(h('option', { value: m.id, 'data-icon': logo }, m.label));
    if (value && !models.some((m) => m.id === value)) options.push(h('option', { value, 'data-icon': logo }, `${value} (custom)`));
    if (loading && !models.length) options.push(h('option', { value: '', disabled: '' }, 'Loading models…'));
    model.replaceChildren(...options);
    model.value = value;
    const chosen = models.find((m) => m.id === (value || defaultModel));
    modelHint.textContent =
      chosen?.description ||
      { chatgpt: 'Models available to your ChatGPT plan', openai: s.hasSpeechKey ? 'Models your OpenAI key can use' : 'Add a key to list models' }[list] ||
      'Used for answers';
  }

  const modelRow = row('Model', modelHint, model, 'sparkles');

  subscribe((s) => {
    provider.value = s.provider;
    const openaiKey = s.provider === 'openai';
    const isApi = s.provider === 'api' || openaiKey;
    const hasKey = openaiKey ? s.hasSpeechKey : s.hasKey;
    const auth = s.auth[s.provider];
    providerNote.classList.toggle('error', !isApi && Boolean(auth) && !auth.checking && !auth.signedIn);
    if (isApi && !hasKey) providerNote.classList.add('error');
    providerNote.replaceChildren(
      ...[
      isApi
        ? hasKey
          ? `Billed to your ${openaiKey ? 'OpenAI' : 'Anthropic'} API account.`
          : `No ${openaiKey ? 'OpenAI' : 'Anthropic'} key yet. `
        : !auth || auth.checking
          ? 'Checking sign-in…'
          : auth.signedIn
            ? `Counts against your ${PROVIDERS[s.provider].account} plan's usage limits.`
            : auth.disconnected
              ? 'Disconnected from Waffle. '
              : 'Not signed in. ',
      (isApi ? !hasKey : auth && !auth.checking && !auth.signedIn) && h('button', { class: 'link-btn', onClick: () => api.openSettings('account') }, 'Open Account Settings'),
      ].filter(Boolean),
    );
    renderModels(s);
    effort.value = s.effort;
    listenBtn.textContent = s.isListening ? 'Stop listening' : 'Start listening';
    listenBtn.classList.toggle('on', s.isListening);
    engine.value = s.speechEngine;
  });

  return [
    softwareUpdateSection(),
    section(
      'Answers',
      row('Answer with', providerNote, provider, 'message-circle'),
      modelRow,
      row('Effort', 'Lower is faster', effort, 'gauge'),
    ),
    section(
      'Preferences',
      toggleRow('Undetectability', 'Hide Waffle from screen sharing, screenshots and recordings.', 'isInvisible', 'hat-glasses'),
      toggleRow('Stay unfocused while hidden', 'Never take keyboard focus on its own; press Tab to type.', 'noFocusWhenInvisible', 'app-window-mac'),
      toggleRow('Tab to focus', 'While the overlay is on screen, press Tab to type in it without leaving the app you are in.', 'tabToFocus', 'keyboard'),
      toggleRow('Attach a screenshot', 'Send what is on screen with each question.', 'useScreen', 'monitor'),
      toggleRow('Suggest follow-ups', 'Offer 2–3 next questions under each answer; press a number shortcut to ask one.', 'followUps', 'message-circle-more'),
      toggleRow('Open at login', 'Automatically open Waffle when you log in. Applies to the packaged app.', 'openAtLogin', 'power'),
    ),
    // Quick audio controls; everything else (key, status, notices) is on the Audio page.
    section(
      'Audio',
      row('Listening', 'Record the microphone and system audio, and add a transcript to each question.', listenBtn, 'audio-lines'),
      row('Transcription engine', "On this Mac uses Apple's speech engine: private, free, no key.", engine, 'audio-waveform'),
      row('More audio settings', 'OpenAI key, engine status and microphone access.', h('button', { class: 'btn', onClick: () => api.openSettings('audio') }, 'Open Audio'), 'sliders-horizontal'),
    ),
    appFooter(),
  ];
}

// Lucide's download icon (ISC, lucide-static), for the Software Update row.
window.WAFFLE_ICONS.download = {
  v: '0 0 24 24',
  els: [['path', { d: 'M12 15V3' }], ['path', { d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' }], ['path', { d: 'm7 10 5 5 5-5' }]],
};

/**
 * The first section of General, as in Cluely: this version, and a button that checks for an
 * update, shows the download, then restarts into it. Status comes from updater.js (state.update).
 */
function softwareUpdateSection() {
  const hint = h('p', { class: 'note' });
  const button = h('button', {
    class: 'btn',
    type: 'button',
    onClick: () => (state.update.state === 'ready' ? api.installUpdate() : api.checkForUpdates()),
  });
  subscribe((s) => {
    const u = s.update;
    const version = `Version ${u.version}`;
    hint.classList.toggle('error', u.state === 'error');
    hint.textContent =
      {
        dev: `${version} · updates work in the downloaded app`,
        checking: `${version} · checking…`,
        downloading: `${version} · downloading ${u.available}`,
        ready: `Version ${u.available} is ready. Restart to finish updating.`,
        latest: `${version} · you're up to date`,
        error: u.error || "Couldn't check for updates.",
      }[u.state] || version;
    button.textContent =
      { checking: 'Checking…', downloading: `Downloading ${u.percent}%`, ready: 'Restart to update' }[u.state] || 'Check for updates';
    button.disabled = ['dev', 'checking', 'downloading'].includes(u.state);
    button.classList.toggle('primary', u.state === 'ready');
  });
  return section('Software Update', row('Waffle', hint, button, 'download'));
}

/**
 * Cluely's "Account and app" footer at the bottom of General. Reset onboarding opens first-run
 * setup again (Waffle has no account, so there is no Log out).
 */
function appFooter() {
  const action = (label, iconName, onClick, tone) =>
    h('button', { class: `app-foot-btn ${tone}`, type: 'button', onClick }, icon(iconName), label);
  return h(
    'footer',
    { class: 'app-foot' },
    h('p', {}, 'Account and app'),
    h(
      'div',
      { class: 'app-foot-actions' },
      action('Reset onboarding', 'rotate-ccw', () => api.startOnboarding(), 'danger'),
      action('Quit', 'power-off', () => api.quit(), ''),
    ),
  );
}

// ---------- Account (Cluely's profile page) ----------

// Lucide icons the Account page needs that icons.js doesn't carry (ISC, lucide-static).
Object.assign(window.WAFFLE_ICONS, {
  user: { v: '0 0 24 24', els: [['path', { d: 'M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2' }], ['circle', { cx: '12', cy: '7', r: '4' }]] },
  camera: { v: '0 0 24 24', els: [['path', { d: 'M13.997 4a2 2 0 0 1 1.76 1.05l.486.9A2 2 0 0 0 18.003 7H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1.997a2 2 0 0 0 1.759-1.048l.489-.904A2 2 0 0 1 10.004 4z' }], ['circle', { cx: '12', cy: '13', r: '3' }]] },
  'log-out': { v: '0 0 24 24', els: [['path', { d: 'm16 17 5-5-5-5' }], ['path', { d: 'M21 12H9' }], ['path', { d: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4' }]] },
  'refresh-cw': { v: '0 0 24 24', els: [['path', { d: 'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8' }], ['path', { d: 'M21 3v5h-5' }], ['path', { d: 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16' }], ['path', { d: 'M8 16H3v5' }]] },
});

const profileName = (s) => s.profileName || s.systemName || 'Your profile';

// The photo is fetched once per change (profilePhotoRev) and shared by every avatar on screen.
let profilePhoto = null;
let profilePhotoRev = -1;
const avatars = new Set();

function paintAvatar(el) {
  el.replaceChildren(profilePhoto ? h('img', { src: profilePhoto, alt: '' }) : icon('user'));
  el.classList.toggle('has-photo', Boolean(profilePhoto));
}

async function syncProfilePhoto(s) {
  if (s.profilePhotoRev === profilePhotoRev) return;
  profilePhotoRev = s.profilePhotoRev;
  profilePhoto = s.profilePhotoRev ? await api.getProfilePhoto() : null;
  // Forget an avatar once it has left the page (a rebuilt pane), but not one that isn't on it yet:
  // the sidebar's is made before the sidebar is attached.
  for (const el of avatars) {
    if (el.isConnected) el.dataset.shown = '1';
    if (!el.isConnected && el.dataset.shown) avatars.delete(el);
    else paintAvatar(el);
  }
}

/** A round avatar: the profile photo, or Cluely's person glyph on white/10. */
function avatar(size) {
  const el = h('span', { class: `avatar avatar-${size}`, 'aria-hidden': 'true' });
  avatars.add(el);
  paintAvatar(el);
  return el;
}

/** The sidebar's profile button (Cluely: 36px avatar, name, "Account Settings"). */
function profileCard(onClick) {
  const name = h('span', { class: 'profile-card-name' });
  const card = h('button', { class: 'profile-card', type: 'button', onClick }, avatar(36), h('span', { class: 'profile-card-text' }, name, h('span', { class: 'profile-card-sub' }, 'Account Settings')));
  const paint = (s) => {
    name.textContent = profileName(s);
    syncProfilePhoto(s);
  };
  paint(state);
  api.onState(paint); // outside subscribers: the sidebar outlives each page
  return card;
}

const ACCOUNT_ROWS = {
  claude: { name: 'Claude', logo: 'logo-claude', cli: 'Claude Code' },
  chatgpt: { name: 'ChatGPT', logo: 'logo-chatgpt', cli: 'Codex CLI' },
};

function accountPane() {
  api.refreshProviders();
  const flash = h('output', { class: 'profile-flash', hidden: true }, icon('check'), 'Photo updated');
  const photoError = h('p', { class: 'profile-error', hidden: true });
  const pickPhoto = async () => {
    photoError.hidden = true;
    try {
      if (await api.pickProfilePhoto()) {
        flash.hidden = false;
        setTimeout(() => (flash.hidden = true), 2500);
      }
    } catch (err) {
      photoError.textContent = cleanError(err);
      photoError.hidden = false;
    }
  };

  // Header card: 64px avatar (click to change), name, "Account Settings".
  const bigName = h('h1', {});
  const header = h(
    'div',
    { class: 'profile-head' },
    h('button', { class: 'profile-photo', type: 'button', 'aria-label': 'Change profile photo', onClick: pickPhoto }, avatar(64), h('span', { class: 'profile-photo-hover' }, icon('camera'))),
    bigName,
    h('p', {}, 'Account Settings'),
    flash,
    photoError,
  );

  // Personal information: Name (edits inline, first and last name), Profile photo.
  const nameValue = h('span', { class: 'acct-value' });
  const first = h('input', { type: 'text', autocomplete: 'given-name', spellcheck: 'false' });
  const last = h('input', { type: 'text', autocomplete: 'family-name', spellcheck: 'false' });
  const nameForm = h(
    'form',
    { class: 'name-form', hidden: true },
    h('div', { class: 'name-fields' }, h('label', {}, 'First name', first), h('label', {}, 'Last name', last)),
    h(
      'div',
      { class: 'name-actions' },
      h('button', { class: 'mini-btn ghost', type: 'button', onClick: () => (nameForm.hidden = true) }, 'Cancel'),
      h('button', { class: 'mini-btn', type: 'submit' }, 'Save'),
    ),
  );
  nameForm.addEventListener('submit', (event) => {
    event.preventDefault();
    api.patchState({ profileName: `${first.value} ${last.value}`.trim() });
    nameForm.hidden = true;
  });
  const openName = () => {
    const [f = '', ...rest] = profileName(state) === 'Your profile' ? [] : profileName(state).split(' ');
    first.value = f;
    last.value = rest.join(' ');
    nameForm.hidden = !nameForm.hidden;
    if (!nameForm.hidden) first.focus();
  };
  const removePhoto = h('button', { class: 'mini-btn ghost', type: 'button', onClick: () => api.removeProfilePhoto() }, 'Remove');
  const uploadPhoto = h('button', { class: 'mini-btn', type: 'button', onClick: pickPhoto });

  const personal = h(
    'section',
    { class: 'acct-section' },
    h('h3', {}, 'Personal information'),
    h(
      'div',
      { class: 'acct-list' },
      h('div', {}, h('button', { class: 'acct-row acct-row-btn', type: 'button', onClick: openName }, icon('user'), h('span', { class: 'acct-label' }, 'Name'), nameValue, icon('chevron-right')), nameForm),
      h('div', { class: 'acct-row' }, icon('camera'), h('span', { class: 'acct-label' }, 'Profile photo'), avatar(28), h('span', { class: 'acct-actions' }, removePhoto, uploadPhoto)),
    ),
  );

  // Connected accounts: both subscriptions and both API keys, and which one answers.
  const pill = (text, tone = '') => h('span', { class: `acct-pill ${tone}` }, text);
  const accountRows = Object.entries(ACCOUNT_ROWS).map(([id, info]) => {
    const value = h('span', { class: 'acct-value' });
    const end = h('span', { class: 'acct-actions' });
    const note = h('p', { class: 'acct-note', hidden: true });
    const el = h('div', {}, h('div', { class: 'acct-row' }, icon(info.logo), h('span', { class: 'acct-label' }, info.name), value, end), note);
    const signIn = async () => {
      try {
        await api.signInProvider(id);
        note.textContent = `Finish signing in to ${info.cli} in the Terminal window and your browser. This updates on its own.`;
      } catch (err) {
        note.textContent = cleanError(err);
      }
      note.hidden = false;
    };
    const connect = async () => {
      try {
        await api.connectProvider(id);
      } catch (err) {
        note.textContent = cleanError(err);
        note.hidden = false;
      }
    };
    const paint = (s) => {
      const auth = s.auth[id] || {};
      if (auth.signedIn || auth.disconnected) note.hidden = true;
      const who = [auth.email || `${info.name} account`, auth.plan && auth.plan[0].toUpperCase() + auth.plan.slice(1)].filter(Boolean).join(' · ');
      value.textContent = auth.checking
        ? ''
        : auth.signedIn
          ? who
          : auth.disconnected
            ? `${who} · not used by Waffle`
            : auth.installed
              ? `${info.cli} is signed out`
              : `${info.cli} isn’t installed`;
      end.replaceChildren(
        ...(auth.checking
          ? [pill('Checking…')]
          : auth.signedIn
            ? [s.provider === id && pill('In use', 'live'), pill('Connected')].filter(Boolean)
            : auth.disconnected
              ? [pill('Disconnected'), h('button', { class: 'mini-btn', type: 'button', onClick: connect }, 'Connect')]
              : auth.installed
              ? [h('button', { class: 'mini-btn', type: 'button', onClick: signIn }, 'Sign in')]
                : [pill('Not installed', 'warn')]),
      );
    };
    return { el, paint };
  });

  const keyRows = [
    { kind: 'api', name: 'Anthropic API', has: (s) => s.hasKey, save: api.setApiKey, clear: api.clearApiKey, prefix: /^sk-ant-/, hint: 'sk-ant-…' },
    { kind: 'openai', name: 'OpenAI API', has: (s) => s.hasSpeechKey, save: api.setSpeechKey, clear: api.clearSpeechKey, prefix: /^sk-(?!ant-)/, hint: 'sk-…', extra: 'Also used for transcription when on-device speech isn’t available.' },
  ].map((k) => {
    const value = h('span', { class: 'acct-value' });
    const end = h('span', { class: 'acct-actions' });
    const input = h('input', { type: 'password', class: 'acct-key-input', placeholder: `Paste your ${k.name} key (${k.hint})`, spellcheck: 'false', autocomplete: 'off' });
    const err = h('p', { class: 'acct-note error', hidden: true });
    const form = h('form', { class: 'acct-key-form', hidden: true }, h('div', { class: 'acct-key-line' }, input, h('button', { class: 'mini-btn', type: 'submit' }, 'Save')), err, k.extra && h('p', { class: 'acct-note' }, k.extra));
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const key = input.value.trim();
      if (!key) return;
      if (!k.prefix.test(key)) {
        err.textContent = `That doesn’t look like an ${k.name} key (${k.hint}).`;
        err.hidden = false;
        return;
      }
      try {
        await k.save(key);
        input.value = '';
        form.hidden = true;
      } catch (e) {
        err.textContent = cleanError(e);
        err.hidden = false;
      }
    });
    const el = h('div', {}, h('div', { class: 'acct-row' }, icon('key-round'), h('span', { class: 'acct-label' }, k.name), value, end), form);
    const paint = (s) => {
      const has = k.has(s);
      value.textContent = has ? 'Key saved in your keychain' : 'Pay per use with your own key';
      end.replaceChildren(
        ...(has
          ? [s.provider === k.kind && pill('In use', 'live'), pill('Connected')].filter(Boolean)
          : [h('button', { class: 'mini-btn', type: 'button', onClick: () => ((form.hidden = !form.hidden), form.hidden || input.focus()) }, 'Add key')]),
      );
    };
    const open = () => {
      form.hidden = false;
      input.focus();
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    };
    return { el, paint, k, open };
  });

  // "Manage connected accounts" opens the actions Cluely keeps in its dialog.
  const manage = h('div', { class: 'acct-manage', hidden: true });
  const manageBtn = h('button', { class: 'acct-manage-btn', type: 'button', onClick: () => (manage.hidden = !manage.hidden) }, 'Manage connected accounts', icon('chevron-right'));
  const action = (label, iconName, onClick) => h('button', { class: 'acct-manage-item', type: 'button', onClick }, icon(iconName), label);
  function paintManage(s) {
    manageBtn.classList.toggle('open', !manage.hidden);
    manage.replaceChildren(
      action('Refresh account status', 'refresh-cw', () => api.refreshProviders()),
      ...Object.entries(ACCOUNT_ROWS)
        .filter(([id]) => s.auth[id]?.signedIn)
        .map(([id, info]) => action(`Disconnect ${info.name}`, 'log-out', () => api.disconnectProvider(id))),
      ...keyRows.filter((r) => r.k.has(s)).map((r) => action(`Remove ${r.k.name} key`, 'trash-2', () => r.k.clear())),
      h('p', { class: 'acct-note' }, 'Subscriptions run through the official Claude Code and Codex apps, signed in with your own account. Waffle never sees your password or tokens; API keys are encrypted with your Mac’s keychain.'),
    );
  }
  manageBtn.addEventListener('click', () => paintManage(state));

  // Usage: each subscription's limits as reported by Claude Code and Codex (usage.js in main).
  api.refreshUsage();
  const usageList = h('div', { class: 'acct-list' });
  const pct = (n) => `${n}% used`;
  const clock = (ms) => {
    const d = new Date(ms);
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return d - Date.now() < 20 * 3600 * 1000 && d.getDate() === new Date().getDate() ? time : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
  };
  const ago = (ms) => {
    const minutes = Math.round((Date.now() - ms) / 60000);
    if (minutes < 1) return 'Updated just now';
    if (minutes < 60) return `Updated ${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    return hours < 48 ? `Updated ${hours} h ago` : `Updated ${new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
  };
  function usageBlock(id, info, snap, signedIn, disconnected) {
    const head = h('div', { class: 'acct-row usage-head' }, icon(info.logo), h('span', { class: 'acct-label' }, info.name), h('span', { class: 'acct-value' }, snap ? ago(snap.at) : ''));
    if (!snap) {
      return h('div', {}, head, h('p', { class: 'acct-note' }, signedIn ? `Shows up after ${id === 'claude' ? 'Claude' : 'Codex'} answers a question in Waffle.` : disconnected ? `Connect ${info.name} to see its limits.` : `Sign in to ${info.cli} to see its limits.`));
    }
    const windows = snap.windows.map((w) => {
      const passed = w.resetsAt && w.resetsAt < Date.now();
      const level = passed || w.percent == null ? 0 : w.percent;
      const fill = h('span', { class: `usage-fill ${w.limited ? 'full' : level >= 80 ? 'high' : ''}` });
      fill.style.width = `${level}%`;
      return h(
        'div',
        { class: `usage-window ${passed ? 'stale' : ''}` },
        h('div', { class: 'usage-line' }, h('span', {}, w.label), h('span', { class: 'usage-pct' }, w.limited ? 'Limit reached' : passed ? 'Reset' : w.percent == null ? '' : pct(w.percent))),
        h('span', { class: 'usage-bar' }, fill),
        h('span', { class: 'usage-reset' }, passed ? 'Reset since this was reported. Refreshes on your next answer.' : w.resetsAt ? `Resets ${clock(w.resetsAt)}` : ''),
      );
    });
    return h('div', {}, head, h('div', { class: 'usage-windows' }, windows));
  }
  function paintUsage(s) {
    const blocks = Object.entries(ACCOUNT_ROWS)
      .filter(([id]) => s.usage?.[id] || s.auth[id]?.signedIn)
      .map(([id, info]) => usageBlock(id, info, s.usage?.[id], Boolean(s.auth[id]?.signedIn), Boolean(s.auth[id]?.disconnected)));
    usageList.replaceChildren(
      ...(blocks.length ? blocks : [h('p', { class: 'acct-note usage-empty' }, 'Connect a Claude or ChatGPT subscription to see how much of its limits you have used.')]),
      h(
        'p',
        { class: 'acct-note usage-foot' },
        'API keys are pay per use; see spend in the ',
        h('a', { href: 'https://console.anthropic.com/usage', target: '_blank' }, 'Anthropic Console'),
        ' or the ',
        h('a', { href: 'https://platform.openai.com/usage', target: '_blank' }, 'OpenAI dashboard'),
        '.',
      ),
    );
  }

  // Transcription: Apple's on-device engine, or OpenAI's speech API with a chosen model.
  const appleValue = h('span', { class: 'acct-value' });
  const appleEnd = h('span', { class: 'acct-actions' });
  const openaiValue = h('span', { class: 'acct-value' });
  const openaiEnd = h('span', { class: 'acct-actions' });
  const speechModel = h(
    'select',
    { onChange: () => api.patchState({ speechModel: speechModel.value }) },
    h('option', { value: 'gpt-4o-mini-transcribe' }, 'GPT-4o mini Transcribe'),
    h('option', { value: 'gpt-4o-transcribe' }, 'GPT-4o Transcribe'),
    h('option', { value: 'whisper-1' }, 'Whisper'),
  );
  const transcription = h(
    'div',
    { class: 'acct-list' },
    h('div', { class: 'acct-row' }, icon('audio-waveform'), h('span', { class: 'acct-label' }, 'On this Mac'), appleValue, appleEnd),
    h('div', { class: 'acct-row' }, icon('audio-lines'), h('span', { class: 'acct-label' }, 'OpenAI'), openaiValue, openaiEnd),
    h('div', { class: 'acct-row' }, icon('sparkles'), h('span', { class: 'acct-label' }, 'OpenAI model'), h('span', { class: 'acct-value' }), themedSelect(speechModel)),
    h('p', { class: 'acct-note transcribe-note' }, 'If on-device speech fails while listening, Waffle switches to OpenAI when a key is saved.'),
  );
  function paintTranscription(s) {
    const apple = s.appleSpeech || {};
    const ready = apple.status === 'ready';
    const useApple = s.speechEngine === 'apple' && ready;
    appleValue.textContent = ready ? "Apple's speech engine · free and private" : apple.status === 'checking' ? 'Checking…' : apple.detail || 'Unavailable';
    appleEnd.replaceChildren(
      useApple ? pill('In use', 'live') : ready ? h('button', { class: 'mini-btn', type: 'button', onClick: () => api.patchState({ speechEngine: 'apple' }) }, 'Use') : pill(apple.status === 'checking' ? 'Checking…' : 'Unavailable', apple.status === 'checking' ? '' : 'warn'),
    );
    const useOpenAI = s.hasSpeechKey && !useApple;
    openaiValue.textContent = s.hasSpeechKey ? 'Uses your OpenAI key · billed per use' : 'Needs an OpenAI API key';
    openaiEnd.replaceChildren(
      useOpenAI ? pill('In use', 'live') : s.hasSpeechKey ? h('button', { class: 'mini-btn', type: 'button', onClick: () => api.patchState({ speechEngine: 'api' }) }, 'Use') : h('button', { class: 'mini-btn', type: 'button', onClick: () => keyRows[1].open() }, 'Add key'),
    );
    speechModel.value = s.speechModel || 'whisper-1';
  }

  subscribe((s) => {
    paintUsage(s);
    paintTranscription(s);
    bigName.textContent = profileName(s);
    nameValue.textContent = s.profileName || s.systemName || 'Add your name';
    removePhoto.hidden = !s.profilePhotoRev;
    uploadPhoto.textContent = s.profilePhotoRev ? 'Change' : 'Upload';
    syncProfilePhoto(s);
    for (const r of [...accountRows, ...keyRows]) r.paint(s);
    paintManage(s);
  });

  return [
    header,
    personal,
    h(
      'section',
      { class: 'acct-section' },
      h('h3', {}, 'Connected accounts'),
      h('div', { class: 'acct-list' }, accountRows.map((r) => r.el), keyRows.map((r) => r.el), h('div', {}, manageBtn, manage)),
    ),
    h('section', { class: 'acct-section' }, h('h3', {}, 'Usage'), usageList),
    h('section', { class: 'acct-section' }, h('h3', {}, 'Transcription'), transcription),
  ];
}

function shortcutsPane() {
  let recording = null; // action currently being rebound
  const cells = {}; // action -> { keys, reset }
  const note = h('p', { class: 'shortcut-note' });
  const MOD_ORDER = ['Control', 'Alt', 'Shift', 'CommandOrControl', 'Command']; // the macOS order: ⌃⌥⇧⌘

  /** One cap per key, modifiers in the usual macOS order. */
  function keycaps(accelerator) {
    if (!accelerator) return [h('span', { class: 'shortcut-none' }, 'Not set')];
    const parts = accelerator.split('+').filter(Boolean);
    const mods = parts.filter((p) => MOD_ORDER.includes(p)).sort((a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b));
    const keys = parts.filter((p) => !MOD_ORDER.includes(p));
    return [...mods, ...keys].map((part) => h('kbd', { class: 'cap' }, formatAccelerator(part)));
  }

  function stopRecording() {
    recording = null;
    window.removeEventListener('keydown', onKey, true);
    api.patchState({ isRecordingShortcut: false });
    paint(state);
  }

  function setShortcut(action, accelerator) {
    api.patchState({ shortcuts: { ...state.shortcuts, [action]: accelerator } });
  }

  function onKey(event) {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') return stopRecording();
    if (event.key === 'Backspace' || event.key === 'Delete') {
      setShortcut(recording, '');
      return stopRecording();
    }
    const accelerator = acceleratorFromEvent(event);
    if (!accelerator) return; // still holding modifiers
    const clash = Object.entries(state.shortcuts).find(([a, v]) => a !== recording && v === accelerator);
    if (clash) {
      note.textContent = `${formatAccelerator(accelerator)} is already used by “${SHORTCUT_LABELS[clash[0]][0]}”.`;
      note.classList.add('error');
      return;
    }
    setShortcut(recording, accelerator);
    stopRecording();
  }

  function startRecording(action) {
    if (recording) stopRecording();
    recording = action;
    // Global shortcuts are released while recording so the keys reach this window.
    api.patchState({ isRecordingShortcut: true });
    window.addEventListener('keydown', onKey, true);
    paint(state);
  }

  function paint(s) {
    for (const [action, { keys, reset }] of Object.entries(cells)) {
      const current = s.shortcuts[action] || '';
      keys.classList.toggle('recording', recording === action);
      keys.replaceChildren(...(recording === action ? [h('span', { class: 'shortcut-press' }, 'Press keys…')] : keycaps(current)));
      reset.disabled = current === (s.defaultShortcuts?.[action] || '');
    }
    if (!recording) {
      note.classList.toggle('error', s.shortcutErrors.length > 0);
      note.textContent = s.shortcutErrors.length
        ? `Could not register: ${s.shortcutErrors.map((a) => SHORTCUT_LABELS[a][0]).join(', ')}. Another app may own those keys.`
        : 'Click a hotkey to change it. Press Esc to cancel or Delete to clear. Use the reset arrow to restore its default.';
    }
  }

  const rows = Object.entries(SHORTCUT_LABELS).map(([action, [title, iconName]]) => {
    const keys = h('button', { class: 'shortcut-keys', 'aria-label': `Change the ${title} shortcut`, onClick: () => startRecording(action) });
    const reset = h(
      'button',
      {
        class: 'shortcut-reset',
        'aria-label': `Restore the default ${title} shortcut`,
        onClick: () => setShortcut(action, state.defaultShortcuts[action]),
      },
      icon('rotate-ccw'),
    );
    cells[action] = { keys, reset };
    return h(
      'tr',
      {},
      h('td', { class: 'shortcut-name' }, h('span', {}, icon(iconName), h('b', {}, title))),
      h('td', { class: 'shortcut-hotkey' }, h('div', {}, keys, reset)),
    );
  });
  subscribe(paint);

  return [
    h(
      'table',
      { class: 'shortcut-table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', { class: 'shortcut-hotkey-head' }, 'Hotkey'))),
      h('tbody', {}, rows),
    ),
    note,
  ];
}

const invokeError = (err) => err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/** A masked field for an API key: whatever is pasted shows as dots and is never echoed back. */
function secretInput(placeholder) {
  return h('input', { type: 'password', placeholder, autocomplete: 'off', spellcheck: 'false', 'aria-label': placeholder });
}

/** Save a key as soon as it is pasted (or on Enter), so there is no separate Save step. */
function saveOnPaste(input, save) {
  input.addEventListener('paste', () => setTimeout(save)); // after the pasted text lands in the field
  input.addEventListener('keydown', (event) => event.key === 'Enter' && save());
}

function audioPane() {
  const keyInput = secretInput('Paste your OpenAI API key');
  const keyNote = h('p', { class: 'note' });
  const removeKey = h('button', { class: 'btn', onClick: () => api.clearSpeechKey() }, 'Remove');
  const listenBtn = h('button', { class: 'btn', onClick: () => api.toggleListen() });
  const notice = h('p', { class: 'note' });
  const micBadge = h('span', { class: 'badge' });
  const engine = h(
    'select',
    { onChange: () => api.patchState({ speechEngine: engine.value }) },
    h('option', { value: 'apple' }, 'On this Mac'),
    h('option', { value: 'api' }, 'Speech API'),
  );
  const appleBadge = h('span', { class: 'badge' });
  const appleNote = h('p', { class: 'note' });
  const recheck = h('button', { class: 'btn', onClick: () => api.checkAppleSpeech() }, 'Check again');

  async function saveKey() {
    if (!keyInput.value.trim()) return;
    try {
      await api.setSpeechKey(keyInput.value.trim());
      keyInput.value = '';
    } catch (err) {
      keyNote.textContent = invokeError(err);
      keyNote.classList.add('error');
    }
  }
  saveOnPaste(keyInput, saveKey);

  subscribe((s) => {
    keyNote.classList.remove('error');
    const onDevice = s.speechEngine === 'apple';
    keyInput.placeholder = s.hasSpeechKey ? 'Key saved. Paste a new one to replace it' : 'Paste your OpenAI API key';
    keyNote.textContent = s.hasSpeechKey
      ? "Saved, encrypted with your OS keychain. Audio is sent to OpenAI's transcription API with this key, which also answers questions when OpenAI API key is chosen under Answer with."
      : onDevice
        ? "Optional. Used only if Apple's speech engine fails. Stored encrypted with your OS keychain, and sent only to OpenAI."
        : "Needed for listening. Audio is transcribed by OpenAI. Stored encrypted with your OS keychain.";
    if (document.activeElement !== engine) engine.value = s.speechEngine;
    const apple = s.appleSpeech;
    appleBadge.textContent = { checking: 'Checking…', ready: 'Ready', error: 'Problem', unavailable: 'Unavailable' }[apple.status] || 'Unknown';
    appleBadge.className = `badge ${apple.status === 'ready' ? 'ok' : apple.status === 'checking' ? '' : 'bad'}`;
    appleNote.textContent = apple.detail;
    appleNote.classList.toggle('error', Boolean(apple.detail));
    recheck.hidden = apple.status === 'checking' || apple.status === 'ready';
    removeKey.hidden = !s.hasSpeechKey;
    listenBtn.textContent = s.isListening ? 'Stop listening' : 'Start listening';
    listenBtn.classList.toggle('on', s.isListening);
    notice.textContent =
      s.audioNotice ||
      (s.isListening
        ? onDevice && apple.status !== 'unavailable'
          ? 'Recording. Transcribing live on this Mac.'
          : 'Recording. Audio is sent to the speech API in short phrases as people speak.'
        : '');
    notice.classList.toggle('error', Boolean(s.audioNotice));
    const mic = s.permissions.microphone;
    micBadge.textContent = { granted: 'Granted', denied: 'Denied', restricted: 'Restricted', 'not-determined': 'Not asked yet' }[mic] || 'Unknown';
    micBadge.className = `badge ${mic === 'granted' ? 'ok' : mic === 'denied' || mic === 'restricted' ? 'bad' : ''}`;
  });
  api.checkPermissions();

  const noticeRow = h('div', { class: 'row' }, h('div', { class: 'label' }, notice));
  const appleNoteRow = h('div', { class: 'row' }, h('div', { class: 'label' }, appleNote), h('div', { class: 'row-controls' }, recheck));
  subscribe(() => {
    noticeRow.hidden = !notice.textContent;
    appleNoteRow.hidden = !appleNote.textContent && recheck.hidden;
  });
  return [
    section(
      'Listening',
      row('Listening', 'Only record people who know they are being recorded.', listenBtn, 'audio-lines'),
      noticeRow,
      row('Microphone access', 'System audio access is requested by macOS the first time you listen.', micBadge, 'mic'),
    ),
    section(
      'Transcription',
      row('Engine', "On this Mac uses Apple's speech engine (macOS 26+): private, free, no key. The speech API below is the fallback.", engine, 'audio-waveform'),
      row("Apple's speech engine", 'Runs on device. macOS downloads the language model the first time.', appleBadge, 'shield-check'),
      appleNoteRow,
    ),
    section(
      'Speech API',
      row('OpenAI API key', '', keyInput, 'key-round'),
      h('div', { class: 'row' }, h('div', { class: 'label' }, keyNote), h('div', { class: 'row-controls' }, removeKey)),
    ),
  ];
}

function permissionsPane() {
  const STATUS = { granted: 'Granted', denied: 'Denied', restricted: 'Restricted', 'not-determined': 'Not asked yet' };
  const paintBadge = (badge, status) => {
    badge.textContent = STATUS[status] || 'Unknown';
    badge.className = `badge ${status === 'granted' ? 'ok' : status === 'denied' || status === 'restricted' ? 'bad' : ''}`;
  };
  const badge = h('span', { class: 'badge' });
  const micBadge = h('span', { class: 'badge' });
  const speechBadge = h('span', { class: 'badge' });
  const askMic = h('button', { class: 'btn', onClick: () => api.askForMicrophone() }, 'Request access');
  subscribe((s) => {
    paintBadge(badge, s.permissions.screen);
    const mic = s.permissions.microphone;
    paintBadge(micBadge, mic);
    askMic.hidden = mic !== 'not-determined'; // macOS only asks once; after that it's System Settings
    const apple = s.appleSpeech || {};
    speechBadge.textContent = { checking: 'Checking…', ready: 'Ready', error: 'Problem', unavailable: 'Unavailable' }[apple.status] || 'Unknown';
    speechBadge.className = `badge ${apple.status === 'ready' ? 'ok' : apple.status === 'checking' ? '' : 'bad'}`;
  });
  api.checkPermissions();
  window.addEventListener('focus', () => api.checkPermissions());

  return [
    section(
      'Screen',
      row('Screen Recording', 'Used only when you ask a question with a screenshot attached.', badge, 'monitor'),
      row(
        '',
        'After granting access in System Settings, relaunch Waffle.',
        h(
          'div',
          { class: 'row-controls' },
          h('button', { class: 'btn', onClick: () => api.askForScreenAccess() }, 'Request access'),
          isMac && h('button', { class: 'btn', onClick: () => api.openSystemSettings('screen') }, 'Open System Settings'),
          h('button', { class: 'btn', onClick: () => api.relaunch() }, 'Relaunch'),
        ),
      ),
    ),
    section(
      'Audio',
      row('Microphone', 'Used while listening, to transcribe what you say.', h('div', { class: 'row-controls' }, askMic, micBadge), 'mic'),
      row(
        'System audio',
        'Your speakers, while listening. macOS asks the first time and lists it under Screen & System Audio Recording; apps can’t read its status.',
        h('button', { class: 'btn', onClick: () => api.openSystemSettings('screen') }, 'Open settings'),
        'audio-lines',
      ),
      row("Apple's speech engine", 'Transcribes on this Mac. macOS may ask for Speech Recognition the first time.', speechBadge, 'shield-check'),
      row(
        '',
        'Changed a permission in System Settings? Relaunch Waffle for it to apply.',
        h(
          'div',
          { class: 'row-controls' },
          isMac && h('button', { class: 'btn', onClick: () => api.openSystemSettings('microphone') }, 'Microphone settings'),
          h('button', { class: 'btn', onClick: () => api.relaunch() }, 'Relaunch'),
        ),
      ),
    ),
  ];
}

/**
 * Modes: a list on the left (New Mode, General, then grouped modes) and the selected mode on the
 * right, with its context (your own notes, editable) and reference files. Each mode's rules are a
 * hidden prompt added in the main process. Selecting a mode only previews it; "Use this mode"
 * makes it the active one.
 */
function modesPane() {
  let selected = state.mode;
  let shownId = null; // the mode the detail column was last built for
  let saveTimer = null;
  let fileErrors = [];

  const list = h('div', { class: 'mode-list', role: 'listbox', 'aria-label': 'Modes' });
  const detail = h('div', { class: 'mode-detail' });
  const footer = h('div', { class: 'mode-footer' });
  const column = h('div', { class: 'mode-column' }, detail, footer);

  const modeById = (id) => state.modes.find((m) => m.id === id) || state.modes[0];
  const formatSize = (bytes) =>
    bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

  async function newMode() {
    const id = await api.createMode('New mode');
    select(id);
    requestAnimationFrame(() => {
      const name = detail.querySelector('.mode-name');
      if (name) {
        name.focus();
        name.select();
      }
    });
  }

  function select(id) {
    flushSave();
    selected = id;
    paint(state);
  }

  // ---- list ----

  function renderList(s) {
    const groups = new Map();
    for (const mode of s.modes) {
      const group = mode.group || '';
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(mode);
    }
    // General first, then your own modes, then the built-in groups in their usual order.
    const order = ['', 'Your modes', ...[...groups.keys()].filter((g) => g && g !== 'Your modes')];
    const children = [h('button', { class: 'mode-new', onClick: newMode }, icon('plus'), 'New Mode')];
    for (const group of order) {
      const modes = groups.get(group);
      if (!modes) continue;
      if (group && group !== 'More') children.push(h('div', { class: 'mode-group' }, h('span', {}, group), h('span', { class: 'mode-group-line' })));
      for (const mode of modes) {
        children.push(
          h(
            'button',
            {
              class: 'mode-item',
              role: 'option',
              'aria-selected': String(mode.id === selected),
              title: mode.label,
              onClick: () => select(mode.id),
            },
            h('span', { class: 'mode-ico' }, icon(mode.icon)),
            h('span', { class: 'mode-label' }, mode.label),
            mode.id === s.mode && h('span', { class: 'mode-active', 'aria-label': 'Active' }, icon('check')),
          ),
        );
      }
    }
    list.replaceChildren(...children);
  }

  // ---- detail ----

  function save(changes) {
    api.updateMode(selected, changes).catch((err) => console.warn('Could not save mode:', err.message));
  }

  function queueSave(changes) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      save(changes());
    }, 500);
    saveTimer.changes = changes;
  }

  function flushSave() {
    if (!saveTimer) return;
    const { changes } = saveTimer;
    clearTimeout(saveTimer);
    saveTimer = null;
    save(changes());
  }

  function buildDetail(mode) {
    shownId = mode.id;
    fileErrors = [];
    const fileList = h('div', { class: 'file-list' });
    const errors = h('div', { class: 'file-errors' });

    // General is Waffle's default behaviour: nothing to edit, so it only explains itself.
    if (!mode.editable) {
      detail.replaceChildren(
        h('div', { class: 'mode-head' }, h('h2', { class: 'mode-title' }, mode.label)),
        h('p', { class: 'mode-desc' }, mode.description),
        h('section', { class: 'mode-block' }, h('b', { class: 'mode-block-title' }, 'Instructions'), h('p', { class: 'mode-text' }, "Waffle's default behaviour, with no custom context.")),
        h(
          'section',
          { class: 'mode-block' },
          h('b', { class: 'mode-block-title' }, 'Reference files'),
          fileList,
          mode.files.length ? null : h('p', { class: 'mode-text' }, 'No files attached. Create a mode to add your own documents and context.'),
        ),
        h('p', { class: 'mode-tip' }, 'For a specific task, choose a template on the left or start with New Mode.'),
      );
      detail.scrollTop = 0;
      detail.refs = { fileList, errors };
      return;
    }

    const title = mode.builtin
      ? h('h2', { class: 'mode-title' }, mode.label)
      : h('input', { class: 'mode-name mode-title', type: 'text', maxlength: '60', spellcheck: 'false', 'aria-label': 'Mode name', value: mode.label });
    if (!mode.builtin) {
      title.addEventListener('input', () => queueSave(() => ({ label: title.value })));
      title.addEventListener('blur', flushSave);
      title.addEventListener('keydown', (e) => e.key === 'Enter' && title.blur());
    }

    const menu = h('div', { class: 'mode-menu', hidden: true, role: 'menu' });
    const menuBtn = h('button', { class: 'mode-more', 'aria-label': 'More', 'aria-haspopup': 'menu', onClick: toggleMenu }, icon('ellipsis'));
    function toggleMenu(event) {
      event.stopPropagation();
      menu.hidden = !menu.hidden;
      if (!menu.hidden) {
        const current = modeById(selected);
        menu.replaceChildren(
          current.builtin
            ? h('button', { class: 'menu-item', role: 'menuitem', disabled: !current.edited, onClick: resetMode }, 'Reset to default')
            : h('button', { class: 'menu-item danger', role: 'menuitem', onClick: deleteMode }, 'Delete mode'),
        );
        setTimeout(() => document.addEventListener('click', () => (menu.hidden = true), { once: true }));
      }
    }
    async function resetMode() {
      menu.hidden = true;
      clearTimeout(saveTimer);
      saveTimer = null;
      await api.resetMode(selected);
      textarea.value = modeById(selected).context;
    }
    let deleteArmed = false;
    async function deleteMode(event) {
      event.stopPropagation();
      if (!deleteArmed) {
        deleteArmed = true;
        event.currentTarget.textContent = 'Click again to delete';
        return;
      }
      menu.hidden = true;
      clearTimeout(saveTimer);
      saveTimer = null;
      await api.deleteMode(selected);
      selected = state.mode;
      paint(state);
    }

    const textarea = h('textarea', {
      class: 'mode-prompt',
      spellcheck: 'true',
      'aria-label': 'Meeting context',
      placeholder:
        'Describe the situation in your own words: who you are talking to, what you want out of it, and how Waffle should help. For example: "I\'m presenting our roadmap to engineers. Keep answers technical and suggest sharp questions."',
    });
    textarea.value = mode.context;
    textarea.addEventListener('input', () => queueSave(() => ({ context: textarea.value })));
    textarea.addEventListener('blur', flushSave);

    const drop = h(
      'button',
      { class: 'file-drop', onClick: () => addFiles(api.pickModeFiles(selected)) },
      icon('paperclip'),
      h('span', {}, h('b', {}, 'Add reference files'), h('small', {}, 'Drop a file here or click to browse.')),
    );
    drop.addEventListener('dragover', (e) => {
      e.preventDefault();
      drop.classList.add('over');
    });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('over');
      addFiles(api.addModeFiles(selected, e.dataTransfer.files));
    });
    async function addFiles(pending) {
      try {
        const result = await pending;
        fileErrors = result.errors || [];
      } catch (err) {
        fileErrors = [cleanError(err)];
      }
      paintFiles(modeById(selected));
    }

    detail.replaceChildren(
      h('div', { class: 'mode-head' }, title, h('div', { class: 'mode-more-wrap' }, menuBtn, menu)),
      h('p', { class: 'mode-desc' }, 'These notes and files guide Waffle while this mode is active. Your changes save automatically.'),
      h('section', { class: 'mode-field' }, h('b', { class: 'mode-block-title' }, 'Meeting context'), textarea),
      h(
        'section',
        { class: 'mode-field' },
        h('b', { class: 'mode-block-title' }, 'Files'),
        h('p', { class: 'mode-hint' }, state.modeFileTypes),
        fileList,
        drop,
        errors,
      ),
    );
    detail.scrollTop = 0;
    detail.refs = { title, textarea, fileList, errors };
  }

  function paintFiles(mode) {
    const { fileList, errors } = detail.refs;
    fileList.replaceChildren(
      ...mode.files.map((file) =>
        h(
          'div',
          { class: 'file-row' },
          h('span', { class: 'mode-ico' }, icon('file-text')),
          h(
            'span',
            { class: 'file-meta' },
            h('b', {}, file.name),
            h(
              'small',
              {},
              file.kind === 'pdf'
                ? `PDF · ${formatSize(file.size)} · sent as a document`
                : `${formatSize(file.size)} · ${file.chars.toLocaleString()} characters of text${file.truncated ? ' (cut to fit)' : ''}`,
            ),
          ),
          h('button', { class: 'file-remove', 'aria-label': `Remove ${file.name}`, onClick: () => api.removeModeFile(mode.id, file.id) }, icon('x')),
        ),
      ),
    );
    errors.replaceChildren(...fileErrors.map((message) => h('p', {}, message)));
  }

  function paintFooter(s, mode) {
    const active = mode.id === s.mode;
    footer.replaceChildren(
      h(
        'div',
        { class: 'mode-footer-text' },
        h('b', {}, `${active ? 'Using' : 'Previewing'} ${mode.label}`),
        h('small', {}, active ? "This mode guides Waffle's responses." : 'Activate to use it in your conversations.'),
      ),
      active
        ? h('span', { class: 'mode-on' }, icon('check'), 'Active')
        : h('button', { class: 'btn primary', onClick: () => (flushSave(), api.patchState({ mode: mode.id })) }, icon('check'), 'Use this mode'),
    );
  }

  function paint(s) {
    if (!s.modes.some((m) => m.id === selected)) selected = s.mode;
    const mode = modeById(selected);
    renderList(s);
    if (shownId !== mode.id) buildDetail(mode);
    const { title, textarea } = detail.refs;
    // Never overwrite what you are typing.
    if (textarea && document.activeElement !== textarea && !saveTimer && textarea.value !== mode.context) textarea.value = mode.context;
    if (title && title.tagName === 'INPUT' && document.activeElement !== title && !saveTimer) title.value = mode.label;
    paintFiles(mode);
    paintFooter(s, mode);
  }

  subscribe(paint);

  return [h('div', { class: 'modes-split' }, list, column)];
}

function historySettingsPane() {
  const note = h('p', { class: 'note' });
  const clearBtn = h('button', { class: 'btn danger' }, 'Clear history');
  let armed = false;
  clearBtn.addEventListener('click', async () => {
    // Deleting is permanent, so the first click only asks.
    if (!armed) {
      armed = true;
      clearBtn.textContent = 'Click again to delete all';
      setTimeout(() => {
        armed = false;
        clearBtn.textContent = 'Clear history';
      }, 4000);
      return;
    }
    armed = false;
    await api.clearHistory();
    clearBtn.textContent = 'Clear history';
    note.textContent = 'History cleared.';
    loadList();
  });

  // Every saved conversation and session, newest first, each with a trash button that needs a
  // second click (within 3 seconds) to delete.
  const list = h('div', { class: 'group hist-list' });
  const count = h('span', { class: 'hist-count' });
  const when = (ms) => {
    const d = new Date(ms);
    const today = new Date();
    const yesterday = new Date(Date.now() - 86400000);
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (d.toDateString() === today.toDateString()) return `Today, ${time}`;
    if (d.toDateString() === yesterday.toDateString()) return `Yesterday, ${time}`;
    return `${d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' })}, ${time}`;
  };
  const detail = (item) => {
    if (item.kind === 'meeting') {
      const minutes = Math.round((item.durationMs || 0) / 60000);
      return `Listening session${minutes ? ` · ${minutes} min` : ''}`;
    }
    const n = item.turnCount || 0;
    return `${n} question${n === 1 ? '' : 's'}`;
  };

  function historyItem(item) {
    const trash = h('button', { class: 'hist-trash', type: 'button', 'aria-label': `Delete “${item.title}”`, title: 'Delete' }, icon('trash-2'), h('span', { class: 'hist-trash-label' }, 'Delete?'));
    const el = h(
      'div',
      { class: 'hist-item' },
      h('span', { class: 'hist-ico' }, icon(item.kind === 'meeting' ? 'audio-lines' : 'message-circle')),
      h('div', { class: 'hist-text' }, h('b', {}, item.title || 'Untitled'), h('small', {}, `${when(item.updatedAt || item.startedAt)} · ${detail(item)}`)),
      trash,
    );
    let timer = null;
    trash.addEventListener('click', async () => {
      if (!trash.classList.contains('armed')) {
        trash.classList.add('armed');
        trash.title = 'Click again to delete';
        timer = setTimeout(() => {
          trash.classList.remove('armed');
          trash.title = 'Delete';
        }, 3000);
        return;
      }
      clearTimeout(timer);
      el.classList.add('removing');
      await api.deleteHistory(item.id);
      setTimeout(() => {
        el.remove();
        if (!item.extra) offset -= 1; // the next page starts one earlier now
        total -= 1;
        paintCount();
        if (!list.querySelector('.hist-item') && !hasMore()) showEmpty();
      }, 160);
    });
    return el;
  }

  // Ten at a time: the next page loads when the end of the list scrolls into view.
  const PAGE = 10;
  let offset = 0; // saved conversations loaded so far (the database's own offset)
  let total = 0;
  let loading = false;
  let generation = 0; // bumps on reload so a late page from before Clear history is dropped
  const sentinel = h('div', { class: 'hist-more', 'aria-hidden': 'true' });
  const hasMore = () => list.querySelectorAll('.hist-item').length < total;
  const paintCount = () => (count.textContent = total ? String(total) : '');
  const showEmpty = () => list.replaceChildren(h('p', { class: 'hist-empty' }, 'No saved conversations yet.'));

  async function loadMore() {
    if (loading) return;
    loading = true;
    const mine = generation;
    try {
      const page = await api.historyPage(offset, PAGE);
      if (mine !== generation) return;
      const first = offset === 0;
      offset += page.loaded;
      total = page.total;
      if (first) list.replaceChildren();
      for (const item of page.items) list.append(historyItem({ ...item, extra: page.items.indexOf(item) < page.items.length - page.loaded }));
      paintCount();
      if (!list.querySelector('.hist-item')) showEmpty();
      sentinel.hidden = !hasMore();
    } finally {
      loading = false;
    }
    // A tall window can show the whole first page with room to spare; keep filling it.
    if (hasMore() && sentinel.getBoundingClientRect().top < window.innerHeight) loadMore();
  }

  function loadList() {
    generation += 1;
    offset = 0;
    loading = false;
    loadMore();
  }
  const observer = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && hasMore() && loadMore(), { rootMargin: '200px' });
  observer.observe(sentinel);
  // Backstop for the observer: near the bottom of the settings pane, load the next page.
  const onScroll = (event) => {
    if (!list.isConnected) {
      observer.disconnect();
      return document.removeEventListener('scroll', onScroll, true);
    }
    const pane = event.target;
    if (pane instanceof Element && pane.contains(list) && pane.scrollTop + pane.clientHeight > pane.scrollHeight - 240 && hasMore()) loadMore();
  };
  document.addEventListener('scroll', onScroll, true);
  loadList();

  return [
    section(
      'Saved chats',
      toggleRow('Save conversations', 'Turn off to stop saving new chats. Chats already saved stay until you clear them.', 'keepHistory', 'history'),
      row('Clear history', 'Permanently delete every saved conversation.', clearBtn, 'trash-2'),
    ),
    note,
    h(
      'section',
      { class: 'set-section' },
      h('h2', { class: 'group-title' }, 'Conversations ', count),
      list,
      sentinel,
    ),
  ];
}

function aboutPane() {
  return [
    section(
      'Overlay',
      row('Reset position', 'Move the overlay back to the top centre of the main display.', h('button', { class: 'btn', onClick: () => api.resetPosition() }, 'Reset'), 'rotate-ccw'),
      row('Quit', 'Waffle keeps running in the menu bar until you quit.', h('button', { class: 'btn danger', onClick: () => api.quit() }, 'Quit Waffle'), 'power-off'),
    ),
  ];
}

/** Settings pages: sidebar entry, coloured icon tile, header text and words the search matches. */
const SETTINGS_PAGES = {
  account: {
    label: 'Account Settings',
    icon: 'user',
    tone: 'grey',
    description: 'Your name and photo, and the AI accounts Waffle answers with.',
    terms: ['account', 'profile', 'name', 'photo', 'claude', 'chatgpt', 'codex', 'subscription', 'api key', 'sign in', 'sign out', 'connected'],
    pane: accountPane,
    profile: true, // opened from the profile card at the top of the sidebar, not a nav item
  },
  general: {
    label: 'General',
    icon: 'hero-cog-6-tooth',
    tone: 'grey',
    description: 'Choose the model Waffle answers with, and how it behaves on your Mac.',
    terms: ['model', 'effort', 'provider', 'undetectability', 'screen sharing', 'login', 'follow-ups', 'audio', 'listening', 'transcription'],
    pane: generalPane,
  },
  modes: {
    label: 'Modes',
    icon: 'sliders-horizontal',
    tone: 'purple',
    description: "Tailor Waffle's responses with instructions and reference files. Preview a mode below, then activate it when you're ready.",
    terms: ['interview', 'behavioral', 'system design', 'case', 'recruiter', 'recruiting', 'team meet', 'meeting', 'sales', 'lecture', 'coding', 'prompt', 'instructions', 'files'],
    pane: modesPane,
    split: true, // list and detail fill the window; the title sits in the top bar
  },
  history: {
    label: 'History',
    icon: 'history',
    tone: 'green',
    description: 'Past conversations, listed under History in the overlay. Only the text is saved, on this Mac.',
    terms: ['saved', 'chats', 'clear', 'delete'],
    pane: historySettingsPane,
  },
  shortcuts: {
    label: 'Keyboard Shortcuts',
    icon: 'keyboard',
    tone: 'graphite',
    description: 'Control Waffle from your keyboard. Select a shortcut to change its keys.',
    terms: ['keys', 'hotkeys'],
    pane: shortcutsPane,
    plain: true, // no header card; the title sits in the top bar
  },
  audio: {
    label: 'Audio',
    icon: 'mic',
    tone: 'red',
    description: 'Record your microphone and system audio, and add a transcript to each question.',
    terms: ['microphone', 'listen', 'transcription', 'speech', 'apple', 'on device', 'whisper'],
    pane: audioPane,
  },
  permissions: {
    label: 'Permissions',
    icon: 'shield-check',
    tone: 'slate',
    description: 'Waffle needs Screen Recording to see what you are looking at, and audio access to listen.',
    terms: ['screen recording', 'privacy', 'access', 'microphone', 'system audio', 'speech recognition'],
    pane: permissionsPane,
  },
  about: {
    label: 'About',
    icon: 'info',
    tone: 'blue',
    description: 'Waffle is a small overlay that answers questions about what is on your screen.',
    terms: ['quit', 'position', 'reset'],
    pane: aboutPane,
  },
};

function renderSettings(initial) {
  const pane = h('main', { class: 'pane' });
  const tabs = {};
  const trail = []; // pages visited, for the back and forward buttons
  let at = -1;

  const backBtn = h('button', { class: 'nav-step back', 'aria-label': 'Back', onClick: () => step(-1) }, icon('chevron-left'));
  const forwardBtn = h('button', { class: 'nav-step forward', 'aria-label': 'Forward', onClick: () => step(1) }, icon('chevron-right'));
  const topTitle = h('h1', { class: 'top-title' });

  function render(key) {
    const page = SETTINGS_PAGES[key];
    subscribers.clear(); // panes re-subscribe when rebuilt
    if (state.isRecordingShortcut) api.patchState({ isRecordingShortcut: false });
    const header = page.split
      ? h('p', { class: 'page-lede' }, page.description)
      : page.plain || page.profile
        ? null
        : h(
          'header',
          { class: 'page-head' },
          h('span', { class: `page-tile tone-${page.tone}` }, icon(page.icon)),
          h('h1', {}, page.label),
          h('p', {}, page.description),
        );
    pane.classList.toggle('split', Boolean(page.split));
    pane.classList.toggle('profile-pane', Boolean(page.profile));
    profile.classList.toggle('current', Boolean(page.profile));
    topTitle.textContent = page.split || page.plain ? page.label : '';
    pane.replaceChildren(...[header, ...page.pane().flat()].filter(Boolean));
    pane.scrollTop = 0;
    for (const [id, tab] of Object.entries(tabs)) {
      if (id === key) tab.setAttribute('aria-current', 'page');
      else tab.removeAttribute('aria-current');
    }
    backBtn.disabled = at <= 0;
    forwardBtn.disabled = at >= trail.length - 1;
  }

  function show(name) {
    const key = SETTINGS_PAGES[name] ? name : 'general';
    if (trail[at] !== key) {
      trail.splice(at + 1);
      trail.push(key);
      at = trail.length - 1;
    }
    render(key);
  }

  function step(delta) {
    const next = at + delta;
    if (next < 0 || next >= trail.length) return;
    at = next;
    render(trail[at]);
  }

  const search = h('input', { type: 'text', placeholder: 'Search', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Search settings' });
  const empty = h('p', { class: 'nav-empty', hidden: true }, 'No settings found');
  const profile = profileCard(() => show('account'));
  const items = Object.entries(SETTINGS_PAGES).filter(([, page]) => !page.profile).map(([id, page]) => {
    tabs[id] = h(
      'button',
      { class: 'nav-item', onClick: () => show(id) },
      h('span', { class: `nav-tile tone-${page.tone}` }, icon(page.icon)),
      page.label,
    );
    return tabs[id];
  });
  search.addEventListener('input', () => {
    const query = search.value.trim().toLowerCase();
    let shown = 0;
    for (const [id, page] of Object.entries(SETTINGS_PAGES)) {
      if (page.profile) continue;
      const match = !query || [page.label, page.description, ...page.terms].some((text) => text.toLowerCase().includes(query));
      tabs[id].hidden = !match;
      if (match) shown += 1;
    }
    empty.hidden = shown > 0;
  });

  const sidebar = h(
    'nav',
    { class: 'sidebar' },
    h('label', { class: 'nav-search' }, icon('search'), search),
    profile,
    h('div', { class: 'nav-list' }, items, empty),
    h('div', { class: 'nav-foot' }, icon('app-mark'), h('span', {}, 'Waffle')),
  );
  const content = h(
    'div',
    { class: 'settings-main' },
    h('div', { class: 'settings-top' }, h('div', { class: 'nav-steps' }, backBtn, h('span', { class: 'nav-sep' }), forwardBtn), topTitle),
    pane,
  );
  root.append(h('div', { class: 'settings' }, sidebar, content));
  api.onSettingsNavigate(show);
  show(initial);
}

// ---------- boot ----------

// ---------- quick mode menu ----------

const QUICK_MODE_COUNT = 3;

/**
 * The modes the quick menu offers, as Cluely does it: General first, then the three other modes
 * you have asked the most questions in (ties go to the built-in order), always including the
 * active one.
 */
function quickModes(s) {
  const general = s.modes.find((m) => m.id === 'general');
  const others = s.modes.filter((m) => m.id !== 'general');
  const order = new Map(others.map((m, i) => [m.id, i]));
  const uses = (id) => (s.modeUsage && s.modeUsage[id]) || 0;
  const ranked = [...others].sort((a, b) => uses(b.id) - uses(a.id) || order.get(a.id) - order.get(b.id));
  const picks = ranked.slice(0, QUICK_MODE_COUNT);
  if (s.mode !== 'general' && !picks.some((m) => m.id === s.mode)) {
    const active = others.find((m) => m.id === s.mode);
    if (active) picks[picks.length - 1] = active;
  }
  return general ? [general, ...picks] : picks;
}

/** The menu window's page: the quick modes, a divider, and Manage (opens Settings → Modes). */
function renderModeMenu() {
  const list = h('div', { class: 'qm-list', role: 'menu', 'aria-label': 'Modes' });
  const pop = h('div', { class: 'qm' }, list);
  root.append(pop);
  let items = [];
  let active = -1;

  function highlight(index) {
    active = index;
    items.forEach((item, i) => item.classList.toggle('active', i === index));
  }

  function paint(s) {
    const modes = quickModes(s);
    items = [
      ...modes.map((mode) =>
        h(
          'button',
          { class: 'qm-item', role: 'menuitemradio', 'aria-checked': String(mode.id === s.mode), onClick: () => api.pickMode(mode.id) },
          h('span', { class: 'qm-label' }, mode.label),
          mode.id === s.mode && icon('check'),
        ),
      ),
      h('button', { class: 'qm-item qm-manage', role: 'menuitem', onClick: () => api.manageModes() }, icon('layout-grid'), h('span', { class: 'qm-label' }, 'Manage')),
    ];
    items.forEach((item, i) => item.addEventListener('mouseenter', () => highlight(i)));
    list.replaceChildren(...items.slice(0, -1), h('div', { class: 'qm-sep', role: 'separator' }), items[items.length - 1]);
    active = -1;
    api.resizeModeMenu(pop.offsetHeight + 24); // room for the shadow
  }

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') return api.closeModeMenu();
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      highlight((active + step + items.length) % items.length);
    } else if (event.key === 'Enter' && items[active]) {
      event.preventDefault();
      items[active].click();
    }
  });
  api.onModeMenuOpened(() => highlight(-1));
  subscribe(paint);
}

(async function boot() {
  await initState();
  const [route, section] = location.hash.replace(/^#\/?/, '').split('/');
  document.body.classList.add(`route-${route || 'chat'}`);
  if (route === 'settings') renderSettings(section);
  else if (route === 'modemenu') renderModeMenu();
  else renderChat();
})();
