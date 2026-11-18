// In-app updates for the packaged Mac app (electron-updater, Squirrel.Mac underneath).
//
// Releases are published to GitHub by `npm run release` (see electron-builder.config.js). A
// running copy checks shortly after launch and every few hours, downloads a newer version in
// the background, and installs it when Waffle quits, or straight away from Settings → General →
// Restart to update. Updates only work in a signed build; a dev run (`npm start`) reports 'dev'.
//
// Status, mirrored into shared state as `update`:
//   { state, version, available, percent, error }
//   state: 'dev' | 'idle' | 'checking' | 'downloading' | 'ready' | 'latest' | 'error'

const { app } = require('electron');

const FIRST_CHECK_MS = 15_000;
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

function createUpdater({ onChange }) {
  let status = {
    state: app.isPackaged ? 'idle' : 'dev',
    version: app.getVersion(),
    available: '',
    percent: 0,
    error: '',
  };
  let manual = false; // errors from background checks stay quiet; a click shows them
  let updater = null;

  const set = (patch) => {
    status = { ...status, ...patch };
    onChange(status);
  };

  function setup() {
    if (updater || !app.isPackaged) return updater;
    ({ autoUpdater: updater } = require('electron-updater'));
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
    updater.logger = null;
    updater.on('checking-for-update', () => {
      if (status.state !== 'downloading' && status.state !== 'ready') set({ state: 'checking', error: '' });
    });
    updater.on('update-not-available', () => set({ state: manual ? 'latest' : 'idle' }));
    updater.on('update-available', (info) => set({ state: 'downloading', available: info.version, percent: 0 }));
    updater.on('download-progress', (progress) => {
      const percent = Math.floor(progress.percent);
      if (percent !== status.percent) set({ state: 'downloading', percent });
    });
    updater.on('update-downloaded', (info) => set({ state: 'ready', available: info.version, percent: 100 }));
    updater.on('error', (err) => {
      if (status.state === 'ready') return; // a later check failing does not undo a finished download
      set(manual ? { state: 'error', error: friendly(err) } : { state: 'idle' });
    });
    return updater;
  }

  /** Check now. `fromUser` shows the result (up to date, or the error) in Settings. */
  function check(fromUser = false) {
    if (!setup() || status.state === 'downloading' || status.state === 'ready') return status;
    manual = fromUser;
    updater.checkForUpdates().catch(() => {}); // reported through the 'error' event
    return status;
  }

  /** Quit and install a downloaded update; Waffle reopens on the new version. */
  function install() {
    if (status.state === 'ready') setImmediate(() => updater.quitAndInstall(false, true));
  }

  function start() {
    onChange(status);
    if (!app.isPackaged) return;
    setTimeout(() => check(false), FIRST_CHECK_MS).unref();
    setInterval(() => check(false), CHECK_EVERY_MS).unref();
  }

  return { start, check, install, status: () => status };
}

function friendly(err) {
  const text = String(err?.message || err);
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network/i.test(text)) return "Couldn't reach the update server. Check your connection.";
  if (/code signature|signature/i.test(text)) return 'The update failed its signature check, so it was not installed.';
  if (/404|latest-mac\.yml/i.test(text)) return 'No published release was found.';
  return text.split('\n')[0].slice(0, 160);
}

module.exports = { createUpdater };
