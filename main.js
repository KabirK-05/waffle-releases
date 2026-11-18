// Waffle — a screen-aware overlay assistant.
// Main process: windows, shared state, global shortcuts, screen capture, tray, Claude streaming.
//
// Architecture: a small always-on-top control pill, a chat window docked beneath it, and a
// regular settings window. All three load one renderer bundle on different hash routes and stay
// in sync through a single shared-state object that the main process owns and persists.

const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  nativeImage,
  nativeTheme,
  safeStorage,
  screen,
  shell,
  systemPreferences,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const Anthropic = require('@anthropic-ai/sdk');
const { AudioCapture, LiveTranscriber, checkOnDevice, AUDIOTEE_BIN } = require('./audio');
const providers = require('./providers');
const usage = require('./usage');
const openai = require('./openai');
const prompts = require('./prompts');
const { createHistory } = require('./history');
const { createUpdater } = require('./updater');
const { ModeStore, FILE_TYPES } = require('./modes');

const isMac = process.platform === 'darwin';

// Apps launched from Finder get a minimal PATH; the claude and codex CLIs often live in a Homebrew prefix.
if (isMac) process.env.PATH = `${process.env.PATH || ''}:/opt/homebrew/bin:/usr/local/bin`;

// The speech API fallback is fixed to OpenAI's transcription endpoint. It is deliberately not a
// setting: the endpoint receives your audio and your key, so nothing in the UI can redirect it.
const SPEECH_ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';
const SPEECH_MODEL = 'whisper-1';
const SPEECH_MODELS = ['whisper-1', 'gpt-4o-transcribe', 'gpt-4o-mini-transcribe'];
// Apple's on-device speech helper. In a packaged build it must sit outside the asar archive.
const SPEECH_HELPER = path
  .join(__dirname, 'bin', 'waffle-speech')
  .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
const CHAT_WIDTH = 690;
const CHAT_MIN_HEIGHT = 104; // the ask box alone
const CHAT_MAX_HEIGHT = 760; // History can grow this tall; the chat itself stops at 500 (renderer)
const TOP_MARGIN = 14;
const MOVE_STEP = 80;
const SCROLL_STEP = 240;
const REVEAL_DELAY_MS = 30;
const MAX_CAPTURE_EDGE = 1920; // longest edge of the screenshot sent to the model
const MAX_HISTORY_TURNS = 6;
const DEFAULT_MODEL = 'claude-opus-5-5';
const mod = 'CommandOrControl';
const DEFAULT_SHORTCUTS = {
  ask: `${mod}+Enter`,
  toggleOverlay: `${mod}+\\`,
  newChat: `${mod}+R`,
  toggleListen: `${mod}+Shift+L`,
  moveUp: `${mod}+Up`,
  moveDown: `${mod}+Down`,
  moveLeft: `${mod}+Left`,
  moveRight: `${mod}+Right`,
  scrollUp: `${mod}+Shift+Up`,
  scrollDown: `${mod}+Shift+Down`,
  // Registered only while an answer's follow-up options are on screen, so they don't take
  // these keys from other apps (⌘1 switches browser tabs) the rest of the time.
  followUp1: `${mod}+1`,
  followUp2: `${mod}+2`,
  followUp3: `${mod}+3`,
};
const FOLLOW_UP_ACTIONS = ['followUp1', 'followUp2', 'followUp3'];

const DEFAULT_STATE = {
  isInvisible: true, // hide every window from screenshots, recordings and screen shares
  noFocusWhenInvisible: false, // never take keyboard focus while invisible (Tab focuses on demand)
  tabToFocus: true, // while a conversation is open, Tab focuses the follow-up bar (Cluely's "Tab to focus")
  openAtLogin: false,
  useScreen: true, // attach a screenshot to each question
  mode: 'general', // tailors answers to a scenario; see prompts.js
  keepHistory: true, // save each conversation's text to history.db
  followUps: true, // suggest follow-ups after each answer, picked with ⌘1–⌘3
  modeUsage: {}, // mode id -> questions asked in it; the overlay's mode menu shows the most used
  provider: 'api', // 'api' (Anthropic API key), 'openai' (OpenAI API key), 'claude' (Claude subscription) or 'chatgpt' (ChatGPT subscription)
  model: DEFAULT_MODEL,
  codexModel: '', // empty: whatever model the Codex CLI defaults to
  openaiModel: '', // empty: the newest GPT model the OpenAI key can use
  effort: 'low',
  speechEngine: 'apple', // 'apple' (on this Mac, speech API as fallback) or 'api' (speech API only)
  shortcuts: DEFAULT_SHORTCUTS,
  controlPosition: null, // {x, y} once the user has moved the pill
  onboarded: false, // finished the first-run setup (onboarding window); see ---------- onboarding ----------
  onboardingStep: 'welcome', // where setup resumes after a relaunch (Screen Recording needs one)
  systemAudioAsked: false, // macOS has shown its system audio prompt; apps can't read the answer
  profileName: '', // the name on the Account page; empty means the Mac account's full name
  speechModel: SPEECH_MODEL, // OpenAI transcription model for the speech API
  usage: { claude: null, chatgpt: null }, // last reported subscription limits (usage.js), kept across launches
  disconnected: [], // subscriptions Waffle has stopped using ('claude', 'chatgpt'); the tool itself stays signed in
};

// Fields that live only in memory and are recomputed on launch.
const VOLATILE = () => ({
  systemName: '', // this Mac account's full name, the default profile name
  profilePhotoRev: 0, // bumps when the profile photo changes; 0 means there is none
  overlayVisible: true,
  chatOpen: false,
  chatExpanded: false, // the overlay shows a conversation (set by the renderer); Tab to focus applies
  isRecordingShortcut: false,
  isCapturingScreenshot: false,
  hasKey: false,
  hasSpeechKey: false,
  auth: {
    claude: { installed: false, signedIn: false, checking: true, detail: 'Checking…' },
    chatgpt: { installed: false, signedIn: false, checking: true, detail: 'Checking…' },
  },
  isListening: false, // recording the microphone and system audio
  listenPaused: false, // recording continues but audio is dropped until resumed
  listenClock: { base: 0, since: null }, // session time: base ms, plus now − since while running
  hasTranscript: false, // a listening session's transcript is available to view and ask about
  appleSpeech: { status: isMac ? 'checking' : 'unavailable', detail: isMac ? '' : 'Only available on macOS.' },
  currentChatId: null, // the saved conversation now on screen, if any
  modes: [], // every mode with its instructions and files (modes.js), filled in once the app is ready
  modeFileTypes: FILE_TYPES.label,
  audioNotice: '', // last capture or transcription problem, shown in the UI
  permissions: { screen: 'unknown', microphone: 'unknown' },
  shortcutErrors: [],
  defaultShortcuts: DEFAULT_SHORTCUTS, // so settings can reset one shortcut at a time
  settingsGlass: false, // true while the settings window has a native glass backdrop
  overlayGlass: false, // true while the overlay has a native glass backdrop
  update: { state: app.isPackaged ? 'idle' : 'dev', version: app.getVersion(), available: '', percent: 0, error: '' }, // updater.js
});

let state = { ...DEFAULT_STATE, ...VOLATILE() };
let chatWin = null;
let settingsWin = null;
let onboardingWin = null; // the first-run setup window, while it is open
let tray = null;
let history = []; // Anthropic.MessageParam[]
let conversation = 1; // bumps on New Chat; the live Claude Code process belongs to one conversation
let claudeTurns = 0; // questions sent to Claude Code in this conversation
let chatLog = null; // saved conversations (history.js), opened once the app is ready
let modeStore = null; // built-in and custom modes with their files (modes.js)
let activeStream = null;
let tabShortcutActive = false;
let followUpCount = 0; // follow-up options under the newest answer; their hotkeys are live while > 0
let followUpKeys = []; // accelerators registered for those options
const screenshots = new Map(); // id -> base64 PNG, consumed by the next chat-send
// Screenshots already sent in this chat, so "Viewed screen" can show them again. Memory only:
// never written to disk, cleared on New Chat, and capped to the most recent few.
const sentShots = new Map(); // id -> base64 PNG
const MAX_SENT_SHOTS = 30;

// ---------- persistence ----------

const statePath = () => path.join(app.getPath('userData'), 'shared-state.json');
const secretsPath = () => path.join(app.getPath('userData'), 'secrets.json');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
}

/** Validate one persisted/patchable field. Returns undefined when the value is not acceptable. */
function sanitize(key, value) {
  switch (key) {
    case 'isInvisible':
    case 'noFocusWhenInvisible':
    case 'tabToFocus':
    case 'chatExpanded':
    case 'openAtLogin':
    case 'useScreen':
    case 'keepHistory':
    case 'followUps':
    case 'isRecordingShortcut':
    case 'onboarded':
    case 'systemAudioAsked':
      return typeof value === 'boolean' ? value : undefined;
    case 'modeUsage': {
      if (!value || typeof value !== 'object') return undefined;
      const usage = {};
      for (const [id, count] of Object.entries(value).slice(0, 200)) {
        if (typeof id === 'string' && id.length <= 80 && Number.isInteger(count) && count > 0) usage[id] = count;
      }
      return usage;
    }
    case 'onboardingStep':
      return ONBOARDING_STEPS.includes(value) ? value : undefined;
    case 'speechModel':
      return SPEECH_MODELS.includes(value) ? value : undefined;
    case 'usage': {
      const window = (w) =>
        w && typeof w.id === 'string' && typeof w.label === 'string'
          ? { id: w.id, label: w.label, percent: Number.isFinite(w.percent) ? w.percent : null, resetsAt: Number.isFinite(w.resetsAt) ? w.resetsAt : null, limited: Boolean(w.limited) }
          : null;
      const snap = (v) => (v && Number.isFinite(v.at) && Array.isArray(v.windows) ? { at: v.at, windows: v.windows.map(window).filter(Boolean) } : null);
      return value && typeof value === 'object' ? { claude: snap(value.claude), chatgpt: snap(value.chatgpt) } : undefined;
    }
    case 'disconnected':
      return Array.isArray(value) ? [...new Set(value.filter((p) => p === 'claude' || p === 'chatgpt'))] : undefined;
    case 'profileName':
      return typeof value === 'string' && value.length <= 200 ? value.trim().replace(/\s+/g, ' ').slice(0, 80) : undefined;
    case 'model':
      return typeof value === 'string' && /^[\w.\-:@]{1,80}$/.test(value.trim()) ? value.trim() : undefined;
    case 'provider':
      return ['api', 'openai', 'claude', 'chatgpt'].includes(value) ? value : undefined;
    case 'codexModel':
    case 'openaiModel':
      if (value === '' || value == null) return '';
      return typeof value === 'string' && /^[\w.\-:@/]{1,80}$/.test(value.trim()) ? value.trim() : undefined;
    case 'effort':
      return ['low', 'medium', 'high'].includes(value) ? value : undefined;
    case 'mode':
      return (modeStore ? modeStore.has(value) : prompts.MODE_IDS.includes(value)) ? value : undefined;
    case 'speechEngine':
      return ['apple', 'api'].includes(value) ? value : undefined;
    case 'shortcuts': {
      if (!value || typeof value !== 'object') return undefined;
      const next = { ...state.shortcuts };
      for (const action of Object.keys(DEFAULT_SHORTCUTS)) {
        const accel = value[action];
        if (typeof accel === 'string' && accel.length <= 60) next[action] = accel;
      }
      return next;
    }
    case 'controlPosition':
      if (value === null) return null;
      return value && Number.isFinite(value.x) && Number.isFinite(value.y)
        ? { x: Math.round(value.x), y: Math.round(value.y) }
        : undefined;
    default:
      return undefined;
  }
}

