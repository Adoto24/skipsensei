# SkipSensei (Chrome extension — Manifest V3)

Multi-site extension that displays a floating "Skip Intro" button on video
pages, and lets you record/edit intro timings per series via a popup.

## Supported sites

| Site | Matched domains | Adapter (`content.js`) |
| --- | --- | --- |
| Anime-Sama | `anime-sama.to` | `extraireNomSerieAnimeSama` / `extraireEpisodeAnimeSama` |
| VoirAnime | `voiranime.rip` | `extraireNomSerieVoiranime` / `extraireEpisodeVoiranime` |

## Why two content scripts?

On anime-sama.to, the video is **not** directly on the page: it is loaded
in an `<iframe id="playerDF">` pointing to a different third-party site
depending on the "Player" chosen (Player 1 to 5 depending on the
episode). Domains observed on anime-sama.to (VOSTFR and VF, dozens of
series):

- `vidmoly.to` / `vidmoly.biz`
- `video.sibnet.ru`
- `sendvid.com`
- `ansembed.net`
- `smoothpre.com`
- `oneupload.to`
- `lpayer.embed4me.com`
- `movearnpre.com`
- `uqload.is`
- `minochinos.com`
- `www.myvi.top` / `www.myvi.tv`
- `vk.com` / `vkvideo.ru` (`/video_ext.php` path only)

The first three (vidmoly/sibnet/sendvid) are the most frequent "main"
players; the others mostly show up as a fallback player on isolated
episodes where the main player is unavailable — hence the value of
covering all of them rather than just the 3 most visible ones.

A content script cannot read the contents of an iframe from a
**different domain** (browser security: same-origin policy). Two
separate scripts are therefore needed, communicating with each other via
`window.postMessage`:

```
anime-sama.to (main page)                iframe (vidmoly / sibnet / sendvid)
┌─────────────────────────────┐          ┌───────────────────────────────┐
│ content.js                  │          │ player-frame.js               │
│ - reads document.title      │  postMessage  │ - finds <video>          │
│ - resolves AniSkip timing   │ ────────────► │ - displays + positions   │
│ - stores/reads chrome.storage│ ◄──────────── │   the floating button   │
│                              │  postMessage  │   on the video, handles │
│                              │               │   clicks                │
└─────────────────────────────┘          └───────────────────────────────┘
```

The floating button itself lives in `player-frame.js`, not `content.js`:
an element added on the main page can't appear "on top of" the video
anyway once the (cross-origin) iframe goes fullscreen — only the subtree
of the fullscreen element is rendered.

## Project structure

```
anime-skip-intro/
├── manifest.json     → declares the TWO content scripts (see below)
├── content.js        → runs on the anime site: resolves timing + series name
├── player-frame.js   → runs INSIDE the player iframe: finds/controls <video> + floating button
├── popup.html        → popup UI (dashboard, stats, history)
├── popup.js          → popup logic (read/edit/delete)
├── popup.css         → popup styling
├── icons/            → extension icons (16/32/48/128, generated, accent style)
└── README.md         → this file
```

In `manifest.json`, note the two `content_scripts` blocks:

1. A block matching `anime-sama.to` → injects `content.js` + `content.css`
   (default behavior: main frame only).
2. A block matching player domains (`vidmoly.biz`, etc.) with
   `"all_frames": true` → injects `player-frame.js` **inside the
   iframe**, regardless of which site embedded it. Without
   `all_frames: true`, Chrome would only inject this script if those
   domains were opened as a tab's main page, never inside an iframe.

## Page title format (already handled)

On anime-sama.to, the tab title looks like:

```
One Piece - Saga 1 (East Blue) | Anime-Sama - Streaming et catalogage d'animes et scans.
```

`extraireNomSerie()` in `content.js` splits on the first `" - "` and thus
gets `"one piece"`. This works as-is for this site.

## Loading the extension in developer mode

1. Open Chrome and go to `chrome://extensions/`.
2. Enable **"Developer mode"** in the top right.
3. Click **"Load unpacked"**.
4. Select the `anime-skip-intro` folder (the one containing
   `manifest.json`).
5. Go to an anime-sama.to episode: the floating button should appear in
   the bottom right once the video loads in the iframe.

## Reloading the extension after a change

After every change to any file, go back to `chrome://extensions/` and
click the reload icon (🔄) for the extension. For `popup.html` /
`popup.js`, simply closing/reopening the popup is enough.

## How the floating button works

The button is built and positioned by `player-frame.js`, anchored at the
bottom right of the `<video>` element itself (Netflix-style), not the
whole page. `content.js` still resolves the timing and sends it via
`postMessage` (`set-skip-data`); the button responds the same way
(`skip-performed` / `mark-intro-end`) so that `content.js` can record
stats/history.

- No timing recorded for the detected series → **"🏁 Mark intro end"**
  button, always visible. A click reads `video.currentTime` directly
  (same document) and sends it to `content.js`, which records it as the
  intro end (`fin`) for this series, with `debut: 0` by default.
- A timing already exists → **"⏭ Skip Intro"** button, visible only from
  0.5s before the intro start until its end (plus a few seconds after a
  skip, while playback actually resumes). A click does
  `video.currentTime = timing.fin` directly.
- The `debut` field is not editable from the page itself: it can be
  adjusted manually from the popup if needed.
- In fullscreen, the button only appears if the player puts a container
  around the video into fullscreen (the case for video.js, confirmed on
  sibnet) and not the `<video>` tag itself directly — in that second
  case, no element can be injected into it, a browser limitation and not
  a bug in the extension.

## If a video player adds/changes domain

If a player loads a new domain not yet listed, just add that domain to
the `matches` array of the second `content_scripts` block in
`manifest.json` (and to `DOMAINES_LECTEUR_CONNUS` in `content.js` if you
want to explicitly prefer it over the first iframe found), then reload
the extension.

## If a site adds/changes domain (mirror)

1. Add the domain to the first `content_scripts` block in
   `manifest.json` (main page).
2. Add an entry to `ADAPTATEURS_SITE` (`content.js`), reusing the site's
   existing adapter object if it's just a new mirror.
3. Reload the extension and check on a real episode that the series name
   + episode number are detected correctly (`console.log`
   `[SkipSensei]` in the tab's console).

## Known limitations / improvement ideas

- Detection is instant in most cases (a `change` listener on the episode
  `<select>` + a debounced `MutationObserver` on the iframe's
  appearance), with polling every 3 seconds kept only as a safety net
  for changes not covered by either of those two.
- If one of the third-party players itself nests another internal
  iframe, `player-frame.js` won't traverse it automatically (check on a
  case-by-case basis if "Mark intro end" doesn't respond on a given
  player).
- Auto-skip already exists (toggle in the popup, executed by
  `player-frame.js`) and a manual "Skip Intro" button remains available.
  Keyboard shortcuts on the page (S / M / A) — see `RACCOURCIS_CLAVIER`
  in `content.js`.
