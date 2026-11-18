// Builds bin/waffle-speech, the helper that transcribes audio with Apple's on-device speech
// engine (native/waffle-speech.swift). Runs after npm install and via `npm run build:speech`.
// Skips quietly where it cannot build (not macOS, or no Swift compiler), because Waffle then
// falls back to the speech API.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const source = path.join(root, 'native', 'waffle-speech.swift');
const output = path.join(root, 'bin', 'waffle-speech');

if (process.platform !== 'darwin') {
  console.log('waffle-speech: skipped (macOS only).');
  process.exit(0);
}

fs.mkdirSync(path.dirname(output), { recursive: true });
try {
  // A universal binary (Apple silicon and Intel), so one download works on every Mac.
  // Deployment target 14 so the helper launches on older macOS and reports that it needs 26.
  const slices = ['arm64', 'x86_64'].map((arch) => {
    const slice = `${output}-${arch}`;
    execFileSync('xcrun', ['swiftc', '-O', '-target', `${arch}-apple-macos14.0`, '-o', slice, source], { stdio: 'inherit' });
    return slice;
  });
  execFileSync('lipo', ['-create', '-output', output, ...slices], { stdio: 'inherit' });
  for (const slice of slices) fs.rmSync(slice);
  console.log(`waffle-speech: built ${path.relative(root, output)} (universal)`);
} catch (err) {
  console.warn(`waffle-speech: not built (${err.message.split('\n')[0]}). Install the Xcode command line tools (xcode-select --install), then run npm run build:speech.`);
}