function loadState() {
  const saved = readJson(statePath());
  const next = { ...DEFAULT_STATE, ...VOLATILE() };
  for (const key of Object.keys(DEFAULT_STATE)) {
    if (key in saved) {
      state = next; // sanitize('shortcuts') merges onto the current state
      const value = sanitize(key, saved[key]);
      if (value !== undefined) next[key] = value;
    }
  }
  next.hasKey = Boolean(getApiKey());
  next.hasSpeechKey = Boolean(getSpeechKey());
  // Saved state from before onboarding existed means Waffle is already set up: don't send them through it.
  if (!('onboarded' in saved) && Object.keys(saved).length) next.onboarded = true;
  state = next;
}

/**
 * The app was called Glint, and its user-data folder was named after it. On the first launch as
 * Waffle, copy Glint's own files (settings, history, modes, profile photo, saved keys) across;
 * the old folder is left as it was. Keys encrypted under the old name may not decrypt, in which
 * case the Account page simply asks for them again.
 */
function carryOverFromGlint() {
  const to = app.getPath('userData');
  const from = path.join(app.getPath('appData'), 'Glint');
  if (fs.existsSync(path.join(to, 'shared-state.json')) || !fs.existsSync(path.join(from, 'shared-state.json'))) return;
  const files = ['shared-state.json', 'secrets.json', 'history.db', 'history.db-wal', 'history.db-shm', 'modes.json', 'profile-photo.png', 'mode-files'];
  fs.mkdirSync(to, { recursive: true });
  for (const name of files) {
    try {
      if (fs.existsSync(path.join(from, name))) fs.cpSync(path.join(from, name), path.join(to, name), { recursive: true });
    } catch (err) {
      console.warn(`Could not copy ${name} from Glint:`, err.message);
    }
  }
}

function persistState() {
  const out = {};
  for (const key of Object.keys(DEFAULT_STATE)) out[key] = state[key];
  writeJson(statePath(), out);
}

/** Secrets are encrypted with the OS keychain; each falls back to an environment variable. */
function readSecret(field, envName) {
  const encrypted = readJson(secretsPath())[field];
  if (encrypted && safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
    } catch {
      /* fall through to the environment */
    }
  }
  return process.env[envName] || null;
}

function writeSecret(field, value) {
  const secrets = readJson(secretsPath());
  if (value) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error(`OS keychain encryption is unavailable; set the environment variable instead.`);
    }
    secrets[field] = safeStorage.encryptString(value).toString('base64');
  } else {
    delete secrets[field];
  }
  writeJson(secretsPath(), secrets);
}

const getApiKey = () => readSecret('apiKeyEnc', 'ANTHROPIC_API_KEY');
const getSpeechKey = () => readSecret('speechKeyEnc', 'WAFFLE_SPEECH_API_KEY');

// ---------- shared state ----------

const updater = createUpdater({ onChange: (update) => patchState({ update }, { persist: false }) });

const windows = () => [chatWin, settingsWin, modeMenuWin, borderWin].filter((w) => w && !w.isDestroyed());

function broadcast(channel, payload) {
  for (const win of windows()) win.webContents.send(channel, payload);
  if (onboardingWin && !onboardingWin.isDestroyed()) onboardingWin.webContents.send(channel, payload);
}

/** Apply a partial update, persist it, re-apply side effects and mirror it to every window. */
function patchState(patch, { persist = true } = {}) {
  const before = state;
  state = { ...state, ...patch };
  if (persist) persistState();
  applyState(before);
  broadcast('shared-state-updated', state);
}

function applyState(before = {}) {
  applyWindowPolicies();
  if (['provider', 'model', 'effort', 'mode', 'modes', 'followUps', 'auth'].some((key) => key in before && before[key] !== state[key])) prewarmClaude();
  if (before.shortcuts !== state.shortcuts || before.isRecordingShortcut !== state.isRecordingShortcut) {
    registerShortcuts();
  }
  if (before.isInvisible !== state.isInvisible) {
    if (isMac && app.dock) state.isInvisible && !onboardingOpen() ? app.dock.hide() : showDock(); // setup is a regular window
    updateTray();
    syncInvisibleBorder();
  }
  // Registering a dev build as a login item would launch the bare Electron binary.
  if (before.openAtLogin !== state.openAtLogin && app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: state.openAtLogin });
  }
  if (before.overlayVisible !== state.overlayVisible || before.chatOpen !== state.chatOpen) {
    syncOverlayVisibility();
    updateTray();
  }
  if (before.isListening !== state.isListening) updateTray();
  if (!state.overlayVisible) hideModeMenu(); // the menu belongs to the overlay
  if (before.followUps !== state.followUps && !state.followUps) setFollowUps(0);
  syncAskShortcut(); // only while the overlay is on screen
  syncTabShortcut();
  syncFollowUpShortcuts();
}

// ---------- windows ----------

const overlayFocusable = () => !(state.isInvisible && state.noFocusWhenInvisible);

/** Content protection keeps a window out of captures; it is forced on while we take our own. */
function applyWindowPolicies() {
  const protect = state.isInvisible || state.isCapturingScreenshot;
  for (const win of windows()) win.setContentProtection(protect);
  if (chatWin && !chatWin.isDestroyed()) chatWin.setFocusable(overlayFocusable());
}

function guardNavigation(win) {
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.on('will-redirect', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https:|mailto:)/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

const webPreferences = () => ({
  preload: path.join(__dirname, 'preload.js'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  backgroundThrottling: false, // keep streaming smooth while the overlay is unfocused
});

function createOverlayWindow(route, size) {
  const win = new BrowserWindow({
    ...size,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    type: isMac ? 'panel' : undefined, // a panel can take keys without activating the app
    webPreferences: webPreferences(),
  });
  win.setSkipTaskbar(true);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  guardNavigation(win);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), { hash: route });
  return win;
}

// ---------- mode menu ----------
// The overlay's quick mode menu is its own small window under the mode button. The overlay window
// is exactly the size of its box and carries native glass, so a menu drawn inside it would be
// clipped or sit on glass.

let modeMenuWin = null;
let modeMenuClosedAt = 0;
// Cluely's menu: 168px wide, side bottom, aligned to the button's left edge, 4px below it.
const MODE_MENU_WIDTH = 168 + 2 * 12; // the menu plus room for its shadow
const MODE_MENU_INSET = { x: 12, y: 2 }; // where the menu sits inside its window (matches .qm)
const MODE_MENU_OFFSET = 4;

function hideModeMenu() {
  if (modeMenuWin && !modeMenuWin.isDestroyed() && modeMenuWin.isVisible()) {
    modeMenuWin.hide();
    modeMenuClosedAt = Date.now();
  }
}

function createModeMenuWindow() {
  const win = new BrowserWindow({
    width: MODE_MENU_WIDTH,
    height: 220,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    fullscreenable: false,
    minimizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    type: isMac ? 'panel' : undefined,
    webPreferences: webPreferences(),
  });
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setContentProtection(state.isInvisible || state.isCapturingScreenshot);
  guardNavigation(win);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), { hash: 'modemenu' });
  win.on('blur', hideModeMenu); // clicking anywhere else closes it
  win.on('closed', () => {
    modeMenuWin = null;
  });
  return win;
}

/** Open the menu under the mode button (anchor is the button's rect in the overlay), or close it. */
function toggleModeMenu(anchor) {
  if (modeMenuWin && !modeMenuWin.isDestroyed() && modeMenuWin.isVisible()) return hideModeMenu();
  // The click that blurred the menu also lands here; don't reopen what that click just closed.
  if (Date.now() - modeMenuClosedAt < 250) return;
  if (!chatWin || chatWin.isDestroyed() || !anchor) return;
  if (!modeMenuWin || modeMenuWin.isDestroyed()) modeMenuWin = createModeMenuWindow();
  const box = chatWin.getContentBounds();
  const x = Math.round(box.x + Number(anchor.x) - MODE_MENU_INSET.x);
  const y = Math.round(box.y + Number(anchor.y) + Number(anchor.height) + MODE_MENU_OFFSET - MODE_MENU_INSET.y);
  modeMenuWin.setPosition(x, y);
  const show = () => {
    if (!modeMenuWin || modeMenuWin.isDestroyed()) return;
    modeMenuWin.setAlwaysOnTop(true, 'pop-up-menu');
    modeMenuWin.show();
    modeMenuWin.focus();
    modeMenuWin.webContents.send('mode-menu-opened');
  };
  if (modeMenuWin.webContents.isLoading()) modeMenuWin.webContents.once('did-finish-load', show);
  else show();
}

function reveal(win) {
  if (!win || win.isDestroyed() || win.isVisible()) return;
  // Show fully transparent first so the window never flashes an unpainted frame.
  win.setOpacity(0);
  win.showInactive();
  win.setAlwaysOnTop(true, 'modal-panel');
  win.moveTop();
  setTimeout(() => !win.isDestroyed() && win.setOpacity(1), REVEAL_DELAY_MS);
}

function createChatWindow() {
  // The ask box is the overlay: it stays on screen and answers grow out beneath it.
  chatWin = createOverlayWindow('chat', { width: CHAT_WIDTH, height: CHAT_MIN_HEIGHT });
  // Real frosted glass behind the box: the desktop is blurred natively, which CSS cannot do
  // through a transparent window. The window is kept exactly the size of the box, so the glass
  // (rounded to the box's corners) never shows outside it.
  chatWin.webContents.once('did-finish-load', () => {
    // 18px: the box's radius in undetectable mode (16px otherwise, which the glass then sits inside).
    const glass = addNativeGlass(chatWin, { cornerRadius: 18, tintColor: '#00000000' });
    patchState({ overlayGlass: glass }, { persist: false });
  });
  chatWin.once('ready-to-show', () => {
    positionOverlay();
    syncOverlayVisibility();
  });
  let saveTimer = null;
  chatWin.on('moved', () => {
    if (Date.now() < ignoreMovesUntil) return; // Waffle moved it to make room; not the user's spot
    raisedFromY = null; // the user picked a new spot, so there is nowhere to go back to
    positionOverlay({ keepPosition: true });
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (chatWin.isDestroyed()) return;
      const [x, y] = chatWin.getPosition();
      patchState({ controlPosition: { x, y } });
    }, 250);
  });
  chatWin.on('blur', () => {
    chatWin.webContents.send('chat-blur-input');
    chatWin.setFocusable(overlayFocusable());
    syncTabShortcut();
  });
  chatWin.on('focus', syncTabShortcut);
  chatWin.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && (input.meta || input.control) && input.key === ',') {
      event.preventDefault();
      openSettings();
    }
  });
  chatWin.on('resize', placeInvisibleBorder);
  chatWin.on('move', placeInvisibleBorder);
  chatWin.on('show', syncInvisibleBorder);
  chatWin.on('hide', syncInvisibleBorder);
  chatWin.on('closed', () => {
    chatWin = null;
  });
}

