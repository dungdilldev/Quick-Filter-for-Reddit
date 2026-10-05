// Quick Filter for Reddit - constants and pure helpers.
//
// No DOM or `chrome` access in this file, so it can be loaded in Node for quick checks:
//   node -e "const c = require('./src/core.js'); console.log(c.searchUrl('https://www.reddit.com/search/?q=cats', 'image'))"
// In the browser it is loaded first by the manifest and exposes `RCFCore` to the other scripts.

(function (global, factory) {
  const api = factory();
  if (typeof module !== "undefined") module.exports = api;
  else global.RCFCore = api;
})(globalThis, () => {
  "use strict";

  // ------------------------------------------------------------------ constants

  // `postTypes` match <shreddit-post post-type="..."> on feeds; `query` (search operator) or
  // `searchType` (search tab) is used on search pages.
  const TYPES = {
    all:   { label: "All" },
    image: { label: "Images", postTypes: ["image", "gallery"], query: "site:i.redd.it" },
    video: { label: "Videos", postTypes: ["video"], query: "site:v.redd.it" },
    media: { label: "Media", postTypes: ["image", "gallery", "video", "multi_media"], searchType: "media" },
    text:  { label: "Text", postTypes: ["text"], query: "self:yes" },
    link:  { label: "Links", postTypes: ["link"], query: "self:no" },
  };

  // Only operators this add-on adds are removed again - a user's own `site:` stays.
  const MANAGED_OPERATORS = /(^|\s)(site:i\.redd\.it|site:v\.redd\.it|self:(yes|no|true|false))(?=\s|$)/gi;

  const REGIONS = [
    ["", "Reddit default"], ["GLOBAL", "Everywhere"],
    ["AR", "Argentina"], ["AU", "Australia"], ["AT", "Austria"], ["BE", "Belgium"],
    ["BR", "Brazil"], ["BG", "Bulgaria"], ["CA", "Canada"], ["CL", "Chile"],
    ["CO", "Colombia"], ["HR", "Croatia"], ["CZ", "Czech Republic"], ["DK", "Denmark"],
    ["FI", "Finland"], ["FR", "France"], ["DE", "Germany"], ["GR", "Greece"],
    ["HU", "Hungary"], ["IS", "Iceland"], ["IN", "India"], ["IE", "Ireland"],
    ["IT", "Italy"], ["JP", "Japan"], ["MY", "Malaysia"], ["MX", "Mexico"],
    ["NL", "Netherlands"], ["NZ", "New Zealand"], ["NO", "Norway"], ["PH", "Philippines"],
    ["PL", "Poland"], ["PT", "Portugal"], ["PR", "Puerto Rico"], ["RO", "Romania"],
    ["RS", "Serbia"], ["SG", "Singapore"], ["ES", "Spain"], ["SE", "Sweden"],
    ["CH", "Switzerland"], ["TW", "Taiwan"], ["TH", "Thailand"], ["TR", "Turkey"],
    ["GB", "United Kingdom"], ["US", "United States"],
  ];

  const STORAGE_KEY = "rcf";
  const FILTER_ATTR = "data-rcf-type";            // on <html>: the selected content type
  const MODE_ATTR = "data-rcf-mode";              // on <html>: "only" or "block"
  const FLAIRS_ATTR = "data-rcf-flairs";          // on <html> while a flair filter is active
  const FLAIR_HIDE_ATTR = "data-rcf-flair-hide";  // on posts the flair filter hides
  const FLAIR_SEEN_ATTR = "data-rcf-flair-seen";  // on posts the flair filter has classified

  // ------------------------------------------------------------------ pages and URLs

  function pageKind(url) {
    if (/\/search\/?$/.test(url.pathname)) return "search";
    if (/\/comments\//.test(url.pathname)) return "post";
    return "feed";
  }

  // Home and r/popular (with optional sort) are the feeds Reddit applies geo_filter to.
  function supportsGeo(url) {
    return /^\/(r\/popular\/?)?((best|hot|new|top|rising)\/?)?$/.test(url.pathname);
  }

  function searchUrl(href, type) {
    const url = new URL(href);
    const def = TYPES[type];
    let q = (url.searchParams.get("q") || "").replace(MANAGED_OPERATORS, " ").replace(/\s+/g, " ").trim();
    if (def.query) q = `${q} ${def.query}`.trim();
    url.searchParams.set("q", q);
    if (def.searchType) url.searchParams.set("type", def.searchType);
    else if (url.searchParams.get("type") === "media") url.searchParams.set("type", "link");
    return url.toString();
  }

  function typeFromSearch(url) {
    if (url.searchParams.get("type") === "media") return "media";
    const q = ` ${url.searchParams.get("q") || ""} `.toLowerCase();
    const hit = Object.entries(TYPES).find(([, d]) => d.query && q.includes(` ${d.query} `));
    return hit ? hit[0] : "all";
  }

  function regionUrl(href, region) {
    const url = new URL(href);
    if (region) url.searchParams.set("geo_filter", region);
    else url.searchParams.delete("geo_filter");
    return url.toString();
  }

  // Subreddit name (lowercase) for /r/<name>/ pages; null for home, r/popular and r/all.
  function subredditOf(url) {
    const m = url.pathname.match(/^\/r\/([^/]+)/);
    if (!m) return null;
    const name = m[1].toLowerCase();
    return name === "popular" || name === "all" ? null : name;
  }

  // The subreddit whose feed this URL shows, or null (flairs only exist there).
  function feedSubreddit(url) {
    return pageKind(url) === "feed" ? subredditOf(url) : null;
  }

  // ------------------------------------------------------------------ flairs

  // Reddit's own flair links look like /r/<sub>/?f=flair_name%3A%22Some+flair%22
  function flairFromUrl(url) {
    const m = (url.searchParams.get("f") || "").match(/^flair_name:"(.*)"$/);
    return m ? m[1] : "";
  }

  // sel = { in: [...], out: [...] }. Excluded flairs are hidden; if anything is included, every
  // other post (including posts without a flair) is hidden too.
  function flairHidden(flair, sel) {
    if (flair && sel.out.includes(flair)) return true;
    return sel.in.length > 0 && !sel.in.includes(flair);
  }

  // Clicking a flair cycles it: off -> included -> excluded -> off.
  function cycleFlair(sel, name) {
    const next = { in: sel.in.filter((n) => n !== name), out: sel.out.filter((n) => n !== name) };
    if (sel.in.includes(name)) next.out.push(name);
    else if (!sel.out.includes(name)) next.in.push(name);
    return next;
  }

  // ------------------------------------------------------------------ content type

  // Posts we cannot classify stay visible rather than silently disappearing.
  // mode "only" keeps just the chosen type, mode "block" hides just the chosen type.
  function postMatches(postType, type, mode = "only") {
    if (type === "all" || !postType) return true;
    return TYPES[type].postTypes.includes(postType) === (mode === "only");
  }

  // Hiding is done in CSS, keyed on <html data-rcf-type="..." data-rcf-mode="..."> and
  // <html data-rcf-flairs>, so posts added by infinite scroll are hidden before their first paint
  // instead of flashing up and disappearing. Mirrors postMatches: posts without a post-type
  // attribute are never hidden by the content type rules.
  // Two rules, because a selector list containing :has() is dropped entirely by browsers
  // without :has() support; the first rule still hides the post itself there.
  function feedFilterCss() {
    const posts = [], wrappers = [];
    const hide = (scope, post) => {
      posts.push(`${scope} ${post}`);
      wrappers.push(`${scope} article:has(${post})`, `${scope} article:has(${post}) + hr`);
    };

    for (const [key, def] of Object.entries(TYPES)) {
      if (!def.postTypes) continue;
      const only = "shreddit-post[post-type]" + def.postTypes.map((t) => `:not([post-type="${t}"])`).join("");
      const block = def.postTypes.map((t) => `shreddit-post[post-type="${t}"]`);
      for (const [mode, selectors] of [["only", [only]], ["block", block]]) {
        const scope = `html[${FILTER_ATTR}="${key}"][${MODE_ATTR}="${mode}"]`;
        for (const post of selectors) hide(scope, post);
      }
    }

    // Flair filter: JS marks posts, and posts not yet classified stay hidden until it has.
    const flairScope = `html[${FLAIRS_ATTR}]`;
    hide(flairScope, `shreddit-post[${FLAIR_HIDE_ATTR}]`);
    hide(flairScope, `shreddit-post:not([${FLAIR_SEEN_ATTR}])`);

    return `${posts.join(",\n")} { display: none !important; }\n` +
           `${wrappers.join(",\n")} { display: none !important; }`;
  }

  // ------------------------------------------------------------------ saved state

  // Settings as stored in chrome.storage.local. Missing or malformed fields (for example from
  // an older version) fall back to defaults.
  //   flairs:   { "<subreddit>": ["Flair A", ...] }, filled automatically as flairs are detected
  //   flairSel: { "<subreddit>": { in: [...], out: [...] } }, the flairs shown / hidden there
  function normalizeState(saved) {
    const state = { type: "all", mode: "only", region: "", flairs: {}, flairSel: {}, ...saved };
    if (!TYPES[state.type]) state.type = "all";
    if (state.mode !== "block") state.mode = "only";
    if (!state.flairs || typeof state.flairs !== "object") state.flairs = {};
    if (!state.flairSel || typeof state.flairSel !== "object") state.flairSel = {};
    for (const [sub, sel] of Object.entries(state.flairSel)) {
      if (!sel || !Array.isArray(sel.in) || !Array.isArray(sel.out)) delete state.flairSel[sub];
    }
    return state;
  }

  return {
    TYPES, REGIONS, STORAGE_KEY,
    FILTER_ATTR, MODE_ATTR, FLAIRS_ATTR, FLAIR_HIDE_ATTR, FLAIR_SEEN_ATTR,
    pageKind, supportsGeo, searchUrl, typeFromSearch, regionUrl,
    subredditOf, feedSubreddit,
    flairFromUrl, flairHidden, cycleFlair,
    postMatches, feedFilterCss, normalizeState,
  };
});
