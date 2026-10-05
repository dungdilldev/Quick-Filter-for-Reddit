// Quick Filter for Reddit - the floating button and panel.
//
// Pure view: it knows nothing about Reddit pages or stored settings. `create(handlers)` builds the
// DOM (inside a Shadow DOM, so Reddit's CSS can't interfere) and `update(model)` draws whatever
// the controller in content.js describes. User actions are reported back through `handlers`.

(function (global) {
  "use strict";

  const { TYPES, REGIONS } = global.RCFCore;

  const BLOCK_PREFIX = "\u{1F6AB} ";

  const STYLE = `
    :host {
      --bg: #ffffff; --fg: #1c1c1c; --muted: #576f76; --border: #d7dadc;
      --chip: #eaedef; --accent: #d93900; --accent-fg: #ffffff;
      all: initial; position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
      font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    :host([data-theme="dark"]) {
      --bg: #1a1a1b; --fg: #d7dadc; --muted: #8ba2ad; --border: #343536;
      --chip: #272729; --accent: #ff4500;
    }
    @media (prefers-color-scheme: dark) {
      :host(:not([data-theme="light"])) {
        --bg: #1a1a1b; --fg: #d7dadc; --muted: #8ba2ad; --border: #343536;
        --chip: #272729; --accent: #ff4500;
      }
    }
    * { box-sizing: border-box; }
    .toggle {
      display: flex; align-items: center; gap: 6px; margin-left: auto;
      padding: 8px 14px; border: 0; border-radius: 999px; cursor: pointer;
      background: var(--accent); color: var(--accent-fg); font: inherit; font-weight: 600;
      box-shadow: 0 2px 8px rgb(0 0 0 / 0.25);
    }
    .toggle svg { width: 16px; height: 16px; }
    :host([data-paused]) .toggle, :host([data-paused]) .chips button[aria-pressed="true"] {
      background: var(--chip); color: var(--muted); box-shadow: none;
    }
    :host([data-paused]) .toggle { border: 1px solid var(--border); }
    .panel {
      position: absolute; right: 0; bottom: calc(100% + 8px); width: 280px; padding: 14px;
      background: var(--bg); color: var(--fg); border: 1px solid var(--border);
      border-radius: 12px; box-shadow: 0 8px 24px rgb(0 0 0 / 0.25);
    }
    .panel[hidden] { display: none; }
    .title { font-size: 12px; font-weight: 600; text-transform: uppercase;
             letter-spacing: 0.04em; color: var(--muted); margin: 0 0 8px; }
    .section + .section { margin-top: 14px; }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .flairs { max-height: 140px; overflow-y: auto; }
    .chips button {
      padding: 6px 12px; border: 0; border-radius: 999px; cursor: pointer;
      background: var(--chip); color: var(--fg); font: inherit;
    }
    .chips button[aria-pressed="true"] { background: var(--accent); color: var(--accent-fg); }
    .chips button.block { background: #b3261e; color: #ffffff; }
    .chips button:focus-visible, .clear:focus-visible, .toggle:focus-visible, select:focus-visible {
      outline: 2px solid var(--accent); outline-offset: 2px;
    }
    .clear {
      margin-top: 6px; padding: 0; border: 0; background: none; cursor: pointer;
      color: var(--accent); font: inherit; font-size: 12px; text-decoration: underline;
    }
    .clear[hidden] { display: none; }
    select {
      width: 100%; padding: 6px 8px; border: 1px solid var(--border); border-radius: 8px;
      background: var(--bg); color: var(--fg); font: inherit;
    }
    .note {
      position: absolute; right: 0; bottom: calc(100% + 8px); white-space: nowrap;
      padding: 6px 12px; border-radius: 8px; font-size: 13px;
      background: var(--bg); color: var(--muted); border: 1px solid var(--border);
      box-shadow: 0 2px 8px rgb(0 0 0 / 0.2);
    }
    .note[hidden], .panel:not([hidden]) ~ .note { display: none; }
    .hint { margin: 8px 0 0; font-size: 12px; color: var(--muted); }
    .hint a { color: var(--accent); }
  `;

  const FILTER_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 5h18l-7 8v6l-4 2v-8z"/></svg>`;

  const MARKUP = `
    <div class="panel" role="dialog" aria-label="Quick Filter for Reddit" hidden>
      <div class="section">
        <p class="title">Content type</p>
        <div class="types chips"></div>
        <p class="hint type-hint"></p>
      </div>
      <div class="section flair-section" hidden>
        <p class="title">Flair</p>
        <div class="flairs chips"></div>
        <p class="hint flair-hint"></p>
        <button class="clear flair-clear" type="button" hidden>Clear flair filter</button>
      </div>
      <div class="section">
        <p class="title">Region</p>
        <select class="region" aria-label="Region"></select>
        <p class="hint region-hint"></p>
      </div>
    </div>
    <div class="note" role="status" hidden>No matching content found</div>
    <button class="toggle" type="button" aria-expanded="false">${FILTER_ICON}<span class="label">Filter</span></button>
  `;

  function button(label) {
    const b = document.createElement("button");
    b.type = "button";
    if (label !== undefined) b.textContent = label;
    return b;
  }

  /**
   * handlers: { onType(key), onRegion(code), onFlair(name), onClearFlairs() }
   * Returns { update(model), setNoMatch(show) }.
   *
   * model = {
   *   theme: "dark" | "light" | "",   paused: boolean,
   *   label: string,                  // text of the main button
   *   type: string, blocking: boolean, typeHint: string,
   *   flair: null | { sub, names: [], included: [], excluded: [], hint },
   *   region: { value, geoPage },
   * }
   */
  function create(handlers) {
    const host = document.createElement("div");
    host.id = "reddit-quick-filter";
    const root = host.attachShadow({ mode: "open" });

    // Static markup, parsed with DOMParser rather than assigned to innerHTML (AMO lint rule).
    const style = document.createElement("style");
    style.textContent = STYLE;
    root.append(style, ...new DOMParser().parseFromString(MARKUP, "text/html").body.childNodes);

    const $ = (sel) => root.querySelector(sel);
    const els = {
      panel: $(".panel"),
      toggle: $(".toggle"),
      label: $(".label"),
      types: $(".types"),
      typeHint: $(".type-hint"),
      flairSection: $(".flair-section"),
      flairs: $(".flairs"),
      flairHint: $(".flair-hint"),
      flairClear: $(".flair-clear"),
      region: $(".region"),
      regionHint: $(".region-hint"),
      note: $(".note"),
    };

    // ---- build the parts that depend on constants

    const typeButtons = Object.entries(TYPES).map(([key, def]) => {
      const b = button(def.label);
      b.dataset.type = key;
      b.addEventListener("click", () => handlers.onType(key));
      els.types.append(b);
      return b;
    });
    for (const [code, name] of REGIONS) els.region.append(new Option(name, code));

    // ---- events

    els.region.addEventListener("change", (e) => handlers.onRegion(e.target.value));
    els.flairs.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (b) handlers.onFlair(b.dataset.flair);
    });
    els.flairClear.addEventListener("click", handlers.onClearFlairs);

    const setOpen = (open) => {
      els.panel.hidden = !open;
      els.toggle.setAttribute("aria-expanded", String(open));
    };
    els.toggle.addEventListener("click", () => setOpen(els.panel.hidden));
    document.addEventListener("click", (e) => { if (!e.composedPath().includes(host)) setOpen(false); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") setOpen(false); });

    document.documentElement.append(host);

    // ---- drawing

    function renderTypes(model) {
      els.label.textContent = model.label;
      for (const b of typeButtons) {
        const active = b.dataset.type === model.type;
        b.setAttribute("aria-pressed", String(active));
        b.classList.toggle("block", active && model.blocking);
        b.textContent = (active && model.blocking ? BLOCK_PREFIX : "") + TYPES[b.dataset.type].label;
      }
      els.typeHint.textContent = model.typeHint;
    }

    function renderFlairs(flair) {
      const sig = `${flair.sub}\n${flair.names.join("\n")}`;
      if (els.flairs.dataset.sig !== sig) {
        // Rebuilt only when the list changes; the state of each chip is refreshed below.
        els.flairs.dataset.sig = sig;
        els.flairs.replaceChildren(...flair.names.map((name) => {
          const b = button();
          b.dataset.flair = name;
          return b;
        }));
      }
      for (const b of els.flairs.children) {
        const name = b.dataset.flair;
        const included = flair.included.includes(name), excluded = flair.excluded.includes(name);
        b.setAttribute("aria-pressed", String(included || excluded));
        b.classList.toggle("block", excluded);
        b.textContent = (excluded ? BLOCK_PREFIX : "") + name;
      }
      els.flairClear.hidden = !(flair.included.length || flair.excluded.length);
      els.flairHint.textContent = flair.hint;
    }

    function renderRegion(region) {
      els.region.value = region.value;
      if (region.geoPage) {
        els.regionHint.textContent = "Remembered for Home and r/popular.";
      } else {
        const link = document.createElement("a");
        link.href = "/r/popular/";
        link.textContent = "r/popular";
        els.regionHint.replaceChildren("Applies to Home and ", link, ".");
      }
    }

    return {
      update(model) {
        host.toggleAttribute("data-paused", model.paused);
        host.dataset.theme = model.theme;
        renderTypes(model);
        els.flairSection.hidden = !model.flair;
        if (model.flair) renderFlairs(model.flair);
        renderRegion(model.region);
      },
      setNoMatch(show) { els.note.hidden = !show; },
    };
  }

  global.RCFUi = { create };
})(globalThis);
