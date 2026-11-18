# Distributing Waffle

How to ship a new version of Waffle for Mac. Written so an AI agent session can do it end to end.
For the one-time setup (certificate, notarization key, releases repo) see [docs/releasing.md](docs/releasing.md).

## How distribution works

- Waffle ships **outside the App Store**: a universal (Apple silicon + Intel) app, signed with a Developer ID certificate, notarized by Apple, and published as a GitHub release on **`KabirK-05/waffle-releases`**. That repo is public and also holds the source.
- **Download link**, always the newest release: `https://github.com/KabirK-05/waffle-releases/releases/latest/download/Waffle.dmg`. The landing page (`web/lib/links.ts`) and the README point here.
- **Updates:** installed copies run `updater.js` (electron-updater). It reads `latest-mac.yml` from the latest release 15 seconds after launch and then every 4 hours. It downloads the ZIP in the background and installs it on quit, or straight away from Settings → General → Software Update → **Restart to update**.
- An update is offered only when `version` in `package.json` is **higher** than the installed one. Publishing a release is therefore what ships an update; no code change is needed in installed apps.

## Ship a new version

Run everything from the project root. Node 22+ is required; this machine's default Node is older, so prefix commands with `fnm exec --using=24`.

1. **Check that you're starting from a clean, committed main.**

   ```bash
   git status --short        # must show nothing you didn't mean to ship
   node --check main.js       # plus any other edited .js files; there's no test suite
   ```

   Commit the feature work first (end commit messages with the attribution lines the session asks for).

2. **Bump the version.** Use patch for fixes and small changes, minor for features.

   ```bash
   fnm exec --using=24 npm version patch --no-git-tag-version
   git add package.json package-lock.json
   git commit -m "Waffle X.Y.Z"
   git push origin main
   ```

3. **Build, sign, notarize and publish.** This takes about 5–15 minutes, most of it waiting for Apple's notarization. Run it in the background.

   ```bash
   fnm exec --using=24 npm run release
   ```

   `scripts/dist.js` does all of this:
   - Loads `.env.release` (gitignored) with the App Store Connect API key used for notarization.
   - Refuses to publish without a "Developer ID Application" certificate in the keychain or without notarization credentials.
   - Gets GitHub access from `gh auth token`.
   - Rebuilds `bin/waffle-speech` as a universal binary.
   - Creates release `v<version>` as a **draft**, so installed copies can't see it yet.
   - Runs electron-builder in `~/Library/Caches/waffle-build`. It builds there because the project is on the iCloud-synced Desktop, and codesign rejects the Finder metadata iCloud adds.
   - Uploads `Waffle.dmg`, `Waffle-<version>-mac.zip`, `latest-mac.yml` and the blockmaps.
   - Checks that the DMG, ZIP and yml are all there, then publishes the draft and marks it Latest.
   - Copies the artifacts into `dist/`.

   A successful run ends with `Published vX.Y.Z: https://github.com/KabirK-05/waffle-releases/releases/tag/vX.Y.Z`.

4. **Verify the release.** Don't report success without these checks.

   ```bash
   # the release is published (not a draft) with all five files, and listed as Latest
   gh release view vX.Y.Z -R KabirK-05/waffle-releases --json isDraft,assets --jq '{isDraft,assets:[.assets[].name]}'
   gh release list -R KabirK-05/waffle-releases -L 3

   # the update feed installed copies read reports the new version
   curl -sL https://github.com/KabirK-05/waffle-releases/releases/latest/download/latest-mac.yml | head -3

   # the public download is notarized: expect "accepted" and "source=Notarized Developer ID"
   mkdir -p /tmp/waffle-check && cd /tmp/waffle-check
   curl -sLo Waffle.dmg https://github.com/KabirK-05/waffle-releases/releases/latest/download/Waffle.dmg
   hdiutil attach -nobrowse -readonly -mountpoint /tmp/waffle-check/mnt Waffle.dmg >/dev/null
   spctl -a -vv -t exec /tmp/waffle-check/mnt/Waffle.app
   defaults read /tmp/waffle-check/mnt/Waffle.app/Contents/Info.plist CFBundleShortVersionString
   hdiutil detach /tmp/waffle-check/mnt >/dev/null; cd - >/dev/null; rm -rf /tmp/waffle-check
   ```

## If something goes wrong

| Symptom | Fix |
| --- | --- |
| `vX.Y.Z is already published` | Bump the version again (step 2). Never reuse a published version. |
| `Not published: the draft is missing …` | Run `npm run release` again. It reuses the draft and re-uploads. |
| `No "Developer ID Application" certificate` | The certificate isn't in the login keychain. That needs the user (Xcode → Settings → Accounts → Manage Certificates), so ask them. |
| `No notarization credentials` | `.env.release` is missing or empty. Ask the user; see `.env.release.example`. |
| Notarization rejected or times out | Read the electron-builder output for Apple's log URL. Usually it's an unsigned helper binary: check `asarUnpack` and `x64ArchFiles` in `electron-builder.config.js`. |
| codesign: "resource fork, Finder information … not allowed" | Something built inside the iCloud-synced project folder. Keep the build output in `~/Library/Caches/waffle-build`. |
| `gh` errors / 401 | Run `gh auth status`; the user may need to run `gh auth login`. |

## Rules

- **Never commit or print secrets:** `.env.release`, the `.p8` key, `GH_TOKEN`. They stay out of the repo and out of logs and chat.
- **Never delete or replace a published release** that people may be updating from. Ship a fixed newer version instead.
- **Keep the app id (`com.kabirk05.waffle`) and the Developer ID team the same.** Updates are checked against the installed app's signature, so changing either breaks updating for everyone.
- **Never publish an unsigned or unnotarized build.** The script refuses; don't work around it.
- **Testing a packaged build** while `npm start` is running: Waffle is single-instance per data folder, so launch it with a scratch folder, `--user-data-dir=/tmp/waffle-test`.
- **Releasing is outward-facing:** do it only when the user asks for a release or distribution.