const SETTINGS_BG = '#292626'; // Cluely's settings background; matches --set-bg in styles.css

/**
 * Put a native macOS glass view behind the settings window. The package is optional and
 * macOS-only, so every failure path falls back to a plain solid background.
 */
function addNativeGlass(win, options) {
  const wantsPlain = nativeTheme.prefersReducedTransparency || nativeTheme.shouldUseHighContrastColors;
  if (!isMac || wantsPlain || win.isDestroyed()) return false;
  try {
    const mod = require('electron-liquid-glass');
    const liquidGlass = mod.default || mod;
    const supported =
      typeof liquidGlass.isGlassSupported === 'function' ? liquidGlass.isGlassSupported() : true;
    if (!supported) return false;
    const id = liquidGlass.addView(win.getNativeWindowHandle(), options);
    return typeof id === 'number' && id >= 0;
  } catch (err) {
    console.warn('Glass effect unavailable:', err.message);
    return false;
  }
}


// True while the overlay is hidden because Settings is open; it comes back when Settings closes.
let overlayHiddenForSettings = false;

/** Opening Settings tucks the overlay away so the two never overlap. */
function hideOverlayForSettings() {
  if (!state.overlayVisible) return;
  overlayHiddenForSettings = true;
  patchState({ overlayVisible: false }, { persist: false });
}

function openSettings(section) {
  hideModeMenu();
  hideOverlayForSettings();
  if (settingsWin && !settingsWin.isDestroyed()) {
    if (section) settingsWin.webContents.send('settings-navigate', section);
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 860,
    height: 680,
    minWidth: 720,
    minHeight: 520,
    show: false,
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 20, y: 19 }, // inside the floating sidebar
    backgroundColor: SETTINGS_BG,
    webPreferences: webPreferences(),
  });
  if (isMac) settingsWin.setWindowButtonVisibility(true);
  guardNavigation(settingsWin);
  settingsWin.setContentProtection(state.isInvisible || state.isCapturingScreenshot);
  settingsWin.loadFile(path.join(__dirname, 'renderer', 'index.html'), {
    hash: section ? `settings/${section}` : 'settings',
  });
  settingsWin.once('ready-to-show', () => settingsWin.show());
  settingsWin.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && (input.meta || input.control) && input.key.toLowerCase() === 'w') {
      event.preventDefault();
      settingsWin.close();
    }
  });
  settingsWin.on('focus', syncTabShortcut); // Tab belongs to Settings while it has focus
  settingsWin.on('blur', syncTabShortcut);
  settingsWin.on('closed', () => {
    settingsWin = null;
    if (state.isRecordingShortcut) patchState({ isRecordingShortcut: false }, { persist: false });
    // Bring the overlay back only if Settings is what hid it (you may have shown it meanwhile).
    if (overlayHiddenForSettings && !state.overlayVisible) patchState({ overlayVisible: true }, { persist: false });
    overlayHiddenForSettings = false;
  });
}

// ---------- profile (Account page) ----------

// The Account page's name and photo. Waffle has no account of its own, so this is just how you
// appear in Settings: the photo is a 256px square kept in user data, never sent anywhere.
const profilePhotoPath = () => path.join(app.getPath('userData'), 'profile-photo.png');

function systemFullName() {
  try {
    if (isMac) return execFileSync('id', ['-F'], { encoding: 'utf8', timeout: 2000 }).trim();
  } catch {
    /* fall back to the login name */
  }
  return os.userInfo().username || '';
}

function loadProfile() {
  state = { ...state, systemName: systemFullName(), profilePhotoRev: fs.existsSync(profilePhotoPath()) ? 1 : 0 };
}

async function pickProfilePhoto(win) {
  const result = await dialog.showOpenDialog(win && !win.isDestroyed() ? win : undefined, {
    title: 'Choose a profile photo',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'heic', 'gif', 'webp', 'tiff', 'bmp'] }],
  });
  if (result.canceled || !result.filePaths[0]) return false;
  const image = nativeImage.createFromPath(result.filePaths[0]);
  if (image.isEmpty()) throw new Error('That file isn’t an image Waffle can read.');
  // Centre-crop to a square, then scale to 256px.
  const { width, height } = image.getSize();
  const side = Math.min(width, height);
  const square = image.crop({ x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), width: side, height: side });
  fs.writeFileSync(profilePhotoPath(), square.resize({ width: 256, height: 256, quality: 'best' }).toPNG());
  patchState({ profilePhotoRev: state.profilePhotoRev + 1 }, { persist: false });
  return true;
}

function removeProfilePhoto() {
  fs.rmSync(profilePhotoPath(), { force: true });
  patchState({ profilePhotoRev: 0 }, { persist: false });
}

function profilePhotoDataUrl() {
  try {
    return `data:image/png;base64,${fs.readFileSync(profilePhotoPath()).toString('base64')}`;
  } catch {
    return null;
  }
}

// ---------- subscription usage ----------

/** Keep the latest limits a subscription reported (persisted, so the Account page has them at launch). */
function noteUsage(provider, snapshot) {
  if (!snapshot) return;
  const merged = usage.merge(state.usage?.[provider], snapshot);
  patchState({ usage: { ...state.usage, [provider]: merged } });
}

// ---------- app icon ----------

// Waffle's icon (assets/icon.png, macOS rounded-square grid; assets/icon.icns for a packaged build).
// A dev build would otherwise show Electron's icon in the Dock and app switcher.
const APP_ICON = path.join(__dirname, 'assets', 'icon.png');

function showDock() {
  app.dock.setIcon(APP_ICON);
  app.dock.show().then(() => app.dock.setIcon(APP_ICON)).catch(() => {});
}

// ---------- onboarding ----------

// First-run setup, a copy of Cluely's onboarding window minus its account sign-in: choose and sign
// in to a subscription, grant permissions, then short demos of the overlay. Rendered by
// renderer/onboarding.html; the overlay is created only once it finishes.
const ONBOARDING_STEPS = ['welcome', 'ai', 'permissions', 'ask', 'hide', 'move', 'listen', 'notes', 'undetectable'];
const onboardingOpen = () => Boolean(onboardingWin && !onboardingWin.isDestroyed());
let quitting = false; // the window closing because the app quits is not the user leaving setup
app.on('before-quit', () => {
  quitting = true;
});

/**
 * Open setup. `fromStart` (Reset onboarding, Run setup again) begins at Welcome, not at the step
 * last seen. The overlay is hidden while setup is open and comes back when it closes.
 */
function openOnboarding({ fromStart = false } = {}) {
  // Closing Settings brings back an overlay that Settings hid; setup wants it to stay hidden.
  overlayHiddenForSettings = false;
  if (state.overlayVisible) patchState({ overlayVisible: false }, { persist: false });
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close();
  if (fromStart && state.onboardingStep !== 'welcome') patchState({ onboardingStep: 'welcome' });
  if (onboardingOpen()) {
    if (fromStart) onboardingWin.webContents.reload(); // renders the saved step, now Welcome
    onboardingWin.show();
    return onboardingWin.focus();
  }
  if (isMac && app.dock) showDock(); // a regular window needs a Dock icon while it is open
  // Cluely's onboarding window: 1100 × 720, fixed size, inset traffic lights at (12, 12).
  onboardingWin = new BrowserWindow({
    width: 1100,
    height: 720,
    resizable: false,
    fullscreenable: false,
    show: false,
    title: 'Waffle',
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 12, y: 12 },
    backgroundColor: '#050708',
    webPreferences: webPreferences(),
  });
  guardNavigation(onboardingWin);
  onboardingWin.loadFile(path.join(__dirname, 'renderer', 'onboarding.html'));
  onboardingWin.once('ready-to-show', () => {
    onboardingWin.show();
    onboardingWin.focus();
  });
  onboardingWin.on('closed', () => {
    onboardingWin = null;
    if (quitting) return;
    // Closing setup on first run quits, as Cluely does; when run again from Settings it returns to Waffle.
    if (!state.onboarded) return app.quit();
    leaveOnboarding();
  });
  registerShortcuts();
}

/** Back to the overlay: create it on first run, show it, and re-arm the global shortcuts. */
function leaveOnboarding() {
  if (isMac && app.dock && state.isInvisible) app.dock.hide();
  if (!chatWin || chatWin.isDestroyed()) createChatWindow();
  registerShortcuts();
  patchState({ overlayVisible: true }, { persist: false }); // a new overlay shows itself once it has loaded
  prewarmClaude();
}

function finishOnboarding() {
  patchState({ onboarded: true, onboardingStep: 'welcome' });
  if (onboardingOpen()) onboardingWin.close(); // 'closed' runs leaveOnboarding()
  else leaveOnboarding();
}

/**
 * macOS asks for system audio ("System Audio Recording Only") the first time something taps it, and
 * offers no way to read the answer. Tap it for a moment so the prompt appears during setup.
 */
async function askForSystemAudio() {
  if (isMac && !state.isListening) {
    let tee = null;
    try {
      const { AudioTee } = await import('audiotee');
      tee = new AudioTee({ sampleRate: 16000, chunkDurationMs: 200, binaryPath: AUDIOTEE_BIN });
      tee.on('error', () => {});
      await tee.start();
      await new Promise((resolve) => setTimeout(resolve, 1500));
    } catch {
      /* the prompt is the point; a failure here shows up when a session starts */
    } finally {
      try {
        await tee?.stop();
      } catch {
        /* already exited */
      }
    }
  }
  patchState({ systemAudioAsked: true });
  return state.systemAudioAsked;
}

// ---------- positioning ----------

const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));

/** Keep the ask box on a display, at its saved spot or centred near the top. */
function positionOverlay({ keepPosition = false } = {}) {
  if (!chatWin || chatWin.isDestroyed()) return;
  let bounds = chatWin.getBounds();

  if (!keepPosition) {
    const primary = screen.getPrimaryDisplay().workArea;
    const wanted = state.controlPosition || {
      x: Math.round(primary.x + (primary.width - CHAT_WIDTH) / 2),
      y: primary.y + TOP_MARGIN,
    };
    bounds = { ...bounds, ...wanted };
  }

  const area = screen.getDisplayMatching(bounds).workArea;
  const x = clamp(bounds.x, area.x, area.x + area.width - bounds.width);
  const y = clamp(bounds.y, area.y, area.y + area.height - CHAT_MIN_HEIGHT);
  const now = chatWin.getBounds();
  if (x !== now.x || y !== now.y) chatWin.setPosition(x, y);
}

function moveOverlay(dx, dy) {
  if (!chatWin || chatWin.isDestroyed()) return;
  const [x, y] = chatWin.getPosition();
  chatWin.setPosition(x + dx, y + dy);
  positionOverlay({ keepPosition: true });
  const [nx, ny] = chatWin.getPosition();
  patchState({ controlPosition: { x: nx, y: ny } });
}

