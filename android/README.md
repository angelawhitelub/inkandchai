# Ink & Chai — Android app (Trusted Web Activity)

The app is not a rewrite. It is Android chrome around inkandchai.in: the same
pages, the same checkout, the same admin panel behind the same login. Ship a fix
to the site and every installed app has it, with no store review.

That also means the app can only ever be as good as the site is on a phone, and
that a service worker bug ships to the app too. See the header of the PWA block
in `generate_site.py` for what the worker refuses to touch, and its kill switch.

## What is already live

| Piece | Where |
|---|---|
| Web app manifest | `public/manifest.json` |
| Service worker | generated to `public/sw.js`, registered on every page except `/admin/` |
| Offline page | generated to `public/offline/` |
| Icons (any + maskable) | `public/images/icon-*.png` |
| Digital Asset Links | `public/.well-known/assetlinks.json` — **fingerprint still a placeholder** |

The site is installable right now: Chrome on Android already offers "Add to
home screen", and that install is the same standalone experience the store build
will give. Worth telling customers about while the Play listing is in review.

## Build the app bundle

Needs Node 18+. Bubblewrap downloads the JDK and Android SDK itself on first run.

```bash
npm install -g @bubblewrap/cli
mkdir -p ~/inkandchai-twa && cd ~/inkandchai-twa
bubblewrap init --manifest=https://inkandchai.in/manifest.json
```

`init` asks a series of questions. The answers that matter:

- **Package name** — `in.inkandchai.app`. This is permanent. It cannot be changed
  after the first upload without publishing a different app, and it must match
  `package_name` in `assetlinks.json`.
- **Signing key** — let it create one. Back up `android.keystore` and its two
  passwords somewhere you will still have them in three years.
- Everything else can be accepted; `twa-manifest.json` in this directory holds
  the values we want and can be copied over the generated one to skip the
  prompts.

Then:

```bash
bubblewrap build
```

You get `app-release-bundle.aab` (upload this to Play) and
`app-release-signed.apk` (install this on a phone to test).

## The fingerprint, and the order it has to happen in

A TWA that cannot verify its domain still runs — it just runs with a browser
address bar across the top, which makes it look like a website in a cheap
wrapper. Verification comes from `assetlinks.json` matching the certificate the
app was signed with.

The catch: with Play App Signing, Google re-signs your upload, so the
certificate that reaches a phone is **Google's, not yours** — and it does not
exist until the first upload. So:

1. Upload the `.aab` to Play Console (internal testing track is fine).
2. Play Console → Test and release → Setup → **App integrity** → App signing key
   certificate → copy the **SHA-256** fingerprint.
3. Back in this repo:
   ```bash
   node scripts/set-assetlinks-fingerprint.js <the SHA-256 you copied>
   npm run deploy
   ```
4. Reinstall the app and confirm there is no address bar.

Using the *upload* key's fingerprint here is the single most common reason a TWA
ships with a visible URL bar. It has to be the app signing key.

## Play Console — what will actually gate the launch

The build is the easy half. Budget for these:

- **Developer account**: $25, one time. Identity verification usually takes a
  day or two and can take longer.
- **Closed testing requirement**: a *personal* developer account registered after
  13 November 2023 must run a closed test with a minimum number of testers
  (currently 12) opted in **continuously for 14 days** before it may even apply
  for production access. An *organisation* account — the kind registered with a
  company name and D-U-N-S number — is exempt. Check which kind the account is
  before planning a launch date; this one rule decides whether the app can be
  public this week or in three.
- **Data safety form**: the shop collects name, address, phone, email and
  payment information. It has to be declared, and the declaration has to match
  what the site actually does.
- **Privacy policy URL**: https://inkandchai.in/privacy-policy/ (already live).
- **Content rating** questionnaire.
- **Store listing**: icon and feature graphic are in `android/play-assets/`.
  Screenshots are not — take them on a real phone once the APK installs, which
  is what Play wants anyway. Two is the minimum; four or five sell better.
- **Review**: a few days for a new app.

## Updating later

Site changes need nothing. Only a change to the manifest, the icons, or the app
name needs a new bundle: bump `appVersionCode` in `twa-manifest.json`, run
`bubblewrap update && bubblewrap build`, upload.
