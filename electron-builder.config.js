// Packaging for macOS: a signed, notarized, universal (Apple silicon + Intel) Waffle.app inside
// a DMG for people to download, plus a ZIP that electron-updater uses for in-app updates.
//
//   npm run dist      build into dist/ (signed and notarized when credentials are present)
//   npm run release   build and upload to a GitHub release, which running copies update from
//
// Signing uses the "Developer ID Application" certificate in your keychain. Notarization reads
// Apple credentials from the environment (see .env.release.example and docs/releasing.md).

const notarize = Boolean(process.env.APPLE_API_KEY || process.env.APPLE_ID);

module.exports = {
  appId: 'com.kabirk05.waffle',
  productName: 'Waffle',
  copyright: `Copyright © ${new Date().getFullYear()} Kabir Kumar`,
  directories: { output: 'dist', buildResources: 'build' },
  files: [
    'package.json',
    '*.js',
    '!electron-builder.config.js',
    'renderer/**',
    'assets/**',
    'bin/waffle-speech',
  ],
  // Executables cannot run from inside the asar archive.
  asarUnpack: ['bin/waffle-speech', 'node_modules/audiotee/bin/**'],
  mac: {
    category: 'public.app-category.productivity',
    icon: 'assets/icon.icns',
    target: [
      { target: 'dmg', arch: ['universal'] },
      { target: 'zip', arch: ['universal'] }, // electron-updater installs from the ZIP
    ],
    artifactName: 'Waffle-${version}-mac.${ext}', // the ZIP; the DMG names itself below
    minimumSystemVersion: '14.0',
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    notarize,
    // These binaries are already universal (or one per arch, side by side) and identical in both
    // halves of the universal build, so they are copied as they are instead of merged.
    x64ArchFiles: 'Contents/Resources/app.asar.unpacked/**',
    extendInfo: {
      NSMicrophoneUsageDescription: 'Waffle transcribes your microphone while you are listening to a meeting.',
      NSAudioCaptureUsageDescription: 'Waffle transcribes the other people on a call while you are listening to a meeting.',
      NSScreenCaptureUsageDescription: 'Waffle reads your screen when you ask it a question.',
    },
  },
  dmg: {
    title: 'Waffle ${version}',
    // A fixed name, so the website can always link to
    // https://github.com/KabirK-05/waffle-releases/releases/latest/download/Waffle.dmg
    artifactName: 'Waffle.dmg',
  },
  // Releases live in a separate public repo so the app's code can stay private.
  publish: { provider: 'github', owner: 'KabirK-05', repo: 'waffle-releases', releaseType: 'draft' },
};