let chatHeightTarget = 0;
let chatTween = null;
let raisedFromY = null; // where the window was before it slid up to fit a full-height page
let ignoreMovesUntil = 0;

function moveChatTo(y) {
  ignoreMovesUntil = Date.now() + 500;
  chatWin.setPosition(chatWin.getBounds().x, y);
}

/**
 * Ease the window toward the height the box wants. The box fills the window, so its toolbar
 * glides down with it; resizing straight to each new height is what looked choppy.
 * With `makeRoom` (a session's summary or transcript page, which has a fixed height) the window
 * slides up when there is not enough screen below it, and returns once the page closes.
 */
function resizeChat(requestedHeight, makeRoom = false) {
  if (!chatWin || chatWin.isDestroyed() || !Number.isFinite(requestedHeight)) return;
  let bounds = chatWin.getBounds();
  const area = screen.getDisplayMatching(bounds).workArea;
  if (makeRoom) {
    const needed = Math.min(requestedHeight, CHAT_MAX_HEIGHT, area.height - 2 * TOP_MARGIN);
    if (area.y + area.height - bounds.y - TOP_MARGIN < needed) {
      if (raisedFromY == null) raisedFromY = bounds.y;
      moveChatTo(Math.max(area.y + TOP_MARGIN, area.y + area.height - TOP_MARGIN - needed));
      bounds = chatWin.getBounds();
    }
  } else if (raisedFromY != null) {
    moveChatTo(raisedFromY);
    raisedFromY = null;
    bounds = chatWin.getBounds();
  }
  const room = area.y + area.height - bounds.y - TOP_MARGIN;
  chatHeightTarget = Math.round(clamp(requestedHeight, CHAT_MIN_HEIGHT, Math.min(CHAT_MAX_HEIGHT, room)));
  if (!chatWin.isVisible()) {
    chatWin.setSize(CHAT_WIDTH, chatHeightTarget); // nothing to animate while hidden
    return;
  }
  if (!chatTween && chatHeightTarget !== bounds.height) chatTween = setInterval(stepChatHeight, 16);
}

function stepChatHeight() {
  if (!chatWin || chatWin.isDestroyed()) {
    clearInterval(chatTween);
    chatTween = null;
    return;
  }
  const current = chatWin.getBounds().height;
  const diff = chatHeightTarget - current;
  if (diff === 0) {
    clearInterval(chatTween);
    chatTween = null;
    return;
  }
  const step = Math.abs(diff) <= 2 ? diff : Math.round(diff * 0.3) || Math.sign(diff);
  chatWin.setSize(CHAT_WIDTH, current + step);
}

function syncOverlayVisibility() {
  if (!chatWin || chatWin.isDestroyed()) return;
  // chatOpen now only says whether the answers under the ask box are expanded.
  state.overlayVisible ? reveal(chatWin) : chatWin.hide();
  syncInvisibleBorder();
}

// ---------- undetectable border ----------
// While undetectable mode is on, a dotted ring sits 8px outside the box (Cluely's cue). The overlay's
// glass fills its whole window, so the ring is its own click-through child window that moves with it.

let borderWin = null;
const BORDER_GAP = 8;

function placeInvisibleBorder() {
  if (!borderWin || borderWin.isDestroyed() || !chatWin || chatWin.isDestroyed()) return;
  const box = chatWin.getBounds();
  borderWin.setBounds({
    x: box.x - BORDER_GAP,
    y: box.y - BORDER_GAP,
    width: box.width + 2 * BORDER_GAP,
    height: box.height + 2 * BORDER_GAP,
  });
}

function createInvisibleBorderWindow() {
  const win = new BrowserWindow({
    parent: chatWin, // a child window moves with the overlay while it is dragged
    width: CHAT_WIDTH + 2 * BORDER_GAP,
    height: CHAT_MIN_HEIGHT + 2 * BORDER_GAP,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    focusable: false,
    fullscreenable: false,
    minimizable: false,
    skipTaskbar: true,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setIgnoreMouseEvents(true);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setContentProtection(state.isInvisible || state.isCapturingScreenshot);
  guardNavigation(win);
  win.loadFile(path.join(__dirname, 'renderer', 'border.html'));
  win.on('closed', () => {
    borderWin = null;
  });
  return win;
}

function syncInvisibleBorder() {
  const want = state.isInvisible && chatWin && !chatWin.isDestroyed() && chatWin.isVisible();
  if (!want) {
    if (borderWin && !borderWin.isDestroyed()) borderWin.hide();
    return;
  }
  if (!borderWin || borderWin.isDestroyed()) borderWin = createInvisibleBorderWindow();
  placeInvisibleBorder();
  if (!borderWin.isVisible()) borderWin.showInactive();
}

// ---------- focus ----------

function focusChatInput() {
  if (!chatWin || chatWin.isDestroyed()) return;
  chatWin.setFocusable(true);
  let done = false;
  const finish = () => {
    if (done || chatWin.isDestroyed()) return;
    done = true;
    chatWin.webContents.focus();
    chatWin.webContents.send('chat-focus-input');
    syncTabShortcut();
  };
  chatWin.once('focus', finish);
  setTimeout(finish, 500); // fall back if the focus event never arrives
  chatWin.focus();
}

/**
 * Tab is the way into the overlay: always while it refuses focus, and (as in Cluely) while a
 * conversation is expanded and "Tab to focus" is on, so the follow-up bar can be focused from any app.
 */
function syncTabShortcut() {
  const shown = Boolean(chatWin && !chatWin.isDestroyed() && chatWin.isVisible());
  const settingsFocused = Boolean(settingsWin && !settingsWin.isDestroyed() && settingsWin.isFocused());
  const wanted =
    shown &&
    !state.isRecordingShortcut &&
    !settingsFocused &&
    ((!overlayFocusable() && !chatWin.isFocused()) || (state.tabToFocus && state.chatExpanded));
  if (wanted === tabShortcutActive) return;
  if (wanted) tabShortcutActive = globalShortcut.register('Tab', focusChatInput);
  else {
    globalShortcut.unregister('Tab');
    tabShortcutActive = false;
  }
}

// ---------- global shortcuts ----------

const ACTIONS = {
  ask: () => {
    overlayHiddenForSettings = false; // you asked for it; closing Settings shouldn't change it
    patchState({ overlayVisible: true, chatOpen: true }, { persist: false });
    if (chatWin) chatWin.webContents.send('chat-submit');
  },
  toggleOverlay: () => {
    overlayHiddenForSettings = false;
    patchState({ overlayVisible: !state.overlayVisible }, { persist: false });
  },
  newChat: startNewChat,
  toggleListen: () => (state.isListening ? stopListening() : startListening()),
  moveUp: () => moveOverlay(0, -MOVE_STEP),
  moveDown: () => moveOverlay(0, MOVE_STEP),
  moveLeft: () => moveOverlay(-MOVE_STEP, 0),
  moveRight: () => moveOverlay(MOVE_STEP, 0),
  scrollUp: () => chatWin && chatWin.webContents.send('chat-scroll', -SCROLL_STEP),
  scrollDown: () => chatWin && chatWin.webContents.send('chat-scroll', SCROLL_STEP),
  ...Object.fromEntries(FOLLOW_UP_ACTIONS.map((action, index) => [action, () => pickFollowUp(index)])),
};

/** Ask the follow-up option at `index` under the newest answer. */
function pickFollowUp(index) {
  if (index >= followUpCount || !chatWin) return;
  setFollowUps(0); // the renderer is about to ask; a second press must not ask twice
  chatWin.webContents.send('chat-follow-up', { index });
}

/** Record how many follow-up options are on screen, and arm or release their hotkeys. */
function setFollowUps(count) {
  followUpCount = count;
  syncFollowUpShortcuts();
}

/** The follow-up hotkeys are live only while their options are visible in the overlay. */
function syncFollowUpShortcuts() {
  const live = followUpCount > 0 && state.overlayVisible && !state.isRecordingShortcut;
  const wanted = live
    ? FOLLOW_UP_ACTIONS.slice(0, followUpCount).map((action) => [action, state.shortcuts[action]]).filter(([, accel]) => accel)
    : [];
  const key = wanted.map(([, accel]) => accel).join('|');
  if (key === followUpKeys.join('|')) return;
  for (const accel of followUpKeys) globalShortcut.unregister(accel);
  followUpKeys = [];
  for (const [action, accel] of wanted) {
    try {
      if (globalShortcut.register(accel, ACTIONS[action])) followUpKeys.push(accel);
      else console.warn(`Could not register the ${action} shortcut (${accel}); another app may own it.`);
    } catch {
      console.warn(`The ${action} shortcut (${accel}) is not a valid accelerator.`);
    }
  }
}

/** Rebinding works by dropping every accelerator and registering the current map again. */
function registerShortcuts() {
  globalShortcut.unregisterAll();
  tabShortcutActive = false;
  const errors = [];
  // While setup is open its demos read ⌘\ and ⌘arrows from the page, so nothing global takes them.
  if (!state.isRecordingShortcut && !onboardingOpen()) {
    for (const [action, accelerator] of Object.entries(state.shortcuts)) {
      if (!accelerator || !ACTIONS[action] || FOLLOW_UP_ACTIONS.includes(action) || action === 'ask') continue;
      let ok = false;
      try {
        ok = globalShortcut.register(accelerator, ACTIONS[action]);
      } catch {
        ok = false; // malformed accelerator
      }
      if (!ok) errors.push(action);
    }
  }
  askKey = null; // unregisterAll released it
  if (syncAskShortcut() === false) errors.push('ask');
  if (errors.join() !== state.shortcutErrors.join()) {
    state = { ...state, shortcutErrors: errors };
    broadcast('shared-state-updated', state);
  }
  syncTabShortcut();
  followUpKeys = []; // unregisterAll released them; register them again if their options show
  syncFollowUpShortcuts();
}

/**
 * The ask shortcut (⌘↵ by default) is held only while the overlay is on screen. Hidden, the keys go
 * to whatever app you're in, where ⌘↵ often means send or submit. Returns false if it was wanted
 * but another app owns it.
 */
let askKey = null;
function syncAskShortcut() {
  const summoned = state.overlayVisible && chatWin && !chatWin.isDestroyed() && !state.isRecordingShortcut && !onboardingOpen();
  const wanted = summoned ? state.shortcuts.ask || null : null;
  if (wanted === askKey) return true;
  if (askKey) globalShortcut.unregister(askKey);
  askKey = null;
  if (!wanted) return true;
  try {
    if (globalShortcut.register(wanted, ACTIONS.ask)) askKey = wanted;
  } catch {
    /* malformed accelerator */
  }
  return Boolean(askKey);
}

// ---------- permissions & capture ----------

function checkPermissions() {
  const screenStatus = isMac ? systemPreferences.getMediaAccessStatus('screen') : 'granted';
  const micStatus = isMac ? systemPreferences.getMediaAccessStatus('microphone') : 'granted';
  if (screenStatus !== state.permissions.screen || micStatus !== state.permissions.microphone) {
    patchState({ permissions: { screen: screenStatus, microphone: micStatus } }, { persist: false });
  }
  return state.permissions;
}

/** macOS only shows its Screen Recording prompt once something actually asks for a source. */
async function askForScreenAccess() {
  try {
    await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
  } catch {
    /* the prompt is the point; the result does not matter */
  }
  return checkPermissions();
}

function captureSize(display) {
  const width = display.size.width * display.scaleFactor;
  const height = display.size.height * display.scaleFactor;
  const ratio = Math.min(1, MAX_CAPTURE_EDGE / Math.max(width, height));
  return { width: Math.round(width * ratio), height: Math.round(height * ratio) };
}

async function captureScreenshot() {
  let status = checkPermissions().screen;
  if (status !== 'granted') {
    // macOS reports "denied" before it has ever asked. Probing is what raises the system prompt
    // and adds the app to the Screen Recording list, so do that before giving up.
    status = (await askForScreenAccess()).screen;
  }
  if (status === 'denied' || status === 'restricted') {
    openSettings('permissions');
    throw new Error('Screen Recording permission is off. Turn it on in Settings → Permissions, then relaunch.');
  }

  // Force content protection on for the duration so the overlay never appears in its own capture.
  patchState({ isCapturingScreenshot: true }, { persist: false });
  try {
    if (!state.isInvisible) await new Promise((resolve) => setTimeout(resolve, 60));
    const anchor = chatWin && !chatWin.isDestroyed() ? chatWin : null;
    const display = anchor ? screen.getDisplayMatching(anchor.getBounds()) : screen.getPrimaryDisplay();
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: captureSize(display),
    });
    const source = sources.find((s) => s.display_id === String(display.id)) || sources[0];
    if (!source || source.thumbnail.isEmpty()) {
      throw new Error('The screen capture came back empty. Check Screen Recording in Settings → Permissions.');
    }
    const id = crypto.randomUUID();
    screenshots.clear(); // only the latest capture is ever needed
    screenshots.set(id, source.thumbnail.toPNG().toString('base64'));
    return { id };
  } finally {
    patchState({ isCapturingScreenshot: false }, { persist: false });
  }
}

