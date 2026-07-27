# SkipSensei

Browser extension that detects the anime episode you're watching and adds a skip-intro button. Timestamps come from the AniSkip database when available; otherwise you can mark them yourself and the extension remembers for next time.

## How it works

When you open an episode page, the extension pulls the series title and episode number, then queries the AniSkip API to check if intro timestamps are already known. If so, the button shows up with the right timing automatically. If not, you mark the start and end of the intro yourself once, and it's saved locally for the next episodes of the same series.

Auto-skip (the video jumps automatically) is off by default — the button stays available for a manual click, and you can turn on auto mode in the settings if you want.

## Installation

The extension isn't published on the Chrome Web Store, so install it in developer mode:

1. Download this repo (`Code` → `Download ZIP`, or `git clone https://github.com/Adoto24/skipsensei.git`)
2. Extract the folder if you grabbed the ZIP
3. Open `chrome://extensions`
4. Enable developer mode (top right)
5. Click "Load unpacked" and select the folder
6. Done, it's active

## Limitations

- Only works on sites where the `<video>` player is directly accessible on the page (not tested on all sites/iframes)
- Series name detection depends on the page title format — might not work perfectly on every site

## License

This project is under a noncommercial-use license — see the `LICENSE` file. Personal use is free, commercial use is not allowed without permission.

## Contributing

Found a bug or a site that doesn't work? Open an issue.
