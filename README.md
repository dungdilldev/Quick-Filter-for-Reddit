# Quick Filter for Reddit

A browser extension that adds a floating **Filter** button to Reddit, so you can show only the posts you want and hide the ones you don't.

*Unofficial. Not affiliated with or endorsed by Reddit.*

## Features

- **Content type**: All, Images, Videos, Media, Text, Links. Click a type to show only that type, click it again to **block** it instead (shown in red), and a third time to switch it off.
  - On feeds (home, popular, subreddits) other posts are hidden before they appear, including posts loaded by infinite scrolling.
  - On search pages the extension rewrites the search with Reddit's own filters (`site:i.redd.it`, `site:v.redd.it`, `self:yes`, `self:no`, `type=media`). Your own search operators are kept. Blocking is not available in search.
  - If nothing in a feed matches, a small "No matching content found" note appears.
- **Flair** (subreddit pages): the flairs of each subreddit are detected automatically and listed as chips. Click a flair to show it, click again to hide it, click again to reset. Combine as many as you like. Selections are remembered per subreddit.
- **Region**: sets Reddit's `geo_filter` (e.g. GLOBAL, DE, US) on Home and r/popular and re-applies it when you come back.

## Install

- **Firefox**: install from Firefox Add-ons (link to be added after publication).
- **From source (Chrome / Edge / Brave)**: open `chrome://extensions`, enable Developer mode, click **Load unpacked** and select this folder. Chrome shows a harmless warning about the Firefox-only `browser_specific_settings` key.
- **From source (Firefox)**: open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on…** and select `manifest.json`. Temporary add-ons are removed when Firefox restarts.

Works on `www.reddit.com` and `sh.reddit.com`. `old.reddit.com` is not supported.

## Privacy

The extension collects no data and sends nothing to any server. Your settings and the detected flair lists are stored locally in your browser (`storage`). The only network request it makes is to reddit.com itself, to fetch a subreddit's flair list.

## License

[MIT](LICENSE)
