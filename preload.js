// A typed, allow-listed bridge. Renderers never get raw ipcRenderer access.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (channel) => (handler) => {
  const listener = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('waffle', {
  platform: process.platform,

  // shared state
  getState: () => ipcRenderer.invoke('get-shared-state'),
  patchState: (patch) => ipcRenderer.invoke('patch-shared-state', patch),
  resetShortcuts: () => ipcRenderer.invoke('reset-shortcuts'),

  // software updates (status is state.update)
  checkForUpdates: () => ipcRenderer.invoke('update-check'),
  installUpdate: () => ipcRenderer.invoke('update-install'),
  onState: on('shared-state-updated'),

  // overlay windows
  requestAsk: () => ipcRenderer.send('request-ask'),
  toggleChat: () => ipcRenderer.send('control-window-toggle-chat'),
  resetPosition: () => ipcRenderer.send('control-window-reset-position'),
  hideOverlay: () => ipcRenderer.send('hide-overlay'),
  // quick mode menu
  toggleModeMenu: (anchor) =>
    ipcRenderer.send('mode-menu-toggle', {
      x: Number(anchor?.x) || 0,
      y: Number(anchor?.y) || 0,
      width: Number(anchor?.width) || 0,
      height: Number(anchor?.height) || 0,
    }),
  closeModeMenu: () => ipcRenderer.send('mode-menu-close'),
  resizeModeMenu: (height) => ipcRenderer.send('mode-menu-resize', Number(height)),
  pickMode: (id) => ipcRenderer.send('mode-menu-pick', String(id)),
  manageModes: () => ipcRenderer.send('mode-menu-manage'),
  onModeMenuOpened: on('mode-menu-opened'),
  resizeChat: (height, makeRoom) => ipcRenderer.send('chat-window-resize', Number(height), makeRoom === true),
  focusChatInput: () => ipcRenderer.send('chat-focus-input'),
  openSettings: (section) => ipcRenderer.send('open-settings', section),
  quit: () => ipcRenderer.send('quit-app'),
  relaunch: () => ipcRenderer.send('relaunch-app'),

  // chat
  captureScreenshot: () => ipcRenderer.invoke('capture-screenshot'),
  screenshotPreview: (id) => ipcRenderer.invoke('screenshot-preview', String(id || '')),
  sendChat: (payload) => ipcRenderer.send('chat-send', payload),
  stopChat: () => ipcRenderer.send('chat-stop'),
  clearFollowUps: () => ipcRenderer.send('chat-follow-ups-cleared'),
  newChat: () => ipcRenderer.send('request-chat-start-new'),
  listHistory: (query) => ipcRenderer.invoke('history-list', String(query || '')),
  openHistory: (id) => ipcRenderer.invoke('history-open', String(id)),
  clearHistory: () => ipcRenderer.invoke('history-clear'),
  deleteHistory: (id) => ipcRenderer.invoke('history-delete', String(id || '')),
  historyPage: (offset, limit) => ipcRenderer.invoke('history-page', Number(offset) || 0, Number(limit) || 10),
  onSubmit: on('chat-submit'),
  onStartNew: on('chat-start-new'),
  onFocusInput: on('chat-focus-input'),
  onBlurInput: on('chat-blur-input'),
  onScroll: on('chat-scroll'),
  onFollowUp: on('chat-follow-up'),
  onStreamStart: on('chat-stream-start'),
  onStreamDelta: on('chat-stream-delta'),
  onStreamDone: on('chat-stream-done'),
  onStreamError: on('chat-stream-error'),

  // audio
  toggleListen: () => ipcRenderer.send('request-listen-toggle'),
  togglePause: () => ipcRenderer.send('listen-pause-toggle'),
  getTranscript: () => ipcRenderer.invoke('transcript-get'),
  onTranscript: on('transcript'),
  openMeeting: (id) => ipcRenderer.invoke('meeting-open', String(id || '')),
  closeMeeting: () => ipcRenderer.send('meeting-close'),
  resumeMeeting: () => ipcRenderer.send('meeting-resume'),
  summarizeMeeting: () => ipcRenderer.send('meeting-summarize'),
  setSpeechKey: (apiKey) => ipcRenderer.invoke('speech-key-set', String(apiKey || '')),
  clearSpeechKey: () => ipcRenderer.invoke('speech-key-clear'),
  checkAppleSpeech: () => ipcRenderer.invoke('apple-speech-check'),
  onStatus: on('chat-status'),

  // permissions
  checkPermissions: () => ipcRenderer.invoke('permissions-check'),
  askForScreenAccess: () => ipcRenderer.invoke('permissions-ask-for-access'),
  openSystemSettings: (pane) => ipcRenderer.send('mac-open-system-settings', String(pane || 'screen')),
  askForMicrophone: () => ipcRenderer.invoke('permissions-ask-microphone'),
  askForSystemAudio: () => ipcRenderer.invoke('permissions-ask-system-audio'),

  // first-run setup (renderer/onboarding.html)
  startOnboarding: () => ipcRenderer.send('onboarding-start'),
  finishOnboarding: () => ipcRenderer.send('onboarding-finish'),

  // modes
  createMode: (label) => ipcRenderer.invoke('modes-create', String(label || '')),
  updateMode: (id, changes) => ipcRenderer.invoke('modes-update', String(id), changes),
  resetMode: (id) => ipcRenderer.invoke('modes-reset', String(id)),
  deleteMode: (id) => ipcRenderer.invoke('modes-delete', String(id)),
  pickModeFiles: (id) => ipcRenderer.invoke('modes-pick-files', String(id)),
  // Dropped files carry no path in a sandboxed page; webUtils looks it up from the File object.
  addModeFiles: (id, files) =>
    ipcRenderer.invoke('modes-add-files', String(id), Array.from(files || [], (file) => webUtils.getPathForFile(file)).filter(Boolean)),
  removeModeFile: (id, fileId) => ipcRenderer.invoke('modes-remove-file', String(id), String(fileId)),

  // settings
  setApiKey: (apiKey) => ipcRenderer.invoke('api-key-set', String(apiKey || '')),
  pickProfilePhoto: () => ipcRenderer.invoke('profile-photo-pick'),
  removeProfilePhoto: () => ipcRenderer.invoke('profile-photo-remove'),
  getProfilePhoto: () => ipcRenderer.invoke('profile-photo-get'),
  refreshUsage: () => ipcRenderer.invoke('usage-refresh'),
  clearApiKey: () => ipcRenderer.invoke('api-key-clear'),
  refreshProviders: () => ipcRenderer.invoke('provider-refresh'),
  signInProvider: (provider) => ipcRenderer.invoke('provider-sign-in', String(provider)),
  connectProvider: (provider) => ipcRenderer.invoke('provider-connect', String(provider)),
  disconnectProvider: (provider) => ipcRenderer.invoke('provider-disconnect', String(provider)),
  listModels: (provider) => ipcRenderer.invoke('provider-models', String(provider)),
  onSettingsNavigate: on('settings-navigate'),
});