// ---------- audio ----------

/** Whether Apple's engine should be tried first for the next clip. */
const useAppleSpeech = () => state.speechEngine === 'apple' && state.appleSpeech.status !== 'unavailable';

async function checkAppleSpeech() {
  if (!isMac) return;
  const { available, detail, permanent } = await checkOnDevice(SPEECH_HELPER);
  // A failed check that is not permanent (say, the model download timed out) is retried on the next clip.
  const status = available ? 'ready' : permanent ? 'unavailable' : 'error';
  patchState({ appleSpeech: { status, detail } }, { persist: false });
}

// A listening session: the live transcript of what was said, one speaker per audio source
// ('me' is the microphone, 'them' is system audio). `session` is the session in focus: the one
// being recorded, or a finished or reopened one being read, summarised or resumed. It can be
// asked about until it is closed (Back, New Chat or another session).
// Finished sessions are kept in `meetings` for this run and, with keepHistory on, in history.db.
let session = null; // { id, startedAt, durationMs, title, summary, summaryState, summaryError, entries, partial }
const meetings = new Map(); // id -> saved session (no partials), newest last
let transcribers = {}; // source -> LiveTranscriber while listening
let transcriptTimer = null;

const audio = new AudioCapture({
  helper: SPEECH_HELPER,
  onAudio: (source, pcm) => transcribers[source]?.write(pcm),
  onError: (source, message) => {
    const label = source === 'me' ? 'Microphone' : 'System audio';
    patchState({ audioNotice: `${label}: ${message}` }, { persist: false });
  },
});

const plainEntries = (entries) => entries.map(({ speaker, start, end, text }) => ({ speaker, start, end, text }));

const transcriptSnapshot = () =>
  session
    ? {
        id: session.id,
        startedAt: session.startedAt,
        durationMs: session.durationMs,
        title: session.title,
        summary: session.summary,
        summaryState: session.summaryState, // 'none' | 'pending' | 'ready' | 'failed'
        summaryError: session.summaryError,
        entries: plainEntries(session.entries),
        partial: session.partial,
      }
    : null;

/** Send the session to the overlay, at most a few times a second. */
function pushTranscript(now = false) {
  clearTimeout(transcriptTimer);
  transcriptTimer = null;
  if (now) return toChat('transcript', transcriptSnapshot());
  transcriptTimer = setTimeout(() => {
    transcriptTimer = null;
    toChat('transcript', transcriptSnapshot());
  }, 150);
}

const speechApiOptions = () => {
  const apiKey = getSpeechKey();
  return apiKey ? { apiKey, endpoint: SPEECH_ENDPOINT, model: state.speechModel || SPEECH_MODEL } : null;
};

/** `offset` is where this recording run starts on the session's clock (non-zero when resuming). */
function startTranscriber(source, offset) {
  const transcriber = new LiveTranscriber({ helper: SPEECH_HELPER, onDevice: useAppleSpeech(), api: speechApiOptions });
  const current = session;
  transcriber.on('partial', ({ text, start }) => {
    current.partial[source] = text ? { text, start: start + offset } : null;
    if (current === session) pushTranscript();
  });
  transcriber.on('final', ({ text, start, end }) => {
    current.partial[source] = null;
    if (text) {
      // Keep entries in time order; the two speakers' results arrive independently.
      const at0 = start + offset;
      let at = current.entries.length;
      while (at > 0 && current.entries[at - 1].start > at0) at -= 1;
      current.entries.splice(at, 0, { speaker: source, start: at0, end: end + offset, text, sent: false });
    }
    if (current === session) {
      if (!state.hasTranscript && current.entries.length) patchState({ hasTranscript: true }, { persist: false });
      pushTranscript();
    }
  });
  transcriber.on('fallback', (reason) => {
    patchState({ audioNotice: `Apple's speech engine failed (${reason}), so the speech API is being used.` }, { persist: false });
  });
  transcriber.on('problem', (message) => patchState({ audioNotice: message }, { persist: false }));
  transcribers[source] = transcriber;
}

/**
 * Start recording. A fresh session starts a new chat; `resume` continues the session in focus,
 * adding to its transcript and clock.
 */
async function startListening({ resume = false } = {}) {
  if (state.isListening) return;
  if (!useAppleSpeech() && !getSpeechKey()) {
    const why =
      state.speechEngine === 'apple'
        ? `Apple's speech engine is unavailable here (${state.appleSpeech.detail || 'unknown reason'}). Add a speech API key in Settings → Audio.`
        : 'Add a speech API key in Settings → Audio to use listening.';
    patchState({ audioNotice: why }, { persist: false });
    openSettings('audio');
    return;
  }
  if (isMac) {
    const granted = await systemPreferences.askForMediaAccess('microphone');
    patchState(
      { permissions: { ...state.permissions, microphone: granted ? 'granted' : 'denied' } },
      { persist: false },
    );
  }
  if (!resume || !session) {
    startNewChat(); // closes any session in focus
    session = {
      id: crypto.randomUUID(),
      startedAt: Date.now(),
      durationMs: 0,
      title: '',
      summary: '',
      summaryState: 'none',
      summaryError: '',
      entries: [],
      partial: { me: null, them: null },
    };
  }
  session.partial = { me: null, them: null };
  const offset = session.durationMs / 1000;
  startTranscriber('me', offset);
  startTranscriber('them', offset);
  pushTranscript(true);
  patchState(
    {
      isListening: true,
      listenPaused: false,
      listenClock: { base: session.durationMs, since: Date.now() },
      hasTranscript: session.entries.length > 0,
      audioNotice: '',
      overlayVisible: true,
      chatOpen: true,
    },
    { persist: false },
  );
  await audio.start();
}

function togglePause() {
  if (!state.isListening) return;
  const paused = !state.listenPaused;
  audio.paused = paused;
  const { base, since } = state.listenClock;
  const listenClock = paused ? { base: base + (since ? Date.now() - since : 0), since: null } : { base, since: Date.now() };
  patchState({ listenPaused: paused, listenClock }, { persist: false });
}

/** Stop recording. The session stays in focus; it is saved and summarised in the background. */
async function stopListening() {
  if (!state.isListening) return;
  const { base, since } = state.listenClock;
  const durationMs = base + (since ? Date.now() - since : 0);
  patchState({ isListening: false, listenPaused: false, listenClock: { base: durationMs, since: null } }, { persist: false });
  await audio.stop();
  const stopping = Object.values(transcribers);
  transcribers = {};
  await Promise.all(stopping.map((t) => t.stop())); // the last words still land in the transcript
  if (session) {
    session.partial = { me: null, them: null };
    session.durationMs = durationMs;
    patchState({ hasTranscript: session.entries.length > 0 }, { persist: false });
    if (session.entries.length) {
      saveMeeting(session);
      summarizeMeeting(session);
    }
  }
  pushTranscript(true);
}

/** Keep a finished session for this run, and in history.db when history is on. */
function saveMeeting(meeting) {
  const saved = {
    id: meeting.id,
    kind: 'meeting',
    title: meeting.title || 'Untitled session',
    summary: meeting.summary,
    entries: plainEntries(meeting.entries),
    durationMs: meeting.durationMs,
    startedAt: meeting.startedAt,
    updatedAt: Date.now(),
  };
  meetings.delete(saved.id);
  meetings.set(saved.id, saved);
  if (state.keepHistory && chatLog) {
    try {
      chatLog.saveMeeting(saved);
    } catch (err) {
      console.warn('Could not save the session:', err.message);
    }
  }
}

/** Ask the selected model for a title and a short summary, then save them. */
async function summarizeMeeting(meeting) {
  const lines = meeting.entries.map((e) => `[${clockLabel(e.start)}] ${e.speaker === 'me' ? 'Me' : 'Them'}: ${e.text}`);
  const { system, prompt } = prompts.meetingSummary(lines.join('\n'));
  const run = (meeting.summaryRun || 0) + 1;
  Object.assign(meeting, { summaryRun: run, summaryState: 'pending', summaryError: '' });
  if (meeting === session) pushTranscript(true);
  try {
    let text;
    if (state.provider === 'api') {
      const apiKey = getApiKey();
      if (!apiKey) throw new Error('Add an API key or sign in to a subscription in Settings to get summaries.');
      const reply = await new Anthropic({ apiKey }).messages.create({
        model: state.model,
        max_tokens: 2000,
        system,
        messages: [{ role: 'user', content: prompt }],
      });
      text = reply.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    } else if (state.provider === 'openai') {
      const apiKey = getSpeechKey();
      if (!apiKey) throw new Error('Add an API key or sign in to a subscription in Settings to get summaries.');
      text = await openai.complete({ apiKey, model: await openaiModel(apiKey), system, prompt });
    } else {
      text = await providers.complete(state.provider, {
        system,
        prompt,
        model: state.provider === 'claude' ? state.model : state.codexModel,
        effort: 'low',
        workDir: path.join(app.getPath('userData'), 'cli-work'),
      });
    }
    if (meeting.summaryRun !== run) return; // resumed and summarised again since
    const { title, summary } = prompts.parseMeetingSummary(text);
    Object.assign(meeting, { title: title || meeting.title || 'Untitled session', summary, summaryState: 'ready' });
    saveMeeting(meeting);
  } catch (err) {
    if (meeting.summaryRun !== run) return;
    Object.assign(meeting, { summaryState: 'failed', summaryError: describeError(err) });
  }
  if (meeting === session) pushTranscript(true);
}

