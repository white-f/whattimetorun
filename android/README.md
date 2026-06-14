# When to run? — Android (WebView wrapper)

A native Android shell that bundles the web app and displays it in a full-screen
`WebView`. All the actual logic lives in the web files; this project just packages
them into an installable APK.

## What's inside

```
android/
├── app/
│   ├── build.gradle                 app module config (minSdk 26, targetSdk 36)
│   └── src/main/
│       ├── AndroidManifest.xml      INTERNET permission, launcher activity
│       ├── java/.../MainActivity.java   the WebView shell
│       ├── assets/                  COPY of index.html, styles.css, script.js
│       └── res/                     icon, theme, strings, colors
├── build.gradle / settings.gradle   project + plugin config (AGP 9.2.1)
└── gradle/wrapper/                  Gradle 9.4.1 wrapper config
```

> **Note:** the web files in `app/src/main/assets/` are generated automatically from
> the repo root by the `syncWebAssets` Gradle task, which runs before every build.
> The root `index.html` / `styles.css` / `script.js` are the single source of truth —
> edit those and just rebuild; the copy is refreshed for you (and is git-ignored).

## Requirements to build

- **Android Studio** (latest) — easiest path; or
- **JDK 17** + **Android SDK** (cmdline-tools) for a command-line build.

This repository does not include the Gradle wrapper JAR (a binary). Android Studio
generates it automatically when you open the project; or run `gradle wrapper` once if
you have a system Gradle installed.

## Build & run

### Android Studio
1. **File → Open** → select the `android/` folder.
2. Let it sync (it downloads Gradle 9.4.1 + the SDK packages it needs).
3. Press **Run ▶** with an emulator or USB device connected.

### Command line
```bash
cd android
# first time only, if you don't have the wrapper jar yet:
gradle wrapper
# debug APK:
./gradlew assembleDebug
# output: app/build/outputs/apk/debug/app-debug.apk
./gradlew installDebug   # install onto a connected device
```

## Updating the web app

Just edit the root `index.html` / `styles.css` / `script.js` and rebuild — the
`syncWebAssets` Gradle task copies them into `app/src/main/assets/` before every
build automatically. To refresh them without a full build:
```bash
cd android && ./gradlew syncWebAssets
```

## Publishing to Google Play

Play requires a **signed Android App Bundle (`.aab`)**. Signing credentials are read
from `keystore.properties` (git-ignored); see `keystore.properties.example` for the
format.

### 1. Create your upload key (one time)

```bash
cd android
~/android-studio/jbr/bin/keytool -genkeypair -v \
  -keystore upload-keystore.jks -alias upload \
  -keyalg RSA -keysize 2048 -validity 10000
```

> **Back up `upload-keystore.jks` and its password.** With Play App Signing this is
> only the *upload* key (recoverable if lost), but losing it still blocks updates
> until you reset it with Google.

### 2. Point the build at it

```bash
cp keystore.properties.example keystore.properties
# then edit keystore.properties with your real storePassword / keyPassword / alias
```

### 3. Build the signed bundle

```bash
cd android
./gradlew bundleRelease
# output: app/build/outputs/bundle/release/app-release.aab
```

(Android Studio alternative: **Build → Generate Signed App Bundle**, which can also
create the keystore for you.)

### 4. Play Console (one-time account work)

- Create a developer account (**$25 one-time** + ID verification).
- Create the app and complete the **store listing**: 512×512 icon, 1024×500 feature
  graphic, ≥2 phone screenshots, short + full descriptions.
- Complete the required forms: **content rating**, **data safety**, target audience,
  ads declaration, and a **privacy policy URL**.
- Upload `app-release.aab`, opt into **Play App Signing**, and submit for review.

> **Heads-up:** new *personal* developer accounts must run a **closed test with ≥12
> testers for 14 continuous days** before they can apply for production release.

## Notes

- `targetSdk` is 36 to meet Play's recent-API-level requirement for new apps.
- `INTERNET` permission is required because the app calls the Open-Meteo forecast and
  geocoding APIs (both HTTPS, with permissive CORS, so they work from the
  `file://` WebView origin).
- `domStorageEnabled` is on so the app's `localStorage` settings persist.
- Min SDK is 26 (Android 8.0) which lets the launcher icon be a pure-XML adaptive
  icon with no raster assets.
