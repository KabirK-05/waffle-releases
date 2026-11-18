// Builds Waffle for distribution: `npm run dist` (into dist/) or `npm run release` (also uploads
// to a GitHub release, which installed copies update from).
//
// Loads Apple's notarization credentials from .env.release when it exists (see
// .env.release.example), rebuilds the speech helper as a universal binary, then runs
// electron-builder. Prints no secrets.

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const publish = process.argv.includes('--publish');

const envFile = path.join(root, '.env.release');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const identities = (() => {
  try {
    return execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
  } catch {
    return '';
  }
})();
const signed = identities.includes('Developer ID Application');
const notarized = Boolean(process.env.APPLE_API_KEY || process.env.APPLE_ID);

if (!signed) {
  if (publish) {
    console.error('No "Developer ID Application" certificate in your keychain. Updates only work for signed builds, so nothing was published. See docs/releasing.md.');
    process.exit(1);
  }
  console.warn('No "Developer ID Application" certificate found: building an UNSIGNED app (fine for testing on this Mac only).');
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
} else if (!notarized) {
  if (publish) {
    console.error('No notarization credentials (.env.release). macOS would block the download, so nothing was published.');
    process.exit(1);
  }
  console.warn('Signing without notarization: other Macs will refuse to open this build. Add .env.release to notarize.');
}

if (publish && !process.env.GH_TOKEN) {
  try {
    process.env.GH_TOKEN = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
  } catch {
    console.error('Publishing needs GitHub access: run `gh auth login`, or set GH_TOKEN in .env.release.');
    process.exit(1);
  }
}

execFileSync(process.execPath, [path.join(__dirname, 'build-speech.js')], { stdio: 'inherit' });
if (!fs.existsSync(path.join(root, 'bin', 'waffle-speech'))) {
  console.error('bin/waffle-speech was not built, so the app would have no microphone. Install the Xcode command line tools.');
  process.exit(1);
}

// Build outside the project folder. When it sits in an iCloud-synced folder (Desktop or
// Documents), iCloud tags every file with Finder metadata and codesign refuses to sign them
// ("resource fork, Finder information, or similar detritus not allowed"). The finished DMG,
// ZIP and latest-mac.yml are copied back into dist/.
const out = path.join(os.homedir(), 'Library', 'Caches', 'waffle-build');
fs.rmSync(out, { recursive: true, force: true });

const builder = path.join(root, 'node_modules', 'electron-builder', 'cli.js');
const args = [
  '--mac',
  '--config', 'electron-builder.config.js',
  `-c.directories.output=${out}`,
  '--publish', publish ? 'always' : 'never',
];
const result = spawnSync(process.execPath, [builder, ...args], { cwd: root, stdio: 'inherit', env: process.env });
if (result.status !== 0) process.exit(result.status ?? 1);

const dist = path.join(root, 'dist');
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });
for (const name of fs.readdirSync(out)) {
  if (/\.(dmg|zip|yml|blockmap)$/.test(name) && name !== 'builder-debug.yml') fs.copyFileSync(path.join(out, name), path.join(dist, name));
}
console.log(`Done: dist/${fs.readdirSync(dist).filter((n) => n.endsWith('.dmg')).join(', ')} (app bundle in ${out}/mac-universal)`);