/** Put a saved session in focus to read, ask about or resume. Returns its snapshot. */
async function openMeeting(id) {
  const saved = meetings.get(String(id)) || chatLog?.get(String(id));
  if (!saved || saved.kind !== 'meeting') return null;
  if (state.isListening) await stopListening();
  startNewChat();
  const ready = Boolean(saved.summary);
  session = {
    id: saved.id,
    startedAt: saved.startedAt,
    durationMs: saved.durationMs || 0,
    title: saved.title,
    summary: saved.summary || '',
    summaryState: ready ? 'ready' : 'none',
    summaryError: '',
    entries: (saved.entries || []).map((e) => ({ ...e, sent: false })),
    partial: { me: null, them: null },
  };
  patchState({ hasTranscript: session.entries.length > 0, listenClock: { base: session.durationMs, since: null } }, { persist: false });
  if (!ready && session.entries.length) summarizeMeeting(session);
  pushTranscript(true);
  return transcriptSnapshot();
}

/** Leave the session in focus and return to a plain overlay (Back). */
function closeMeeting() {
  if (state.isListening) return;
  startNewChat();
}

const clockLabel = (seconds) => {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};
const MAX_TRANSCRIPT_CHARS = 40000; // per question; the oldest lines are dropped beyond this

/**
 * The transcript to send with the next question: everything not yet sent in this chat, plus
 * words still being spoken. Earlier lines are already in the conversation, so they are not
 * repeated. Returns '' when there is nothing new.
 */
function transcriptForQuestion() {
  if (!session) return '';
  const firstTime = !session.entries.some((e) => e.sent);
  const lines = [];
  for (const entry of session.entries) {
    if (entry.sent) continue;
    entry.sent = true;
    lines.push(`[${clockLabel(entry.start)}] ${entry.speaker === 'me' ? 'Me' : 'Them'}: ${entry.text}`);
  }
  for (const source of ['them', 'me']) {
    const partial = session.partial[source];
    if (partial?.text) lines.push(`[${clockLabel(partial.start)}] ${source === 'me' ? 'Me' : 'Them'} (still speaking): ${partial.text}`);
  }
  if (!lines.length) return '';
  let text = lines.join('\n');
  if (text.length > MAX_TRANSCRIPT_CHARS) text = `…${text.slice(text.length - MAX_TRANSCRIPT_CHARS)}`;
  const heading = firstTime
    ? 'Meeting transcript so far ("Me" is the user, "Them" is everyone else on the call):'
    : 'New in the meeting transcript since the last question:';
  return `${heading}\n${text}`;
}

// ---------- chat ----------

function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) return 'The API key was rejected. Enter a valid key in Settings.';
  if (err instanceof Anthropic.PermissionDeniedError) return 'This API key cannot use the selected model.';
  if (err instanceof Anthropic.NotFoundError) return 'The selected model was not found. Check it in Settings.';
  if (err instanceof Anthropic.RateLimitError) return 'Rate limited by the API. Wait a moment and try again.';
  if (err instanceof Anthropic.APIConnectionError) return 'Could not reach the API. Check your connection.';
  if (err instanceof Anthropic.APIError) return `API error (${err.status ?? 'unknown'}): ${err.message}`;
  return err?.message || String(err);
}

// ---------- modes ----------

const activeMode = () => modeStore.get(state.mode);

/** The exact system prompt sent with questions in a mode. */
function systemPromptFor(modeId) {
  const mode = modeStore.get(modeId);
  return prompts.systemPrompt({
    modePrompt: mode.modePrompt,
    context: mode.context,
    references: modeStore.references(mode.id).text,
    followUps: state.followUps,
  });
}

const activeSystemPrompt = () => systemPromptFor(state.mode);

const pdfCache = new Map(); // stored path -> base64; stored files never change, only get removed

/** The active mode's PDFs as { name, path, base64 }. */
function referenceDocuments() {
  const docs = [];
  for (const pdf of modeStore.references(state.mode).pdfs) {
    try {
      if (!pdfCache.has(pdf.path)) pdfCache.set(pdf.path, fs.readFileSync(pdf.path).toString('base64'));
      docs.push({ ...pdf, base64: pdfCache.get(pdf.path) });
    } catch (err) {
      console.warn(`Reference file unavailable (${pdf.name}):`, err.message);
    }
  }
  return docs;
}

/**
 * For the API: the mode's PDFs as an opening exchange ahead of the conversation, marked for
 * prompt caching so they are not paid for in full on every question.
 */
function referenceMessages() {
  const docs = referenceDocuments();
  if (!docs.length) return [];
  const blocks = docs.map((doc) => ({
    type: 'document',
    source: { type: 'base64', media_type: 'application/pdf', data: doc.base64 },
    title: doc.name,
  }));
  blocks[blocks.length - 1].cache_control = { type: 'ephemeral' };
  return [
    { role: 'user', content: [...blocks, { type: 'text', text: 'These are the reference files for the current mode.' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Understood. I will use them when they are relevant.' }] },
  ];
}

/** Mirror the mode list into shared state after any change; fall back to General if needed. */
function refreshModes() {
  const patch = { modes: modeStore.list() };
  if (!modeStore.has(state.mode)) patch.mode = 'general';
  patchState(patch, { persist: 'mode' in patch });
}

const toChat = (channel, payload) => chatWin && !chatWin.isDestroyed() && chatWin.webContents.send(channel, payload);

function stopStream() {
  if (activeStream) {
    activeStream.abort();
    activeStream = null;
  }
}

async function sendChat({ question, screenshotId }) {
  setFollowUps(0); // the options belonged to the previous answer
  const apiKey = getApiKey();
  if (state.provider === 'api' && !apiKey) {
    toChat('chat-stream-error', { message: 'Add your Anthropic API key in Settings, or sign in with a subscription.', needsKey: true });
    return;
  }
  if (state.provider === 'openai' && !getSpeechKey()) {
    toChat('chat-stream-error', { message: 'Add your OpenAI API key in Settings, or sign in with a subscription.', needsKey: true });
    return;
  }
  stopStream();
  // Count questions per mode, so the overlay's mode menu can offer the ones you use most.
  patchState({ modeUsage: { ...state.modeUsage, [state.mode]: (state.modeUsage[state.mode] || 0) + 1 } });

  const image = screenshotId ? screenshots.get(screenshotId) : null;
  screenshots.delete(screenshotId);
  if (image) {
    sentShots.set(screenshotId, image);
    while (sentShots.size > MAX_SENT_SHOTS) sentShots.delete(sentShots.keys().next().value);
  }
  const asked = String(question || '').trim();

  const transcript = transcriptForQuestion();

  const content = [];
  if (image) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: image } });
  const fallback = prompts.defaultQuestion(activeMode().question, { hasContext: Boolean(image || transcript) });
  const parts = [asked || fallback];
  if (transcript) parts.push(transcript);
  content.push({ type: 'text', text: parts.join('\n\n') });
  const userMessage = { role: 'user', content };

  if (state.provider !== 'api') {
    await sendViaSubscription({ asked, image, transcript, prompt: parts.join('\n\n'), userMessage });
    return;
  }

  let stream;
  try {
    stream = new Anthropic({ apiKey }).beta.messages.stream({
      model: state.model,
      max_tokens: 16000,
      system: activeSystemPrompt(),
      output_config: { effort: state.effort },
      // If a safety classifier declines, let the API retry on a fallback model.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      messages: [...referenceMessages(), ...history, userMessage],
    });
    activeStream = stream;
    toChat('chat-stream-start', { question: asked, withScreen: Boolean(image), withAudio: Boolean(transcript) });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        toChat('chat-stream-delta', { text: event.delta.text });
      }
    }

    const final = await stream.finalMessage();
    if (activeStream !== stream) return; // superseded by a newer request
    activeStream = null;
    if (final.stop_reason === 'refusal') {
      toChat('chat-stream-error', { message: 'The model declined to answer this request.' });
      return;
    }
    history.push(userMessage, { role: 'assistant', content: final.content });
    if (history.length > MAX_HISTORY_TURNS * 2) history = history.slice(-MAX_HISTORY_TURNS * 2);
    const text = final.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    finishAnswer({ asked, text, image, truncated: final.stop_reason === 'max_tokens' });
  } catch (err) {
    if (stream && activeStream !== stream) return; // aborted by a newer request
    if (err instanceof Anthropic.APIUserAbortError) return;
    activeStream = null;
    toChat('chat-stream-error', {
      message: describeError(err),
      needsKey: err instanceof Anthropic.AuthenticationError,
    });
  }
}

/**
 * Hand a finished answer to the chat. The hidden follow-up block is split off: its options go to
 * the renderer (and arm their hotkeys), and only the visible answer is saved to history.
 */
function finishAnswer({ asked, text, image, truncated }) {
  const { answer, followUps } = prompts.splitFollowUps(text);
  const offered = state.followUps ? followUps : [];
  toChat('chat-stream-done', { truncated, followUps: offered });
  setFollowUps(offered.length);
  recordTurn({ question: asked, answer, usedScreen: Boolean(image) });
}

const providerName = (provider) => ({ claude: 'Claude', chatgpt: 'ChatGPT', openai: 'OpenAI' })[provider];

/** The chosen OpenAI model, or the newest one the key can use when none is chosen. */
async function openaiModel(apiKey) {
  return state.openaiModel || (await openai.listModels(apiKey)).defaultModel;
}

/**
 * Answer through the signed-in `claude` or `codex` CLI, billed to the user's subscription, or
 * through the OpenAI API with the user's key. Both hand back the same { abort, done } handle.
 */
async function sendViaSubscription({ asked, image, transcript, prompt, userMessage }) {
  const provider = state.provider;
  const prior = history;
  let handle;
  try {
    toChat('chat-status', { text: `Asking ${providerName(provider)}…` });
    handle =
      provider === 'openai'
        ? openai.startStream({
            apiKey: getSpeechKey(),
            model: await openaiModel(getSpeechKey()),
            system: activeSystemPrompt(),
            documents: referenceDocuments(),
            history: prior,
            userMessage,
            effort: state.effort,
            onDelta: (text) => activeStream === handle && toChat('chat-stream-delta', { text }),
          })
        : await providers.startStream(provider, {
          system: activeSystemPrompt(),
          documents: referenceDocuments(),
          history: prior,
          prompt,
          imageBase64: image,
          model: provider === 'claude' ? state.model : state.codexModel,
          effort: state.effort,
          workDir: path.join(app.getPath('userData'), 'cli-work'),
          onDelta: (text) => activeStream === handle && toChat('chat-stream-delta', { text }),
          conversation,
          turnIndex: claudeTurns,
          });
    if (provider === 'claude') claudeTurns += 1;
    activeStream = handle;
    toChat('chat-stream-start', { question: asked, withScreen: Boolean(image), withAudio: Boolean(transcript) });
    const final = await handle.done;
    if (activeStream !== handle) return;
    activeStream = null;
    if (final.refused) {
      toChat('chat-stream-error', { message: 'The model declined to answer this request.' });
      return;
    }
    history.push(userMessage, { role: 'assistant', content: [{ type: 'text', text: final.text }] });
    if (history.length > MAX_HISTORY_TURNS * 2) history = history.slice(-MAX_HISTORY_TURNS * 2);
    finishAnswer({ asked, text: final.text, image, truncated: final.truncated });
  } catch (err) {
    if (handle && activeStream !== handle) return; // aborted or superseded
    if (err.aborted) return;
    activeStream = null;
    if (err.needsSignIn) refreshAuth();
    toChat('chat-stream-error', { message: err.message || String(err), needsKey: Boolean(err.needsSignIn || err.needsKey) });
  }
}

