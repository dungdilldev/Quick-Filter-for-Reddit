// Quick Filter for Reddit - controller (runs on reddit.com, after src/core.js and src/ui.js).
//
// What it does, by page kind (see pageKind in src/core.js):
//   * search pages: rewrites the URL with Reddit's own search operators / tabs
//     (site:i.redd.it, site:v.redd.it, self:yes, self:no, type=media)
//   * feeds (home, popular, subreddits): hides posts of unwanted content types / flairs with CSS,
//     including posts loaded later by infinite scroll
//   * post pages: the filter is paused
// Region sets Reddit's ?geo_filter=<CODE> parameter on pages that honour it.
//
// Layout of this file: state -> content type -> region -> flairs -> feed filter -> view model
// -> navigation -> start.

(() => {
  "use strict";

  const {
    TYPES, STORAGE_KEY, FILTER_ATTR, MODE_ATTR, FLAIRS_ATTR, FLAIR_HIDE_ATTR, FLAIR_SEEN_ATTR,
    pageKind, supportsGeo, searchUrl, typeFromSearch, regionUrl,
    subredditOf, feedSubreddit, flairFromUrl, flairHidden, cycleFlair,
    postMatches, feedFilterCss, normalizeState,
  } = globalThis.RCFCore;

  const DEBOUNCE_MS = 50;           // batching of DOM mutation bursts
  const QUIET_MS = 2000;            // no new posts for this long = loading has stopped
  const GEO_GUARD_KEY = "rcf-geo";  // sessionStorage: last automatic region redirect
  const GEO_GUARD_MS = 10_000;
  const MAX_FLAIRS_PER_SUB = 200;

  // ------------------------------------------------------------------ state

  let state = normalizeState();  // persisted settings, see normalizeState
  let hiddenCount = 0;           // posts currently hidden on this page (shown in the panel)
  let flairFilterOn = false;     // a flair filter is active on the current page
  let lastHref = "";             // URL last handled by onUrlChange
  let view;                      // the panel, see src/ui.js

  const currentUrl = () => new URL(location.href);
  const save = () => chrome.storage.local.set({ [STORAGE_KEY]: state });
  const flairSelection = (sub) => state.flairSel[sub] || { in: [], out: [] };

  // What the content type button shows: the URL on search pages, the saved choice on feeds.
  function activeType(url) {
    const kind = pageKind(url);
    return kind === "search" ? typeFromSearch(url) : kind === "feed" ? state.type : "all";
  }

  function setHiddenCount(n) {
    if (n === hiddenCount) return;
    hiddenCount = n;
    render();
  }

  // ------------------------------------------------------------------ content type

  function selectType(type) {
    const url = currentUrl();
    if (pageKind(url) === "search") {
      location.assign(searchUrl(url.href, type));
      return;
    }
    // On feeds, clicking the active type again cycles: only -> block -> off.
    if (type !== "all" && type === state.type) {
      if (state.mode === "only") state.mode = "block";
      else { state.type = "all"; state.mode = "only"; }
    } else {
      state.type = type;
      state.mode = "only";
    }
    save();
    render();
    applyFeedFilter();
  }

  // ------------------------------------------------------------------ region

  function selectRegion(region) {
    state.region = region;
    save();
    const url = currentUrl();
    if (supportsGeo(url)) location.assign(regionUrl(url.href, region));
    else render();
  }

  // Re-apply the remembered region when Reddit navigates to a feed without one.
  // Guarded so a server-side redirect that drops the parameter cannot cause a reload loop.
  function maybeApplyRememberedRegion(url) {
    if (!state.region || !supportsGeo(url) || url.searchParams.has("geo_filter")) return false;
    const target = regionUrl(url.href, state.region);
    try {
      const last = JSON.parse(sessionStorage.getItem(GEO_GUARD_KEY) || "{}");
      if (last.target === target && Date.now() - last.at < GEO_GUARD_MS) return false;
      sessionStorage.setItem(GEO_GUARD_KEY, JSON.stringify({ target, at: Date.now() }));
    } catch {
      return false;
    }
    location.replace(target);
    return true;
  }

  // ------------------------------------------------------------------ flairs

  // Flair text of one <shreddit-post-flair>; the link's ?f= value is the exact name when present.
  function flairName(el) {
    const link = el.querySelector("a[href*='flair_name']");
    return (link && flairFromUrl(new URL(link.href, location.origin))) ||
           el.textContent.replace(/\s+/g, " ").trim();
  }

  function postFlair(post) {
    const el = post.querySelector("shreddit-post-flair");
    return el ? flairName(el) : "";
  }

  // Adds newly seen flair names to the subreddit's saved list.
  function addFlairs(sub, names) {
    const list = state.flairs[sub] || (state.flairs[sub] = []);
    const fresh = [...new Set(names)].filter((n) => n && !list.includes(n));
    if (!fresh.length) return;
    list.push(...fresh);
    list.splice(MAX_FLAIRS_PER_SUB);
    save();
    render();
  }

  // Flairs of the posts currently loaded in a subreddit feed.
  function scanFlairs() {
    const sub = feedSubreddit(currentUrl());
    if (!sub) return;
    addFlairs(sub, [...document.querySelectorAll("shreddit-post-flair")].map(flairName));
  }

  // The subreddit's full flair list, once per subreddit and page load. Needs no permission
  // (same origin) and may be refused for logged-out users, in which case scanning still works.
  const flairFetched = new Set();
  async function fetchFlairs(sub) {
    if (flairFetched.has(sub)) return;
    flairFetched.add(sub);
    try {
      const res = await fetch(`/r/${encodeURIComponent(sub)}/api/link_flair_v2.json`, { credentials: "same-origin" });
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data)) {
        addFlairs(sub, data.map((f) => (typeof f.text === "string" ? f.text.trim() : "")));
      }
    } catch {
      // keep going with scanned flairs only
    }
  }

  // Applies a change to the current subreddit's flair selection, then refreshes.
  function changeFlairSelection(change) {
    const sub = subredditOf(currentUrl());
    if (!sub) return;
    change(sub);
    save();
    applyFeedFilter();
    render();
  }

  const selectFlair = (name) =>
    changeFlairSelection((sub) => { state.flairSel[sub] = cycleFlair(flairSelection(sub), name); });
  const clearFlairs = () =>
    changeFlairSelection((sub) => { delete state.flairSel[sub]; });

  // ------------------------------------------------------------------ feed filter

  // The CSS from feedFilterCss does the hiding; this switches it on and off, marks posts for the
  // flair filter, and counts what is hidden.
  function applyFeedFilter() {
    const url = currentUrl();
    const feed = pageKind(url) === "feed";
    const type = feed ? state.type : "all";
    const sub = feedSubreddit(url);
    const sel = sub ? flairSelection(sub) : null;
    flairFilterOn = !!sel && (sel.in.length > 0 || sel.out.length > 0);

    setTypeAttributes(type);
    scanFlairs();
    const { hidden, total } = classifyPosts(type, sel);
    // Set after the posts are classified (same task, so no paint in between).
    document.documentElement.toggleAttribute(FLAIRS_ATTR, flairFilterOn);

    setHiddenCount(hidden);
    updateNoMatchNote((type !== "all" || flairFilterOn) && total > 0 && hidden === total, total);
  }

  function setTypeAttributes(type) {
    const html = document.documentElement;
    if (type === "all") {
      html.removeAttribute(FILTER_ATTR);
      html.removeAttribute(MODE_ATTR);
    } else {
      if (html.getAttribute(FILTER_ATTR) !== type) html.setAttribute(FILTER_ATTR, type);
      if (html.getAttribute(MODE_ATTR) !== state.mode) html.setAttribute(MODE_ATTR, state.mode);
    }
  }

  // Marks posts for the flair filter (CSS does the hiding) and counts how many posts are hidden
  // by either filter.
  function classifyPosts(type, flairSel) {
    let hidden = 0, total = 0;
    for (const post of document.querySelectorAll("shreddit-post")) {
      total++;
      let hide = type !== "all" && !postMatches(post.getAttribute("post-type"), type, state.mode);
      if (flairFilterOn) {
        const flairHide = flairHidden(postFlair(post), flairSel);
        post.toggleAttribute(FLAIR_HIDE_ATTR, flairHide);
        post.setAttribute(FLAIR_SEEN_ATTR, "");
        hide = hide || flairHide;
      }
      if (hide) hidden++;
    }
    return { hidden, total };
  }

  // Reddit exposes no "end of feed" signal, so loading counts as stopped once the number of
  // posts has stayed the same for a while. Only then is the "No matching content" note shown.
  let quietTimer = null, lastTotal = 0;
  function updateNoMatchNote(nothingVisible, total) {
    if (!nothingVisible || total !== lastTotal) {
      clearTimeout(quietTimer);
      quietTimer = null;
      view.setNoMatch(false);
    }
    lastTotal = total;
    if (nothingVisible && !quietTimer) quietTimer = setTimeout(() => view.setNoMatch(true), QUIET_MS);
  }

  // ------------------------------------------------------------------ view model

  function typeHint(kind, type, paused, blocking) {
    if (kind === "search") return "Adds Reddit's search filter to your query.";
    if (kind === "feed") {
      if (type === "all") return "Click a type to show only it, click again to block it.";
      return `${hiddenCount} post(s) hidden on this page. ` +
             (blocking ? "Click again to turn off." : "Click again to block this type instead.");
    }
    return paused ? "Paused while viewing a post; active again in the feed."
                  : "Applies to feeds and search results.";
  }

  function flairModel(sub) {
    const sel = flairSelection(sub);
    const names = [...new Set([...(state.flairs[sub] || []), ...sel.in, ...sel.out])]
      .sort((a, b) => a.localeCompare(b));
    return {
      sub,
      names,
      included: sel.in,
      excluded: sel.out,
      hint: names.length ? "Click to show, again to hide, again to reset."
                         : "No flairs detected yet; scroll to find more.",
    };
  }

  // Everything the panel needs to draw itself, derived from the URL, the saved state and the page.
  function buildModel() {
    const url = currentUrl();
    const kind = pageKind(url);
    // On a post page the filter does nothing, but it is still shown (dimmed) so it doesn't
    // look like the choice was lost.
    const paused = kind === "post" && state.type !== "all";
    const type = kind === "post" ? state.type : activeType(url);
    const blocking = kind !== "search" && type !== "all" && state.mode === "block";
    const classes = document.documentElement.classList;
    const sub = feedSubreddit(url);
    const geoPage = supportsGeo(url);

    return {
      theme: classes.contains("theme-dark") ? "dark" : classes.contains("theme-light") ? "light" : "",
      paused,
      type,
      blocking,
      label: type === "all" ? "Filter" : `${blocking ? "No " : ""}${TYPES[type].label}`,
      typeHint: typeHint(kind, type, paused, blocking),
      flair: sub ? flairModel(sub) : null,
      region: {
        value: geoPage ? (url.searchParams.get("geo_filter") || state.region) : state.region,
        geoPage,
      },
    };
  }

  const render = () => view.update(buildModel());

  // ------------------------------------------------------------------ navigation

  function onUrlChange() {
    lastHref = location.href;
    const url = currentUrl();
    if (maybeApplyRememberedRegion(url)) return;
    const sub = feedSubreddit(url);
    if (sub) fetchFlairs(sub);
    render();
    applyFeedFilter();
  }

  // Batches bursts of DOM mutations. A timer rather than requestAnimationFrame, because
  // rAF is paused in background tabs while Reddit keeps loading posts.
  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      if (location.href !== lastHref) onUrlChange();
      else applyFeedFilter();
    }, DEBOUNCE_MS);
  }

  // Reddit is a single-page app with no navigation event, so watch the DOM. URL changes are
  // handled synchronously (observer callbacks run before paint), so the feed filter switches
  // on/off together with Reddit's client-side navigation.
  function watchPage() {
    new MutationObserver(() => {
      if (location.href !== lastHref) onUrlChange();
      // Flair filtering classifies posts itself, so it must run before the next paint.
      else if (flairFilterOn) applyFeedFilter();
      else schedule();
    }).observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener("popstate", schedule);
  }

  // ------------------------------------------------------------------ start

  function injectPageStyle() {
    const style = document.createElement("style");
    style.textContent = feedFilterCss();
    document.head.append(style);
  }

  chrome.storage.local.get(STORAGE_KEY, (saved) => {
    state = normalizeState(saved && saved[STORAGE_KEY]);
    view = globalThis.RCFUi.create({
      onType: selectType,
      onRegion: selectRegion,
      onFlair: selectFlair,
      onClearFlairs: clearFlairs,
    });
    injectPageStyle();
    onUrlChange();
    watchPage();
  });
})();
