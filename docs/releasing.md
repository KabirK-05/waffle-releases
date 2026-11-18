# Releasing Waffle for Mac

Waffle is distributed outside the App Store: a signed, notarized DMG that people download from the web, plus in-app updates from GitHub Releases.

- **Build:** `electron-builder.config.js` produces one universal (Apple silicon + Intel) `Waffle.app`, signed with your Developer ID and notarized by Apple, inside `dist/Waffle.dmg`. It also makes `dist/Waffle-<version>-mac.zip` and `dist/latest-mac.yml`, which the updater uses.
- **Updates:** `updater.js` (electron-updater) checks the public repo `KabirK-05/waffle-releases` 15 seconds after launch and every 4 hours, downloads newer versions in the background, and installs them when Waffle quits. Settings → General → Software Update shows the version and has **Check for updates** / **Restart to update**.
- **Download link** (always the newest release): `https://github.com/KabirK-05/waffle-releases/releases/latest/download/Waffle.dmg`

## One-time setup

### 1. Developer ID certificate

This is the certificate for apps distributed outside the App Store. Your keychain currently has only "Apple Development" certificates, which can't be used for this.

1. Open Xcode → Settings → Accounts, select your team, click **Manage Certificates…**
2. Click **+** → **Developer ID Application**. (Only the Account Holder of the team can create it.)
3. Check that it's installed:

   ```bash
   security find-identity -v -p codesigning
   ```

   It should list `Developer ID Application: Your Name (TEAMID)`.

Back up the certificate with its private key (Keychain Access → right-click → Export → .p12). Without it you can't sign updates on another Mac.

### 2. Notarization credentials

1. App Store Connect → Users and Access → Integrations → App Store Connect API → **Team Keys** → **+**, with the Developer role.
2. Download the `.p8` file (you can only download it once) and keep it outside the repo, for example `~/.private_keys/`.
3. `cp .env.release.example .env.release` and fill in `APPLE_API_KEY` (the path to the .p8), `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`. `.env.release` is gitignored.

### 3. Public releases repo

The app's code can stay private; only the built app is published.

```bash
gh repo create KabirK-05/waffle-releases --public --description "Waffle for Mac downloads"
```

If you use a different name or account, change `publish` in `electron-builder.config.js` and the link above.

## Every release

1. Bump the version: `npm version patch --no-git-tag-version` (or `minor`). Updates only install when this number goes up.
2. Run the release:

   ```bash
   npm run release
   ```

   It builds, signs, notarizes (a few minutes while Apple scans it), and uploads `Waffle.dmg`, the ZIP and `latest-mac.yml` to a new GitHub release `v<version>`. It refuses to publish without a Developer ID certificate and notarization credentials. GitHub access comes from your `gh` login.
3. Running copies pick it up within a few hours, or at once from **Check for updates**.

To build without publishing (for example to try a signed DMG yourself): `npm run dist`. Without a certificate this makes an unsigned app that only runs on your Mac.

## Things to know

- **Don't delete a published release** that people may be updating from. Publish a fixed newer version instead.
- **Keep the same Developer ID and app id** (`com.kabirk05.waffle`). Updates are checked against the signature of the installed app, so changing either breaks updating for existing users.
- **Testing a packaged build while `npm start` is running:** Waffle is single-instance and shares its data folder with the dev build, so the packaged copy quits at once. Quit the dev copy first, or launch with a scratch folder: `dist/mac-universal/Waffle.app/Contents/MacOS/Waffle --user-data-dir=/tmp/waffle-test`.
- **Permissions** in the downloaded app belong to "Waffle" (not Electron or Terminal). macOS asks again on each user's Mac, which the onboarding covers.