let authCheck = null;
let cliAuth = null; // the CLIs' own status, before Waffle's disconnected list is applied

/**
 * state.auth from the CLIs' status: a subscription the user disconnected in Waffle reads as not
 * signed in (signedIn false, disconnected true) though the CLI keeps its login, so every check of
 * signedIn means "Waffle may use it" and Connect brings it back without signing in again.
 */
function applyAuth() {
  if (!cliAuth) return;
  const auth = {};
  for (const [provider, status] of Object.entries(cliAuth)) {
    const off = status.signedIn && state.disconnected.includes(provider);
    auth[provider] = off ? { ...status, signedIn: false, disconnected: true, detail: 'Disconnected from Waffle.' } : { ...status, disconnected: false };
  }
  patchState({ auth }, { persist: false });
}

/** Stop or start letting Waffle use a subscription. The CLI's own sign-in is left alone. */
function setDisconnected(provider, off) {
  const disconnected = state.disconnected.filter((p) => p !== provider).concat(off ? [provider] : []);
  patchState({ disconnected });
  applyAuth();
  if (off && state.provider === provider) {
    // Answer with something else that is ready, if there is one.
    const other = ['claude', 'chatgpt'].find((p) => state.auth[p]?.signedIn);
    const fallback = other || (state.hasKey ? 'api' : state.hasSpeechKey ? 'openai' : null);
    if (fallback) patchState({ provider: fallback });
  }
  if (!off && !providerReady() && state.auth[provider]?.signedIn) patchState({ provider });
  prewarmClaude();
}

/** Re-read both CLIs' sign-in status into state.auth. */
function refreshAuth() {
  if (authCheck) return authCheck;
  authCheck = (async () => {
    const entries = await Promise.all(
      ['claude', 'chatgpt'].map(async (provider) => {
        try {
          return [provider, { ...(await providers.status(provider)), checking: false }];
        } catch (err) {
          return [provider, { installed: false, signedIn: false, checking: false, detail: err.message }];
        }
      }),
    );
    cliAuth = Object.fromEntries(entries);
    applyAuth();
  })().finally(() => {
    authCheck = null;
  });
  return authCheck;
}

/** True when the selected provider can answer right now. */
const providerReady = () =>
  state.provider === 'api' ? state.hasKey : state.provider === 'openai' ? state.hasSpeechKey : Boolean(state.auth[state.provider]?.signedIn);

/**
 * Start the Claude Code process before the first question of a conversation, so asking doesn't
 * wait for it to boot. Follow-ups reuse the same process, which already holds the context.
 */
function prewarmClaude() {
  if (state.provider !== 'claude') return providers.closeClaude(); // free it when not in use
  if (!state.auth.claude?.signedIn) return state.auth.claude?.disconnected ? providers.closeClaude() : undefined;
  if (claudeTurns > 0) return;
  providers.prewarmClaude({
    system: activeSystemPrompt(),
    model: state.model,
    effort: state.effort,
    workDir: path.join(app.getPath('userData'), 'cli-work'),
    conversation,
  });
}

/** Save a finished question and answer into the conversation on screen. */
function recordTurn(turn) {
  if (!state.keepHistory || !chatLog) return;
  try {
    const id = chatLog.record(state.currentChatId, turn);
    if (id !== state.currentChatId) patchState({ currentChatId: id }, { persist: false });
  } catch (err) {
    console.warn('Could not save history:', err.message);
  }
}

/**
 * Reopen a saved conversation so it can be read and continued. Its text becomes the context;
 * the next question starts a fresh Claude Code process primed with it (old screenshots aren't
 * kept, so they can't be carried over).
 */
function openSavedChat(id) {
  const saved = chatLog?.get(String(id));
  if (!saved || saved.kind === 'meeting') return null;
  if (session && !state.isListening) {
    // Opening a chat takes the place of a finished session in focus.
    session = null;
    patchState({ hasTranscript: false, listenClock: { base: 0, since: null } }, { persist: false });
    pushTranscript(true);
  }
  stopStream();
  setFollowUps(0);
  providers.closeClaude();
  conversation += 1;
  claudeTurns = saved.turns.length; // the new process hasn't seen these, so it gets them as text
  screenshots.clear();
  sentShots.clear();
  history = saved.turns.slice(-MAX_HISTORY_TURNS).flatMap((t) => [
    { role: 'user', content: [{ type: 'text', text: t.question || '(asked about the screen)' }] },
    { role: 'assistant', content: [{ type: 'text', text: t.answer || '(no answer)' }] },
  ]);
  patchState({ currentChatId: saved.id }, { persist: false });
  return { id: saved.id, title: saved.title, turns: saved.turns };
}

function startNewChat() {
  stopStream();
  setFollowUps(0);
  if (state.currentChatId) patchState({ currentChatId: null }, { persist: false });
  providers.closeClaude(); // the old conversation's process exits; its memory is freed
  conversation += 1;
  claudeTurns = 0;
  prewarmClaude();
  history = [];
  screenshots.clear();
  sentShots.clear();
  toChat('chat-start-new');
  // A new chat hears the whole live session again; a finished session leaves focus.
  if (state.isListening && session) for (const entry of session.entries) entry.sent = false;
  else if (session) {
    session = null;
    patchState({ hasTranscript: false, listenClock: { base: 0, since: null } }, { persist: false });
    pushTranscript(true);
  }
}

// ---------- tray & menu ----------

/** A small diamond drawn at runtime, so the app ships no image assets. */
function trayImage() {
  const size = 32;
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (Math.abs(x - 15.5) + Math.abs(y - 15.5) <= 11) pixels.writeUInt32LE(0xff000000, (y * size + x) * 4);
    }
  }
  const image = nativeImage.createFromBitmap(pixels, { width: size, height: size, scaleFactor: 2 });
  image.setTemplateImage(true);
  return image;
}

function updateTray() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: state.overlayVisible ? 'Hide Waffle' : 'Show Waffle',
        click: () => ACTIONS.toggleOverlay(),
      },
      {
        label: 'Hide from screen sharing',
        type: 'checkbox',
        checked: state.isInvisible,
        click: () => patchState({ isInvisible: !state.isInvisible }),
      },
      {
        label: state.isListening ? 'Stop listening' : 'Start listening',
        click: () => ACTIONS.toggleListen(),
      },
      { type: 'separator' },
      { label: 'New chat', click: startNewChat },
      { label: 'Settings…', click: () => openSettings() },
      { label: 'Run setup again…', click: () => openOnboarding({ fromStart: true }) },
      { type: 'separator' },
      { label: 'Quit Waffle', click: () => app.quit() },
    ]),
  );
}

function createTray() {
  tray = new Tray(trayImage());
  tray.setToolTip('Waffle');
  updateTray();
}

function createMenu() {
  // An edit menu is what makes copy/paste/select-all work in the inputs on macOS.
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(isMac ? [{ role: 'appMenu' }] : []),
      { role: 'editMenu' },
    ]),
  );
}

// ---------- IPC ----------

const RENDERER_PATCHABLE = new Set([
  'isInvisible',
  'noFocusWhenInvisible',
  'tabToFocus',
  'chatExpanded',
  'openAtLogin',
  'useScreen',
  'provider',
  'model',
  'codexModel',
  'openaiModel',
  'effort',
  'mode',
  'keepHistory',
  'followUps',
  'speechEngine',
  'shortcuts',
  'isRecordingShortcut',
  'onboardingStep',
  'profileName',
  'speechModel',
]);

function registerIpc() {
  ipcMain.handle('get-shared-state', () => state);
  ipcMain.handle('patch-shared-state', (_event, patch) => {
    const clean = {};
    let persist = false;
    for (const [key, value] of Object.entries(patch || {})) {
      if (!RENDERER_PATCHABLE.has(key)) continue;
      const next = sanitize(key, value);
      if (next === undefined) continue;
      clean[key] = next;
      if (key in DEFAULT_STATE) persist = true;
    }
    patchState(clean, { persist });
    return state;
  });
  ipcMain.handle('update-check', () => updater.check(true));
  ipcMain.handle('update-install', () => updater.install());
  ipcMain.handle('reset-shortcuts', () => {
    patchState({ shortcuts: DEFAULT_SHORTCUTS });
    return state;
  });

  ipcMain.handle('capture-screenshot', () => captureScreenshot());
  ipcMain.handle('screenshot-preview', (_event, id) => {
    const image = sentShots.get(String(id || ''));
    return image ? `data:image/png;base64,${image}` : null;
  });
  ipcMain.on('chat-send', (_event, payload) => sendChat(payload || {}));
  ipcMain.on('chat-stop', () => {
    stopStream();
    setFollowUps(0);
  });
  ipcMain.on('chat-follow-ups-cleared', () => setFollowUps(0));
  ipcMain.on('request-chat-start-new', startNewChat);
  ipcMain.on('chat-window-resize', (_event, height, makeRoom) => resizeChat(height, makeRoom === true));
  ipcMain.on('chat-focus-input', focusChatInput);

  ipcMain.on('control-window-toggle-chat', () => patchState({ chatOpen: !state.chatOpen }, { persist: false }));
  ipcMain.on('control-window-reset-position', () => {
    patchState({ controlPosition: null });
    positionOverlay();
  });
  ipcMain.on('request-ask', () => ACTIONS.ask());
  ipcMain.on('hide-overlay', () => patchState({ overlayVisible: false }, { persist: false }));
  // Quick mode menu (the floating window under the overlay's mode button).
  ipcMain.on('mode-menu-toggle', (_event, anchor) => toggleModeMenu(anchor && typeof anchor === 'object' ? anchor : null));
  ipcMain.on('mode-menu-close', hideModeMenu);
  ipcMain.on('mode-menu-resize', (_event, height) => {
    if (!modeMenuWin || modeMenuWin.isDestroyed() || !Number.isFinite(height)) return;
    modeMenuWin.setSize(MODE_MENU_WIDTH, Math.round(Math.min(Math.max(height, 60), 480)));
  });
  ipcMain.on('mode-menu-pick', (_event, id) => {
    hideModeMenu();
    if (modeStore.has(String(id))) patchState({ mode: String(id) });
  });
  ipcMain.on('mode-menu-manage', () => {
    hideModeMenu();
    openSettings('modes');
  });
  ipcMain.on('open-settings', (_event, section) => openSettings(typeof section === 'string' ? section : undefined));
  ipcMain.on('quit-app', () => app.quit());
  // Modes: ids come from the renderer, so each handler checks them against the store.
  const modeId = (id) => {
    const value = String(id || '');
    if (!modeStore.has(value)) throw new Error('That mode no longer exists.');
    return value;
  };
  const addModeFiles = (id, paths) => {
    const added = [];
    const errors = [];
    for (const file of (Array.isArray(paths) ? paths : []).slice(0, 20)) {
      try {
        added.push(modeStore.addFile(id, String(file)));
      } catch (err) {
        errors.push(err.message);
      }
    }
    if (added.length) refreshModes();
    return { added, errors };
  };
  ipcMain.handle('modes-create', (_event, label) => {
    const id = modeStore.create(typeof label === 'string' ? label : '');
    refreshModes();
    return id;
  });
  ipcMain.handle('modes-update', (_event, id, changes) => {
    const { label, context } = changes || {};
    modeStore.update(modeId(id), { label, context });
    refreshModes();
  });
  ipcMain.handle('modes-reset', (_event, id) => {
    modeStore.reset(modeId(id));
    refreshModes();
  });
  ipcMain.handle('modes-delete', (_event, id) => {
    modeStore.remove(modeId(id));
    refreshModes();
  });
  ipcMain.handle('modes-add-files', (_event, id, paths) => addModeFiles(modeId(id), paths));
  ipcMain.handle('modes-pick-files', async (_event, id) => {
    const target = modeId(id);
    const result = await dialog.showOpenDialog(settingsWin && !settingsWin.isDestroyed() ? settingsWin : undefined, {
      title: 'Add reference files',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Reference files', extensions: FILE_TYPES.extensions }],
    });
    return result.canceled ? { added: [], errors: [] } : addModeFiles(target, result.filePaths);
  });
  ipcMain.handle('modes-remove-file', (_event, id, fileId) => {
    modeStore.removeFile(modeId(id), String(fileId || ''));
    refreshModes();
  });
  ipcMain.handle('history-list', (_event, query) => {
    const text = typeof query === 'string' ? query.slice(0, 200) : '';
    const saved = chatLog ? chatLog.list(text) : [];
    // Sessions kept only for this run (history off) are listed too.
    const known = new Set(saved.map((row) => row.id));
    const needle = text.trim().toLowerCase();
    const extra = [...meetings.values()]
      .filter((m) => !known.has(m.id))
      .filter((m) => !needle || `${m.title}\n${m.summary}\n${m.entries.map((e) => e.text).join(' ')}`.toLowerCase().includes(needle))
      .map(({ id, kind, title, startedAt, updatedAt, durationMs }) => ({ id, kind, title, startedAt, updatedAt, durationMs, turnCount: 0 }));
    return [...extra, ...saved].sort((a, b) => b.updatedAt - a.updatedAt);
  });
  ipcMain.handle('history-open', (_event, id) => openSavedChat(id));
  // The History page loads its list a page at a time as you scroll.
  ipcMain.handle('history-page', (_event, offset, limit) => {
    const from = Math.max(0, Math.floor(Number(offset) || 0));
    const size = Math.min(50, Math.max(1, Math.floor(Number(limit) || 10)));
    const { items, total } = chatLog ? chatLog.page(from, size) : { items: [], total: 0 };
    // Sessions kept only for this run (history off) come first, on the first page.
    const known = new Set(items.map((row) => row.id));
    const extra = from === 0
      ? [...meetings.values()].filter((m) => !known.has(m.id) && !chatLog?.get(m.id)).map(({ id, kind, title, startedAt, updatedAt, durationMs }) => ({ id, kind, title, startedAt, updatedAt, durationMs, turnCount: 0 }))
      : [];
    return { items: [...extra, ...items], loaded: items.length, total: total + extra.length };
  });
  ipcMain.handle('history-delete', (_event, id) => {
    const key = String(id || '');
    chatLog?.remove(key);
    meetings.delete(key);
    // A question asked next in the chat on screen starts a new saved conversation.
    if (state.currentChatId === key) patchState({ currentChatId: null }, { persist: false });
  });
  ipcMain.handle('history-clear', () => {
    chatLog?.clear();
    meetings.clear();
    if (state.currentChatId) patchState({ currentChatId: null }, { persist: false });
  });
  // macOS only applies a new Screen Recording grant to a freshly started process.
  ipcMain.on('relaunch-app', () => {
    app.relaunch();
    app.quit();
  });

  ipcMain.handle('permissions-check', () => checkPermissions());
  ipcMain.handle('permissions-ask-for-access', () => askForScreenAccess());
  // Privacy panes the Permissions page can open. Only these fixed anchors; nothing from the page
  // ends up in the URL.
  const PRIVACY_PANES = {
    screen: 'Privacy_ScreenCapture', // Screen & System Audio Recording (also covers system audio)
    microphone: 'Privacy_Microphone',
    speech: 'Privacy_SpeechRecognition',
  };
  ipcMain.on('mac-open-system-settings', (_event, pane) => {
    const anchor = PRIVACY_PANES[pane] || PRIVACY_PANES.screen;
    if (isMac) shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${anchor}`);
  });
  ipcMain.handle('permissions-ask-microphone', async () => {
    if (isMac) await systemPreferences.askForMediaAccess('microphone');
    return checkPermissions();
  });

  const refreshKeys = () =>
    patchState({ hasKey: Boolean(getApiKey()), hasSpeechKey: Boolean(getSpeechKey()) }, { persist: false });
  const setSecret = (field) => (_event, value) => {
    if (typeof value !== 'string' || !value.trim()) throw new Error('Enter a key first.');
    writeSecret(field, value.trim());
    refreshKeys();
  };
  const clearSecret = (field) => () => {
    writeSecret(field, null);
    refreshKeys();
  };
  ipcMain.handle('api-key-set', setSecret('apiKeyEnc'));
  ipcMain.handle('api-key-clear', clearSecret('apiKeyEnc'));
  ipcMain.handle('speech-key-set', setSecret('speechKeyEnc'));
  ipcMain.handle('speech-key-clear', clearSecret('speechKeyEnc'));
  ipcMain.handle('profile-photo-pick', (event) => pickProfilePhoto(BrowserWindow.fromWebContents(event.sender)));
  ipcMain.handle('profile-photo-remove', () => removeProfilePhoto());
  ipcMain.handle('profile-photo-get', () => profilePhotoDataUrl());
  ipcMain.handle('usage-refresh', () => noteUsage('chatgpt', usage.readCodexUsage()));

  const checkProvider = (provider) => {
    if (provider !== 'claude' && provider !== 'chatgpt') throw new Error('Unknown provider.');
    return provider;
  };
  ipcMain.handle('provider-refresh', () => refreshAuth());
  ipcMain.handle('provider-disconnect', (_event, provider) => setDisconnected(checkProvider(provider), true));
  ipcMain.handle('provider-connect', (_event, provider) => setDisconnected(checkProvider(provider), false));
  ipcMain.handle('provider-sign-in', async (_event, provider) => {
    checkProvider(provider);
    if (state.disconnected.includes(provider)) setDisconnected(provider, false);
    if (cliAuth?.[provider]?.signedIn) return; // still signed in to the CLI: reconnecting was enough
    await providers.openLogin(checkProvider(provider), path.join(app.getPath('userData'), 'cli-work'), (p) => shell.openPath(p));
    // Poll while the user finishes in Terminal and the browser.
    const started = Date.now();
    const poll = setInterval(async () => {
      await refreshAuth();
      if (state.auth[provider]?.signedIn || Date.now() - started > 5 * 60 * 1000) clearInterval(poll);
    }, 3000);
  });
  ipcMain.handle('provider-models', async (_event, provider) => {
    if (provider === 'openai') return openai.listModels(getSpeechKey());
    return {
      models: await providers.listModels(checkProvider(provider)),
      defaultModel: provider === 'chatgpt' ? providers.codexDefaultModel() : '',
    };
  });

  ipcMain.on('request-listen-toggle', () => ACTIONS.toggleListen());
  ipcMain.on('listen-pause-toggle', togglePause);
  ipcMain.handle('transcript-get', () => transcriptSnapshot());
  ipcMain.handle('meeting-open', (_event, id) => openMeeting(String(id || '')));
  ipcMain.on('meeting-close', closeMeeting);
  ipcMain.on('meeting-resume', () => startListening({ resume: true }));
  ipcMain.on('meeting-summarize', () => session && !state.isListening && session.entries.length && summarizeMeeting(session));
  ipcMain.handle('permissions-ask-system-audio', () => askForSystemAudio());
  ipcMain.on('onboarding-start', () => openOnboarding({ fromStart: true }));
  ipcMain.on('onboarding-finish', () => finishOnboarding());
  ipcMain.handle('apple-speech-check', async () => {
    patchState({ appleSpeech: { status: 'checking', detail: '' } }, { persist: false });
    await checkAppleSpeech();
  });
}

// ---------- lifecycle ----------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (onboardingOpen()) return onboardingWin.focus();
    patchState({ overlayVisible: true }, { persist: false });
  });

  app.whenReady().then(() => {
    carryOverFromGlint();
    modeStore = new ModeStore(app.getPath('userData'));
    loadState(); // after the mode store, so a saved custom mode is recognised
    state = { ...state, modes: modeStore.list() };
    loadProfile();
    providers.onUsage(noteUsage);
    noteUsage('chatgpt', usage.readCodexUsage()); // Codex's log has its limits from any recent use
    try {
      chatLog = createHistory(path.join(app.getPath('userData'), 'history.db'));
    } catch (err) {
      console.warn('History unavailable:', err.message); // the app works without it
    }
    if (isMac && app.dock) app.dock.setIcon(APP_ICON);
    registerIpc();
    createMenu();
    createTray();
    if (state.onboarded) createChatWindow();
    else openOnboarding(); // first launch: setup instead of the overlay
    applyState({}); // dock, login item, protection, shortcuts
    updater.start(); // packaged builds only: check now and then, download in the background
    checkPermissions();
    checkAppleSpeech();
    refreshAuth().then(() => {
      if (!state.onboarded) return; // setup picks and signs in the provider itself
      // Without a saved API key, answer with whichever subscription is already signed in.
      if ((state.provider === 'api' || state.provider === 'openai') && !providerReady()) {
        const signedIn = ['claude', 'chatgpt'].find((p) => state.auth[p]?.signedIn);
        if (signedIn) patchState({ provider: signedIn });
      }
      if (!providerReady()) openSettings();
      prewarmClaude();
    });

    for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) {
      screen.on(event, () => positionOverlay());
    }
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    stopStream();
    providers.shutdown(); // no claude or codex process outlives the app
    chatLog?.close();
    audio.stop(); // make sure the microphone helper and audiotee do not outlive the app
    for (const t of Object.values(transcribers)) t.stop(); // nor the speech helpers
  });
  app.on('window-all-closed', () => {
    /* the tray keeps the app alive */
  });
}
