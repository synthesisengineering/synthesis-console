/*
 * Synthesis Console client script (3.0).
 *
 * Plain JavaScript, no framework, no build step. Event delegation only.
 * Sections:
 *   1. Preferences: theme, projects view
 *   2. Shell: drawer, source picker
 *   3. Command palette
 *   4. Live status: sync, context, conformance, autopilot
 *   5. Drafts: copy, edit, save, email, send-to-Slack modal
 *   6. One-tap queue: skip, undo skip, edit, approve
 *   7. Cockpit: decisions, tasks, filters, find, file-change refresh, rail
 */
(function () {
  'use strict';

  var root = document.documentElement;
  var COOKIE = root.getAttribute('data-sources-cookie') || 'sc_sources';

  function store(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch (_) {}
  }
  function read(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
  }
  function escapeText(s) {
    var div = document.createElement('div');
    div.textContent = s == null ? '' : String(s);
    return div.innerHTML;
  }

  /* ===================================================================
     1. Preferences
     =================================================================== */

  function currentThemeChoice() {
    var t = read('sc_theme');
    return t === 'light' || t === 'dark' ? t : 'system';
  }

  function applyTheme(choice) {
    if (choice === 'light' || choice === 'dark') root.setAttribute('data-theme', choice);
    else root.removeAttribute('data-theme');
    document.querySelectorAll('[data-theme-choice]').forEach(function (btn) {
      btn.setAttribute('aria-pressed', btn.getAttribute('data-theme-choice') === choice ? 'true' : 'false');
    });
  }

  applyTheme(currentThemeChoice());

  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('[data-theme-choice]');
    if (!btn) return;
    var choice = btn.getAttribute('data-theme-choice');
    store('sc_theme', choice === 'system' ? null : choice);
    applyTheme(choice);
  });

  // Projects: cards or a dense table, remembered per browser.
  function applyProjectsView(view) {
    if (view === 'table') root.setAttribute('data-projects-view', 'table');
    else root.removeAttribute('data-projects-view');
    document.querySelectorAll('[data-set-view]').forEach(function (btn) {
      btn.setAttribute('aria-pressed', btn.getAttribute('data-set-view') === (view || 'cards') ? 'true' : 'false');
    });
  }
  applyProjectsView(read('sc_projects_view') === 'table' ? 'table' : 'cards');
  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('[data-set-view]');
    if (!btn) return;
    var view = btn.getAttribute('data-set-view');
    store('sc_projects_view', view === 'table' ? 'table' : null);
    applyProjectsView(view);
  });

  /* ===================================================================
     2. Shell
     =================================================================== */

  var app = document.querySelector('.app');
  var sidebar = document.getElementById('app-sidebar');
  var menuBtn = document.querySelector('.menu-btn');
  var scrim = document.querySelector('.app-scrim');

  function drawerOpen() { return app && app.getAttribute('data-sidebar') === 'open'; }

  function openDrawer() {
    if (!app) return;
    app.setAttribute('data-sidebar', 'open');
    if (scrim) scrim.hidden = false;
    if (menuBtn) menuBtn.setAttribute('aria-expanded', 'true');
    var target = sidebar && (sidebar.querySelector('.nav-link[aria-current="page"]') || sidebar.querySelector('.nav-link'));
    if (target) setTimeout(function () { target.focus(); }, 30);
  }

  function closeDrawer(returnFocus) {
    if (!app || !drawerOpen()) return;
    app.setAttribute('data-sidebar', 'closed');
    if (menuBtn) menuBtn.setAttribute('aria-expanded', 'false');
    setTimeout(function () { if (scrim && !drawerOpen()) scrim.hidden = true; }, 220);
    if (returnFocus && menuBtn) menuBtn.focus();
  }

  if (menuBtn) menuBtn.addEventListener('click', function () { drawerOpen() ? closeDrawer(true) : openDrawer(); });
  if (scrim) scrim.addEventListener('click', function () { closeDrawer(true); });
  var closeBtn = document.querySelector('.sidebar-close');
  if (closeBtn) closeBtn.addEventListener('click', function () { closeDrawer(true); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && drawerOpen() && !document.querySelector('.palette-overlay')) {
      var picker = document.querySelector('details.source-picker[open]');
      if (picker) return; // the picker's own Escape handler closes it first
      closeDrawer(true);
    }
  });

  // Source picker: the selection is a view boundary for the whole app.
  function setCookie(value) {
    // Cookie lasts 1 year. Local-only tool; no Secure/HttpOnly needed.
    document.cookie = COOKIE + '=' + encodeURIComponent(value) + '; path=/; max-age=31536000; samesite=lax';
  }

  function currentSelection() {
    return Array.from(document.querySelectorAll('input[type=checkbox][name=source]'))
      .filter(function (cb) { return cb.checked; })
      .map(function (cb) { return cb.value; });
  }

  var picker = document.querySelector('details.source-picker');
  if (picker) {
    picker.addEventListener('click', function (e) {
      if (e.target && e.target.closest && e.target.closest('.source-apply')) {
        var names = currentSelection();
        setCookie(names.join(','));
        store(COOKIE, names.join(','));
        // Reload to re-fetch content for the new selection.
        var url = new URL(window.location.href);
        url.hash = 'main-content';
        url.searchParams.delete('sources');
        window.location.href = url.toString();
      }
    });
    picker.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && picker.open) {
        picker.open = false;
        picker.querySelector('summary').focus();
        e.preventDefault();
        e.stopPropagation();
      }
    });
    document.addEventListener('click', function (e) {
      if (picker.open && !picker.contains(e.target)) picker.open = false;
    });
  }

  // On first visit with no cookie but a remembered selection, sync and reload.
  try {
    if (!document.cookie.split('; ').some(function (c) { return c.indexOf(COOKIE + '=') === 0; })) {
      var cached = localStorage.getItem(COOKIE);
      if (cached) {
        setCookie(cached);
        window.location.reload();
      }
    }
  } catch (_) {}

  /* ===================================================================
     3. Command palette
     =================================================================== */

  var palette = null;          // { overlay, input, list, items, active, opener }
  var paletteData = null;      // fetched once per page from /api/palette
  var paletteFetch = null;

  function navItems() {
    return Array.from(document.querySelectorAll('.sidebar-nav a.nav-link')).map(function (a) {
      var label = a.querySelector('.nav-label');
      var group = a.closest('.nav-group');
      var groupLabel = group ? group.querySelector('.nav-group-label') : null;
      return {
        label: label ? label.textContent : a.textContent,
        hint: groupLabel ? groupLabel.textContent : '',
        href: a.getAttribute('href'),
        icon: a.querySelector('svg') ? a.querySelector('svg').outerHTML : '',
      };
    });
  }

  function svg(paths) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>';
  }
  var ICON_SEARCH = svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-4.2-4.2"/>');
  var ICON_FOLDER = svg('<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2.2 2.2h7.3A2.5 2.5 0 0 1 21 9.7v7.8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5Z"/>');
  var ICON_TARGET = svg('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.2"/>');
  var ICON_BULB = svg('<path d="M9.5 18h5M10.5 21h3"/><path d="M12 3a6 6 0 0 0-3.7 10.7c.7.6 1.2 1.4 1.2 2.3h5c0-.9.5-1.7 1.2-2.3A6 6 0 0 0 12 3Z"/>');
  var ICON_CAL = svg('<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>');
  var ICON_CHAT = svg('<path d="M4.5 5h15A1.5 1.5 0 0 1 21 6.5v9a1.5 1.5 0 0 1-1.5 1.5H9l-4.5 3.5V17A1.5 1.5 0 0 1 3 15.5v-9A1.5 1.5 0 0 1 4.5 5Z"/>');
  var ICON_SUN = svg('<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/>');
  var ICON_MOON = svg('<path d="M20 14.6A8 8 0 0 1 9.4 4 8 8 0 1 0 20 14.6Z"/>');

  function loadPaletteData() {
    if (paletteData || paletteFetch) return paletteFetch;
    paletteFetch = fetch('/api/palette', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) { paletteData = data || {}; paletteFetch = null; if (palette) renderPalette(); })
      .catch(function () { paletteData = {}; paletteFetch = null; });
    return paletteFetch;
  }

  function score(text, query) {
    if (!query) return 1;
    var t = text.toLowerCase();
    var q = query.toLowerCase();
    var idx = t.indexOf(q);
    if (idx !== -1) return 1000 - idx * 2 - (t.length - q.length) * 0.1 + (idx === 0 || /\W/.test(t.charAt(idx - 1)) ? 200 : 0);
    var ti = 0, s = 0, run = 0;
    for (var qi = 0; qi < q.length; qi++) {
      var found = t.indexOf(q.charAt(qi), ti);
      if (found === -1) return 0;
      run = found === ti ? run + 1 : 0;
      s += 10 + run * 5 + (found === 0 || /\W/.test(t.charAt(found - 1)) ? 8 : 0);
      ti = found + 1;
    }
    return s;
  }

  function highlight(text, query) {
    if (!query) return escapeText(text);
    var t = text.toLowerCase();
    var q = query.toLowerCase();
    var idx = t.indexOf(q);
    if (idx !== -1) {
      return escapeText(text.slice(0, idx)) + '<mark>' + escapeText(text.slice(idx, idx + q.length)) + '</mark>' + escapeText(text.slice(idx + q.length));
    }
    return escapeText(text);
  }

  function buildEntries(query) {
    var groups = [];
    var q = query.trim();
    var hasConversations = !!document.querySelector('.sidebar-nav a[href="/conversations"]');
    var data = paletteData || {};

    function ranked(list, key, limit) {
      return list
        .map(function (it) { return { it: it, s: score(it[key] + ' ' + (it.extra || ''), q) }; })
        .filter(function (x) { return x.s > 0; })
        .sort(function (a, b) { return b.s - a.s; })
        .slice(0, limit)
        .map(function (x) { return x.it; });
    }

    var go = ranked(navItems(), 'label', q ? 6 : 20);
    var quick = [];
    if (data.todayPlan) quick.push({ label: "Open today's plan", hint: data.todayPlan.label, href: data.todayPlan.href, icon: ICON_CAL });
    else if (data.latestPlan) quick.push({ label: 'Open the latest plan', hint: data.latestPlan.label, href: data.latestPlan.href, icon: ICON_CAL });
    if (!q) {
      if (quick.length) groups.push({ label: 'Jump to', items: quick });
      groups.push({ label: 'Go to', items: go });
      var recent = (data.projects || []).slice(0, 5).map(function (p) { return { label: p.name, hint: p.sourceLabel + ' · ' + p.status, href: p.href, icon: ICON_FOLDER }; });
      if (recent.length) groups.push({ label: 'Recently active projects', items: recent });
      groups.push({ label: 'Theme', items: [
        { label: 'Use light theme', hint: 'Appearance', action: function () { store('sc_theme', 'light'); applyTheme('light'); }, icon: ICON_SUN },
        { label: 'Use dark theme', hint: 'Appearance', action: function () { store('sc_theme', 'dark'); applyTheme('dark'); }, icon: ICON_MOON },
        { label: 'Match system theme', hint: 'Appearance', action: function () { store('sc_theme', null); applyTheme('system'); } },
      ] });
      return groups;
    }

    var searches = [
      { label: 'Search projects for “' + q + '”', href: '/projects?q=' + encodeURIComponent(q), icon: ICON_SEARCH, hint: 'Projects' },
      { label: 'Search lessons for “' + q + '”', href: '/lessons?q=' + encodeURIComponent(q), icon: ICON_SEARCH, hint: 'Lessons' },
    ];
    if (hasConversations) searches.push({ label: 'Search conversations for “' + q + '”', href: '/conversations?q=' + encodeURIComponent(q), icon: ICON_SEARCH, hint: 'Conversations' });

    if (go.length) groups.push({ label: 'Go to', items: go });
    var projects = ranked((data.projects || []).map(function (p) { return { label: p.name, extra: p.id + ' ' + (p.tags || []).join(' '), hint: p.sourceLabel + ' · ' + p.status, href: p.href, icon: ICON_FOLDER }; }), 'label', 6);
    if (projects.length) groups.push({ label: 'Projects', items: projects });
    var initiatives = ranked((data.initiatives || []).map(function (i) { return { label: i.name, hint: i.sourceLabel, href: i.href, icon: ICON_TARGET }; }), 'label', 4);
    if (initiatives.length) groups.push({ label: 'Initiatives', items: initiatives });
    var lessons = ranked((data.lessons || []).map(function (l) { return { label: l.title, hint: l.date, href: l.href, icon: ICON_BULB }; }), 'label', 5);
    if (lessons.length) groups.push({ label: 'Lessons', items: lessons });
    var plans = ranked((data.plans || []).map(function (p) { return { label: p.label, extra: p.date, hint: p.sourceLabel, href: p.href, icon: ICON_CAL }; }), 'label', 4);
    if (plans.length) groups.push({ label: 'Daily plans', items: plans });
    groups.push({ label: 'Search', items: searches });
    if (hasConversations) searches[searches.length - 1].icon = ICON_CHAT;
    return groups;
  }

  function renderPalette() {
    if (!palette) return;
    var q = palette.input.value;
    var groups = buildEntries(q);
    var html = '';
    var flat = [];
    groups.forEach(function (g, gi) {
      if (!g.items.length) return;
      html += '<li role="presentation"><p class="palette-group-label" id="pg-' + gi + '">' + escapeText(g.label) + '</p><ul role="group" aria-labelledby="pg-' + gi + '" style="list-style:none;margin:0;padding:0">';
      g.items.forEach(function (it) {
        var i = flat.length;
        flat.push(it);
        html += '<li class="palette-item" role="option" id="po-' + i + '" data-index="' + i + '" aria-selected="false">' +
          (it.icon || ICON_SEARCH) +
          '<span class="palette-item-label">' + highlight(it.label, q.trim()) + '</span>' +
          (it.hint ? '<span class="palette-item-hint">' + escapeText(it.hint) + '</span>' : '') +
          '</li>';
      });
      html += '</ul></li>';
    });
    if (!flat.length) html = '<li class="palette-empty" role="presentation">No matches. Try another word.</li>';
    palette.list.innerHTML = html;
    palette.items = flat;
    setActive(flat.length ? 0 : -1);
  }

  function setActive(i) {
    if (!palette) return;
    var prev = palette.list.querySelector('[aria-selected="true"]');
    if (prev) prev.setAttribute('aria-selected', 'false');
    palette.active = i;
    if (i < 0) { palette.input.removeAttribute('aria-activedescendant'); return; }
    var el = document.getElementById('po-' + i);
    if (el) {
      el.setAttribute('aria-selected', 'true');
      palette.input.setAttribute('aria-activedescendant', el.id);
      el.scrollIntoView({ block: 'nearest' });
    }
  }

  function choose(i) {
    if (!palette || i < 0 || !palette.items[i]) return;
    var it = palette.items[i];
    closePalette(!it.href);
    if (it.action) it.action();
    else if (it.href) window.location.href = it.href;
  }

  function openPalette() {
    if (palette) return;
    var opener = document.activeElement;
    var overlay = document.createElement('div');
    overlay.className = 'palette-overlay';
    overlay.innerHTML =
      '<div class="palette" role="dialog" aria-modal="true" aria-label="Command palette">' +
        '<div class="palette-input-row">' + ICON_SEARCH +
          '<input type="text" role="combobox" aria-expanded="true" aria-controls="palette-list" aria-autocomplete="list" autocomplete="off" spellcheck="false" placeholder="Search projects, lessons, plans, or jump to a section…" aria-label="Search or jump to">' +
          '<kbd>Esc</kbd>' +
        '</div>' +
        '<ul class="palette-list" id="palette-list" role="listbox" aria-label="Results"></ul>' +
        '<div class="palette-foot"><span><kbd>↑</kbd><kbd>↓</kbd> to move</span><span><kbd>↵</kbd> to open</span><span><kbd>Esc</kbd> to close</span></div>' +
      '</div>';
    document.body.appendChild(overlay);
    var input = overlay.querySelector('input');
    var list = overlay.querySelector('.palette-list');
    palette = { overlay: overlay, input: input, list: list, items: [], active: -1, opener: opener };
    renderPalette();
    loadPaletteData();
    input.focus();

    input.addEventListener('input', renderPalette);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); if (palette.items.length) setActive((palette.active + 1) % palette.items.length); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (palette.items.length) setActive((palette.active - 1 + palette.items.length) % palette.items.length); }
      else if (e.key === 'Enter') { e.preventDefault(); choose(palette.active); }
      else if (e.key === 'Escape') { e.preventDefault(); closePalette(true); }
      else if (e.key === 'Tab') { e.preventDefault(); }
    });
    list.addEventListener('mousemove', function (e) {
      var item = e.target.closest('.palette-item');
      if (item) { var i = Number(item.getAttribute('data-index')); if (i !== palette.active) setActive(i); }
    });
    list.addEventListener('click', function (e) {
      var item = e.target.closest('.palette-item');
      if (item) choose(Number(item.getAttribute('data-index')));
    });
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) closePalette(true); });
  }

  function closePalette(returnFocus) {
    if (!palette) return;
    var opener = palette.opener;
    palette.overlay.remove();
    palette = null;
    if (returnFocus && opener && opener.focus) opener.focus();
  }

  document.addEventListener('click', function (e) {
    var opener = e.target.closest && e.target.closest('.palette-trigger, [data-open-palette]');
    if (opener) { e.preventDefault(); openPalette(); }
  });

  function typingInField(el) {
    if (!el) return false;
    var tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  }

  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      palette ? closePalette(true) : openPalette();
      return;
    }
    if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && !palette && !typingInField(document.activeElement)) {
      e.preventDefault();
      openPalette();
    }
  });

  /* ===================================================================
     4. Live status
     =================================================================== */
  //
  // Each System item in the sidebar carries a dot that polls a read-only
  // status endpoint every five minutes, once at load and when the tab
  // returns. Classes: sync-ok (green), sync-dirty (amber, needs a look),
  // sync-alert (red, failing), sync-na (gray, unavailable), sync-run (sky,
  // work in flight). The Today page's status tiles share the same renderer.
  var POLL_MS = 5 * 60 * 1000;
  var STATES = ['sync-ok', 'sync-dirty', 'sync-alert', 'sync-na', 'sync-run', 'sync-checking'];

  function paint(kind, state, count, summary, detail) {
    var chip = document.getElementById(kind + '-chip');
    if (chip) {
      STATES.forEach(function (c) { chip.classList.remove(c); });
      chip.classList.add(state);
      chip.title = summary + (detail ? ' (' + detail + ')' : '');
      var n = chip.querySelector('.sync-chip-count');
      if (n) n.textContent = count || '';
      var sr = chip.querySelector('.nav-status-text');
      if (sr) sr.textContent = ': ' + summary;
    }
    document.querySelectorAll('[data-status-for="' + kind + '"]').forEach(function (tile) {
      STATES.forEach(function (c) { tile.classList.remove(c); });
      tile.classList.add(state);
      var v = tile.querySelector('.status-tile-value');
      if (v) v.textContent = summary;
      var s = tile.querySelector('.status-tile-sub');
      if (s) s.textContent = detail || '';
    });
  }

  function poll(kind, url, render) {
    if (!document.getElementById(kind + '-chip') && !document.querySelector('[data-status-for="' + kind + '"]')) return;
    function run() {
      fetch(url, { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(render)
        .catch(function () { render(null); });
    }
    run();
    setInterval(run, POLL_MS);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) run(); });
  }

  function asOf(at) {
    if (!at) return '';
    var d = new Date(at);
    if (isNaN(d.getTime())) return 'as of ' + at;
    var mins = Math.round((Date.now() - d.getTime()) / 60000);
    if (mins < 1) return 'checked just now';
    if (mins < 60) return 'checked ' + mins + ' min ago';
    var hrs = Math.round(mins / 60);
    if (hrs < 24) return 'checked ' + hrs + ' h ago';
    return 'checked ' + d.toLocaleDateString();
  }

  poll('sync', '/api/sync-status', function (data) {
    var muted = data && data.quietAudio ? ' · audio muted' : '';
    if (!data || (data.installed === false && !data.generatedAt)) {
      paint('sync', 'sync-na', '', 'Status unavailable', 'repo guard not installed');
      return;
    }
    if (data.dirtyCount > 0) {
      paint('sync', 'sync-dirty', String(data.dirtyCount), data.dirtyCount + ' repo' + (data.dirtyCount === 1 ? '' : 's') + ' need attention', asOf(data.generatedAt) + muted);
    } else if (data.error) {
      paint('sync', 'sync-dirty', '!', 'Report could not be read', data.error);
    } else if (!data.generatedAt) {
      paint('sync', 'sync-na', '', 'No report yet', data.refreshing ? 'scanning now' : '');
    } else {
      paint('sync', 'sync-ok', '', 'All repos synced', asOf(data.generatedAt) + muted);
    }
  });

  poll('context', '/api/context-status', function (data) {
    if (!data || data.defects === null || data.defects === undefined) {
      paint('context', 'sync-na', '', data && !data.doctorAvailable ? 'Doctor not installed' : 'Nothing to audit', '');
      return;
    }
    var defects = data.defects || 0;
    var failed = data.failedSources || 0;
    if (defects > 0) paint('context', 'sync-dirty', String(defects), defects + ' defect' + (defects === 1 ? '' : 's'), (data.projects || 0) + ' projects audited' + (failed ? ', ' + failed + ' source(s) not audited' : ''));
    else if (failed > 0) paint('context', 'sync-dirty', '!', failed + ' source' + (failed === 1 ? '' : 's') + ' not audited', '');
    else paint('context', 'sync-ok', '', 'No defects', (data.projects || 0) + ' projects audited · ' + asOf(data.checkedAt));
  });

  poll('conformance', '/api/conformance-status', function (data) {
    if (!data || data.installed === false) {
      paint('conformance', 'sync-na', '', data ? 'synthesis v5 not installed' : 'Status unavailable', '');
      return;
    }
    if (data.healthy === null || data.error) {
      paint('conformance', data.failures > 0 ? 'sync-alert' : 'sync-dirty', '!', 'No doctor result', data.error || '');
      return;
    }
    var failures = data.failures || 0;
    var warnings = data.warnings || 0;
    if (data.healthy) paint('conformance', 'sync-ok', '', 'Healthy', (warnings ? warnings + ' warning' + (warnings === 1 ? '' : 's') + ' · ' : '') + asOf(data.checkedAt));
    else paint('conformance', 'sync-alert', String(failures), failures + ' failing check' + (failures === 1 ? '' : 's'), (warnings ? warnings + ' warning(s) · ' : '') + asOf(data.checkedAt));
  });

  poll('autopilot', '/api/autopilot', function (data) {
    if (!data || data.demo) { paint('autopilot', 'sync-na', '', 'No runs', ''); return; }
    var runs = data.runs || [];
    var open = runs.filter(function (r) { return ['running', 'waiting', 'blocked', 'paused'].indexOf(r.status) !== -1; });
    var blocked = open.filter(function (r) { return r.status === 'blocked'; }).length;
    var questions = open.reduce(function (n, r) { return n + ((r.questions && r.questions.length) || 0); }, 0);
    var waiting = open.filter(function (r) { return r.status === 'waiting'; }).length;
    if (!open.length) { paint('autopilot', 'sync-na', '', 'No open runs', runs.length ? runs.length + ' closed' : ''); return; }
    if (blocked) paint('autopilot', 'sync-alert', String(blocked), blocked + ' blocked', open.length + ' open');
    else if (questions || waiting) paint('autopilot', 'sync-dirty', String(questions || waiting), questions ? questions + ' question' + (questions === 1 ? '' : 's') + ' for you' : waiting + ' waiting', open.length + ' open');
    else paint('autopilot', 'sync-run', String(open.length), open.length + ' running', '');
  });

  /* ===================================================================
     5. Drafts
     =================================================================== */

  // Slack directory island: name/alias -> user ID, channel name -> channel ID.
  // Used for Smart Copy: rewrite @Name and #channel-name to canonical Slack
  // syntax (<@U...>, <#C...|name>) before writing to the clipboard so
  // mentions resolve when the message is pasted-and-sent in Slack.
  var slackDir = (function () {
    try {
      var el = document.getElementById('slack-directory');
      if (!el) return { userByKey: {}, channelByName: {} };
      var data = JSON.parse(el.textContent || '{}');
      var userByKey = {};
      (data.users || []).forEach(function (u) {
        [u.name].concat(u.aliases || []).forEach(function (k) {
          if (!k) return;
          var nk = k.trim().toLowerCase().replace(/\s+/g, ' ');
          if (nk && !(nk in userByKey)) userByKey[nk] = u;
        });
      });
      var channelByName = {};
      (data.channels || []).forEach(function (c) { channelByName[c.name.toLowerCase()] = c; });
      return { userByKey: userByKey, channelByName: channelByName };
    } catch (_) {
      return { userByKey: {}, channelByName: {} };
    }
  })();

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function smartResolveMentions(text) {
    if (!text) return text;
    var result = text;
    // Channels: #name -> <#C...|name> if mapped; skip text already in canonical form.
    result = result.replace(/(?<!<)#([a-zA-Z][\w-]{1,79})\b/g, function (m, name) {
      var ch = slackDir.channelByName[name.toLowerCase()];
      return ch ? '<#' + ch.id + '|' + name + '>' : m;
    });
    // @U... -> <@U...>
    result = result.replace(/(?<!<)@(U[A-Z0-9]{6,})\b/g, function (_m, id) { return '<@' + id + '>'; });
    // @DisplayName from the directory; longest first to avoid partial overrides.
    var keys = Object.keys(slackDir.userByKey).sort(function (a, b) { return b.length - a.length; });
    if (keys.length > 0) {
      var re = new RegExp('(?<!<)@(' + keys.map(escapeRegex).join('|') + ')\\b', 'gi');
      result = result.replace(re, function (m, raw) {
        var u = slackDir.userByKey[raw.trim().toLowerCase().replace(/\s+/g, ' ')];
        return u ? '<@' + u.id + '>' : m;
      });
    }
    return result;
  }

  function getDraftText(actionsEl) {
    // Canonical source: data-original-text holds the parser's bodyText
    // (kind-aware: inside-fence content for "fenced", >-stripped content
    // for "blockquote", verbatim region for "multi-segment").
    if (typeof actionsEl.dataset.originalText === 'string') {
      return actionsEl.dataset.originalText.replace(/ /g, ' ').trim();
    }
    var prev = actionsEl.previousElementSibling;
    if (prev && prev.classList && prev.classList.contains('draft-body-region')) {
      return (prev.innerText || prev.textContent || '').replace(/ /g, ' ').trim();
    }
    if (prev && prev.classList && prev.classList.contains('draft-sent-body')) {
      var inner = prev.querySelector('pre, blockquote');
      if (inner) return (inner.innerText || inner.textContent || '').replace(/ /g, ' ').trim();
    }
    if (!prev) return '';
    return (prev.innerText || prev.textContent || '').replace(/ /g, ' ').trim();
  }

  function flashCopied(button) {
    if (!button) return;
    var original = button.textContent;
    button.textContent = 'Copied';
    button.classList.add('draft-copied');
    setTimeout(function () {
      button.textContent = original;
      button.classList.remove('draft-copied');
    }, 1500);
  }

  function fallbackCopy(text, button) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      flashCopied(button);
    } catch (_) {}
    document.body.removeChild(ta);
  }

  function copyText(text, button) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { flashCopied(button); }).catch(function () { fallbackCopy(text, button); });
    } else {
      fallbackCopy(text, button);
    }
  }

  function findMessageEl(actionsEl) {
    // The action bar follows a .draft-body-region wrapper holding the whole
    // draft body; that wrapper is the unit Edit mode hides and shows.
    var node = actionsEl.previousElementSibling;
    while (node) {
      if (node.classList && node.classList.contains('draft-body-region')) return node;
      if (node.tagName === 'TEXTAREA') { node = node.previousElementSibling; continue; }
      if (node.tagName === 'PRE' || node.tagName === 'BLOCKQUOTE') return node;
      node = node.previousElementSibling;
    }
    return null;
  }

  function findEditTextarea(actionsEl) {
    var node = actionsEl.previousElementSibling;
    while (node) {
      if (node.tagName === 'TEXTAREA' && node.classList.contains('draft-textarea')) return node;
      if (node.classList && node.classList.contains('draft-body-region')) return null;
      if (node.tagName === 'PRE' || node.tagName === 'BLOCKQUOTE') return null;
      node = node.previousElementSibling;
    }
    return null;
  }

  function setStatus(actionsEl, msg, isError) {
    var statusEl = actionsEl.querySelector('.draft-status');
    if (!statusEl) return;
    statusEl.textContent = msg || '';
    statusEl.classList.toggle('draft-status-error', !!isError);
  }

  function enterEditMode(actionsEl) {
    if (actionsEl.dataset.mode === 'editing') return;
    var original = actionsEl.dataset.originalText || '';
    var messageEl = findMessageEl(actionsEl);
    if (!messageEl) return;
    var textarea = findEditTextarea(actionsEl);
    if (!textarea) {
      textarea = document.createElement('textarea');
      textarea.className = 'draft-textarea';
      textarea.value = original;
      textarea.spellcheck = true;
      textarea.setAttribute('aria-label', 'Edit draft');
      textarea.rows = Math.max(5, Math.min(40, original.split('\n').length + 2));
      actionsEl.parentNode.insertBefore(textarea, actionsEl);
    }
    messageEl.style.display = 'none';
    actionsEl.dataset.mode = 'editing';
    setStatus(actionsEl, 'Cmd+Enter saves · Esc cancels', false);
    textarea.focus();
    var len = textarea.value.length;
    try { textarea.setSelectionRange(len, len); } catch (_) {}
  }

  function exitEditMode(actionsEl) {
    var textarea = findEditTextarea(actionsEl);
    if (textarea && textarea.parentNode) textarea.parentNode.removeChild(textarea);
    var messageEl = findMessageEl(actionsEl);
    if (messageEl) messageEl.style.display = '';
    actionsEl.dataset.mode = '';
    setStatus(actionsEl, '', false);
  }

  function planUrlBase() {
    var m = window.location.pathname.match(/^\/plans\/([^/]+)\/(\d{4}-\d{2}-\d{2})/);
    return m ? { source: decodeURIComponent(m[1]), date: m[2] } : null;
  }

  function planUrl(suffix) {
    var base = planUrlBase();
    if (!base) return null;
    return '/plans/' + encodeURIComponent(base.source) + '/' + encodeURIComponent(base.date) + suffix;
  }

  function saveDraft(actionsEl) {
    var textarea = findEditTextarea(actionsEl);
    if (!textarea) return;
    var url = planUrl('/draft/' + encodeURIComponent(actionsEl.dataset.draftIndex || ''));
    if (!url) { setStatus(actionsEl, 'Cannot determine plan URL.', true); return; }
    setStatus(actionsEl, 'Saving…', false);
    var saveBtn = actionsEl.querySelector('.draft-save');
    var cancelBtn = actionsEl.querySelector('.draft-cancel');
    if (saveBtn) saveBtn.disabled = true;
    if (cancelBtn) cancelBtn.disabled = true;
    fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ originalText: actionsEl.dataset.originalText || '', newText: textarea.value })
    }).then(function (res) {
      if (res.ok) { window.location.reload(); return; }
      return res.json().catch(function () { return null; }).then(function (body) {
        setStatus(actionsEl, (body && body.error) ? body.error : ('Save failed (' + res.status + ').'), true);
        if (saveBtn) saveBtn.disabled = false;
        if (cancelBtn) cancelBtn.disabled = false;
      });
    }).catch(function (err) {
      setStatus(actionsEl, 'Network error: ' + (err && err.message ? err.message : 'unknown'), true);
      if (saveBtn) saveBtn.disabled = false;
      if (cancelBtn) cancelBtn.disabled = false;
    });
  }

  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;

    var copyBtn = t.closest('.draft-copy');
    if (copyBtn) {
      e.preventDefault();
      var actions = copyBtn.closest('.draft-actions');
      if (actions) {
        var text;
        if (actions.dataset.mode === 'editing') {
          var ta = findEditTextarea(actions);
          text = ta ? ta.value : '';
        } else {
          text = getDraftText(actions);
        }
        // Smart Copy: canonical Slack mention syntax so mentions resolve on paste.
        if (text) copyText(smartResolveMentions(text), copyBtn);
      }
      return;
    }

    var emailLink = t.closest('.draft-email');
    if (emailLink) {
      e.preventDefault();
      var actions2 = emailLink.closest('.draft-actions');
      var body;
      if (actions2 && actions2.dataset.mode === 'editing') {
        var ta2 = findEditTextarea(actions2);
        body = ta2 ? ta2.value : '';
      } else {
        body = actions2 ? getDraftText(actions2) : '';
      }
      var url = 'mailto:' + (emailLink.dataset.email || '');
      var qs = [];
      if (emailLink.dataset.subject) qs.push('subject=' + encodeURIComponent(emailLink.dataset.subject));
      if (body) qs.push('body=' + encodeURIComponent(body));
      if (qs.length) url += '?' + qs.join('&');
      window.location.href = url;
      return;
    }

    var editBtn = t.closest('.draft-edit');
    if (editBtn) { e.preventDefault(); var ea = editBtn.closest('.draft-actions'); if (ea) enterEditMode(ea); return; }

    var saveBtn = t.closest('.draft-save');
    if (saveBtn) { e.preventDefault(); var sa = saveBtn.closest('.draft-actions'); if (sa) saveDraft(sa); return; }

    var cancelBtn = t.closest('.draft-cancel');
    if (cancelBtn) { e.preventDefault(); var ca = cancelBtn.closest('.draft-actions'); if (ca) exitEditMode(ca); return; }

    var sendBtn = t.closest('.draft-send');
    if (sendBtn) { e.preventDefault(); var sendActions = sendBtn.closest('.draft-actions'); if (sendActions) openSendModal(sendActions); return; }

    var oneTapBtn = t.closest('.cockpit-onetap-btn');
    if (oneTapBtn && oneTapBtn.dataset.onetapAction) {
      e.preventDefault();
      var card = oneTapBtn.closest('.cockpit-onetap-draft');
      var action = oneTapBtn.dataset.onetapAction;
      if (!card) return;
      if (action === 'skip') handleOneTapSkip(card);
      else if (action === 'undo-skip') handleOneTapUndoSkip(card);
      else if (action === 'edit') handleOneTapEdit(card);
      else if (action === 'approve') handleOneTapApprove(card);
      return;
    }
  });

  // Keyboard shortcuts inside the edit textarea: Cmd/Ctrl+Enter saves, Escape cancels.
  document.addEventListener('keydown', function (e) {
    var ta = e.target;
    if (!ta || ta.tagName !== 'TEXTAREA' || !ta.classList.contains('draft-textarea')) return;
    var actions = ta.nextElementSibling;
    if (!actions || !actions.classList.contains('draft-actions')) return;
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); saveDraft(actions); }
    else if (e.key === 'Escape') { e.preventDefault(); exitEditMode(actions); }
  });

  // ---- Send-to-Slack confirm modal: created on demand, reused across sends ----
  var sendModal = null;
  var sendModalTarget = null;
  var sendModalOpener = null;

  function buildSendModal() {
    var overlay = document.createElement('div');
    overlay.className = 'send-modal-overlay';
    overlay.innerHTML = '<div class="send-modal" role="dialog" aria-modal="true" aria-labelledby="send-modal-title">' +
      '<h3 id="send-modal-title" class="send-modal-title">Send to Slack</h3>' +
      '<div class="send-modal-meta"></div>' +
      '<div class="send-modal-mentions"></div>' +
      '<div class="send-modal-preview-label">Preview, with mentions resolved</div>' +
      '<pre class="send-modal-preview"></pre>' +
      '<div class="send-modal-status" role="status" aria-live="polite"></div>' +
      '<div class="send-modal-actions">' +
        '<button type="button" class="send-modal-cancel">Cancel</button>' +
        '<button type="button" class="send-modal-confirm">Send</button>' +
      '</div>' +
    '</div>';
    overlay.addEventListener('click', function (ev) { if (ev.target === overlay) closeSendModal(); });
    overlay.querySelector('.send-modal-cancel').addEventListener('click', closeSendModal);
    overlay.querySelector('.send-modal-confirm').addEventListener('click', confirmSend);
    document.body.appendChild(overlay);
    return overlay;
  }

  function ensureSendModal() {
    if (!sendModal) sendModal = buildSendModal();
    return sendModal;
  }

  function setSendModalStatus(msg, isError) {
    var s = ensureSendModal().querySelector('.send-modal-status');
    s.textContent = msg || '';
    s.classList.toggle('send-modal-status-error', !!isError);
  }

  function setSendModalButtonsDisabled(disabled) {
    var modal = ensureSendModal();
    modal.querySelector('.send-modal-confirm').disabled = !!disabled;
    modal.querySelector('.send-modal-cancel').disabled = !!disabled;
  }

  function openSendModal(actionsEl) {
    sendModalTarget = actionsEl;
    sendModalOpener = document.activeElement;
    var modal = ensureSendModal();
    modal.classList.add('visible');
    setSendModalStatus('', false);
    setSendModalButtonsDisabled(false);
    var meta = modal.querySelector('.send-modal-meta');
    var mentionsEl = modal.querySelector('.send-modal-mentions');
    var preview = modal.querySelector('.send-modal-preview');
    meta.textContent = 'Loading…';
    mentionsEl.textContent = '';
    preview.textContent = '';
    modal.querySelector('.send-modal-cancel').focus();

    var idx = actionsEl.dataset.draftIndex;
    var url = idx === undefined ? null : planUrl('/draft/' + encodeURIComponent(idx) + '/preflight');
    if (!url) { meta.textContent = 'Could not determine plan URL.'; return; }

    fetch(url).then(function (res) {
      return res.json().then(function (json) { return { ok: res.ok, body: json }; });
    }).then(function (r) {
      if (!r.ok || !r.body || r.body.ok === false) {
        meta.textContent = (r.body && r.body.error) ? r.body.error : 'Preflight failed.';
        setSendModalButtonsDisabled(true);
        modal.querySelector('.send-modal-cancel').disabled = false;
        return;
      }
      var b = r.body;
      var sendTo = b.sendToText ? b.sendToText.replace(/\s+/g, ' ').trim() : '(unknown target)';
      meta.innerHTML = '<strong>To:</strong> ' + escapeText(sendTo);
      var mlines = [];
      if (b.mentions && b.mentions.users && b.mentions.users.length) mlines.push('Will mention: ' + b.mentions.users.map(function (u) { return '@' + u.display; }).join(', '));
      if (b.mentions && b.mentions.channels && b.mentions.channels.length) mlines.push('Channels: ' + b.mentions.channels.map(function (c) { return '#' + c.display; }).join(', '));
      if (b.mentions && b.mentions.unresolved && b.mentions.unresolved.length) mlines.push('Unresolved (will send as plain text): ' + b.mentions.unresolved.map(function (u) { return u.raw; }).join(', '));
      mentionsEl.textContent = mlines.join('\n');
      preview.textContent = b.bodyResolved || b.bodyOriginal || '';
      if (!b.tokenConfigured) {
        meta.innerHTML += ' <span class="send-modal-warn">(Slack token not configured — Send disabled.)</span>';
        setSendModalButtonsDisabled(true);
        modal.querySelector('.send-modal-cancel').disabled = false;
      } else {
        modal.querySelector('.send-modal-confirm').focus();
      }
    }).catch(function (err) {
      meta.textContent = 'Network error: ' + (err && err.message ? err.message : 'unknown');
      setSendModalButtonsDisabled(true);
      modal.querySelector('.send-modal-cancel').disabled = false;
    });
  }

  function closeSendModal() {
    if (sendModal) sendModal.classList.remove('visible');
    sendModalTarget = null;
    if (sendModalOpener && sendModalOpener.focus) sendModalOpener.focus();
    sendModalOpener = null;
  }

  function confirmSend() {
    var actions = sendModalTarget;
    if (!actions) return;
    var url = planUrl('/draft/' + encodeURIComponent(actions.dataset.draftIndex) + '/send');
    if (!url) { setSendModalStatus('Cannot determine plan URL.', true); return; }
    setSendModalStatus('Sending…', false);
    setSendModalButtonsDisabled(true);
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmed: true })
    }).then(function (res) {
      return res.json().then(function (json) { return { ok: res.ok, status: res.status, body: json }; });
    }).then(function (r) {
      if (r.ok && r.body && r.body.ok) {
        if (r.body.warning) {
          setSendModalStatus(r.body.warning, false);
          setTimeout(function () { window.location.reload(); }, 2500);
        } else {
          window.location.reload();
        }
        return;
      }
      setSendModalStatus((r.body && r.body.error) ? r.body.error : ('Send failed (HTTP ' + r.status + ').'), true);
      setSendModalButtonsDisabled(false);
    }).catch(function (err) {
      setSendModalStatus('Network error: ' + (err && err.message ? err.message : 'unknown'), true);
      setSendModalButtonsDisabled(false);
    });
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && sendModal && sendModal.classList.contains('visible')) closeSendModal();
  });

  /* ===================================================================
     6. One-tap queue
     =================================================================== */

  function oneTapEndpoint(card, suffix) {
    return '/plans/' + encodeURIComponent(card.dataset.source) + '/' + encodeURIComponent(card.dataset.date) + '/draft/' + encodeURIComponent(card.dataset.draftIndex) + suffix;
  }

  function setOneTapStatus(card, msg, cls) {
    var status = card.querySelector('.cockpit-onetap-status');
    if (!status) return;
    status.textContent = msg || '';
    status.classList.remove('cockpit-status-error', 'cockpit-status-ok');
    if (cls) status.classList.add(cls);
  }

  function setOneTapBusy(card, busy) {
    card.querySelectorAll('.cockpit-onetap-btn').forEach(function (b) { b.disabled = !!busy; });
  }

  function postOneTap(card, suffix, busyMsg, failMsg) {
    setOneTapBusy(card, true);
    setOneTapStatus(card, busyMsg);
    fetch(oneTapEndpoint(card, suffix), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    }).then(function (r) {
      return r.json().then(function (j) { return { status: r.status, body: j }; });
    }).then(function (res) {
      if (res.status >= 200 && res.status < 300) { location.reload(); return; }
      setOneTapBusy(card, false);
      setOneTapStatus(card, (res.body && res.body.error) || failMsg, 'cockpit-status-error');
    }).catch(function () {
      setOneTapBusy(card, false);
      setOneTapStatus(card, 'Network error — try again.', 'cockpit-status-error');
    });
  }

  function handleOneTapSkip(card) { postOneTap(card, '/skip', 'Marking skipped…', 'Skip failed.'); }
  function handleOneTapUndoSkip(card) { postOneTap(card, '/unskip', 'Restoring…', 'Undo failed.'); }

  function handleOneTapEdit(card) {
    var details = card.querySelector('.cockpit-onetap-body');
    if (details && !details.open) details.open = true;
    var content = card.querySelector('.cockpit-onetap-body-content');
    if (!content || card.dataset.mode === 'editing') return;
    var originalBody = card.dataset.bodyText || '';
    card.dataset.mode = 'editing';
    card.dataset.originalBody = originalBody;
    var ta = document.createElement('textarea');
    ta.className = 'cockpit-onetap-editor';
    ta.value = originalBody;
    ta.setAttribute('aria-label', 'Edit draft');
    ta.rows = Math.max(3, originalBody.split('\n').length + 1);
    var actionRow = document.createElement('div');
    actionRow.className = 'cockpit-onetap-editor-actions';
    actionRow.innerHTML = '<button type="button" class="cockpit-onetap-btn cockpit-onetap-btn-cancel">Cancel</button>' +
                          '<button type="button" class="cockpit-onetap-btn cockpit-onetap-btn-save">Save</button>';
    content.style.display = 'none';
    content.parentNode.appendChild(ta);
    content.parentNode.appendChild(actionRow);
    ta.focus();
    actionRow.querySelector('.cockpit-onetap-btn-cancel').addEventListener('click', function () { exitOneTapEdit(card); });
    actionRow.querySelector('.cockpit-onetap-btn-save').addEventListener('click', function () { saveOneTapEdit(card, ta.value); });
  }

  function exitOneTapEdit(card) {
    var content = card.querySelector('.cockpit-onetap-body-content');
    var ta = card.querySelector('.cockpit-onetap-editor');
    var actions = card.querySelector('.cockpit-onetap-editor-actions');
    if (content) content.style.display = '';
    if (ta && ta.parentNode) ta.parentNode.removeChild(ta);
    if (actions && actions.parentNode) actions.parentNode.removeChild(actions);
    delete card.dataset.mode;
    delete card.dataset.originalBody;
    setOneTapStatus(card, '');
  }

  function saveOneTapEdit(card, newBody) {
    var originalBody = card.dataset.originalBody || card.dataset.bodyText || '';
    setOneTapBusy(card, true);
    setOneTapStatus(card, 'Saving…');
    fetch(oneTapEndpoint(card, ''), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ originalText: originalBody, newText: newBody })
    }).then(function (r) {
      return r.json().then(function (j) { return { status: r.status, body: j }; });
    }).then(function (res) {
      if (res.status >= 200 && res.status < 300) { location.reload(); return; }
      setOneTapBusy(card, false);
      setOneTapStatus(card, (res.body && res.body.error) || 'Save failed.', 'cockpit-status-error');
    }).catch(function () {
      setOneTapBusy(card, false);
      setOneTapStatus(card, 'Network error — try again.', 'cockpit-status-error');
    });
  }

  function handleOneTapApprove(card) {
    var body = card.dataset.bodyText || '';
    if (!card.querySelector('[data-slack-configured="true"]')) {
      // Slack not configured: copy the body for pasting into Slack.
      copyText(smartResolveMentions(body), card.querySelector('.cockpit-onetap-btn-approve'));
      setOneTapStatus(card, 'Copied — paste into Slack. Then click Skip if you sent it.', 'cockpit-status-ok');
      return;
    }
    // Slack configured: the same confirm modal as the standard send path,
    // driven by a hidden proxy that carries the draft index and body.
    var existingProxy = card.querySelector('.cockpit-onetap-proxy');
    if (existingProxy && existingProxy.parentNode) existingProxy.parentNode.removeChild(existingProxy);
    var proxy = document.createElement('div');
    proxy.className = 'draft-actions cockpit-onetap-proxy';
    proxy.style.display = 'none';
    proxy.dataset.mode = 'view';
    proxy.dataset.draftIndex = card.dataset.draftIndex;
    proxy.dataset.originalText = body;
    card.appendChild(proxy);
    openSendModal(proxy);
  }

  /* ===================================================================
     7. Cockpit
     =================================================================== */

  function cockpitView() { return document.querySelector('.cockpit-view'); }

  function cockpitBase() {
    var v = cockpitView();
    if (!v) return null;
    return { source: v.dataset.source, date: v.dataset.date, editable: v.dataset.editable === 'true' };
  }

  function cockpitUrl(base, suffix) {
    return '/plans/' + encodeURIComponent(base.source) + '/' + encodeURIComponent(base.date) + suffix;
  }

  function setCockpitStatus(el, msg, isError) {
    if (!el) return;
    el.textContent = msg || '';
    el.classList.toggle('cockpit-decision-status-error', !!isError);
    el.classList.toggle('cockpit-task-status-error', !!isError);
  }

  function handleDecisionPick(button) {
    var card = button.closest('.cockpit-decision');
    if (!card || card.dataset.decided === 'true') return;
    var base = cockpitBase();
    if (!base || !base.editable) return;
    var statusEl = card.querySelector('.cockpit-decision-status');
    var opts = card.querySelectorAll('.cockpit-decision-option');
    // Visible acknowledgment before the write lands: the chosen option
    // highlights and the others step back.
    button.classList.add('is-pending');
    setCockpitStatus(statusEl, 'Recording option ' + button.dataset.option + '…', false);
    opts.forEach(function (b) { b.disabled = true; });
    fetch(cockpitUrl(base, '/decision/' + encodeURIComponent(card.dataset.decisionIndex)), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ option: button.dataset.option, decidedAtIso: new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC') })
    }).then(function (res) {
      return res.json().then(function (json) { return { ok: res.ok, body: json }; });
    }).then(function (r) {
      if (r.ok && r.body && r.body.ok) { window.location.reload(); return; }
      button.classList.remove('is-pending');
      setCockpitStatus(statusEl, (r.body && r.body.error) ? r.body.error : 'Could not record decision.', true);
      opts.forEach(function (b) { b.disabled = false; });
    }).catch(function (err) {
      button.classList.remove('is-pending');
      setCockpitStatus(statusEl, 'Network error: ' + (err && err.message ? err.message : 'unknown'), true);
      opts.forEach(function (b) { b.disabled = false; });
    });
  }

  function handleDecisionUndo(button) {
    var card = button.closest('.cockpit-decision');
    if (!card || card.dataset.decided !== 'true') return;
    var base = cockpitBase();
    if (!base || !base.editable) return;
    var statusEl = card.querySelector('.cockpit-decision-status');
    button.disabled = true;
    setCockpitStatus(statusEl, 'Reopening the decision…', false);
    fetch(cockpitUrl(base, '/decision/' + encodeURIComponent(card.dataset.decisionIndex) + '/undo'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ option: button.dataset.option || '' })
    }).then(function (res) {
      return res.json().then(function (json) { return { ok: res.ok, body: json }; });
    }).then(function (r) {
      if (r.ok && r.body && r.body.ok) { window.location.reload(); return; }
      button.disabled = false;
      setCockpitStatus(statusEl, (r.body && r.body.error) ? r.body.error : 'Could not reopen the decision.', true);
    }).catch(function (err) {
      button.disabled = false;
      setCockpitStatus(statusEl, 'Network error: ' + (err && err.message ? err.message : 'unknown'), true);
    });
  }

  function formatLocalCockpitTime(d) {
    // "11:14 EDT" — matches the existing in-plan convention.
    try {
      var s = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short' }).format(d);
      return s.replace(/^24:/, '00:');
    } catch (_) {
      return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    }
  }

  function handleTaskToggle(checkbox) {
    var task = checkbox.closest('.cockpit-task');
    if (!task) return;
    var base = cockpitBase();
    if (!base || !base.editable) { checkbox.checked = !checkbox.checked; return; }
    var statusEl = task.querySelector('.cockpit-task-status');
    var willBeDone = checkbox.checked;
    checkbox.disabled = true;
    setCockpitStatus(statusEl, willBeDone ? 'Marking done…' : 'Reopening…', false);
    var payload = { originalText: task.dataset.originalText || '' };
    if (willBeDone) payload.doneAtLocal = formatLocalCockpitTime(new Date());
    fetch(cockpitUrl(base, '/task/' + encodeURIComponent(task.dataset.taskIndex) + '/' + (willBeDone ? 'done' : 'undone')), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (res) {
      return res.json().then(function (json) { return { ok: res.ok, body: json }; });
    }).then(function (r) {
      if (r.ok && r.body && r.body.ok) { window.location.reload(); return; }
      setCockpitStatus(statusEl, (r.body && r.body.error) ? r.body.error : 'Could not update task.', true);
      checkbox.checked = !willBeDone;
      checkbox.disabled = false;
    }).catch(function (err) {
      setCockpitStatus(statusEl, 'Network error: ' + (err && err.message ? err.message : 'unknown'), true);
      checkbox.checked = !willBeDone;
      checkbox.disabled = false;
    });
  }

  function applyCockpitFilter(filter) {
    var view = cockpitView();
    if (!view) return;
    view.querySelectorAll('.cockpit-filter-chip').forEach(function (c) {
      var on = c.dataset.filter === filter;
      c.classList.toggle('cockpit-filter-active', on);
      if (c.tagName === 'BUTTON') c.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    if (filter === 'find') { openCockpitFind(); return; }
    document.body.dataset.cockpitFocus = filter === 'focus' ? 'true' : 'false';
    closeCockpitFind(true);
  }

  function findBar() {
    var view = cockpitView();
    return view ? view.querySelector('.cockpit-find-bar') : null;
  }

  function openCockpitFind() {
    var bar = findBar();
    if (!bar) return;
    bar.hidden = false;
    var input = bar.querySelector('.cockpit-find-input');
    if (input) { input.focus(); input.select(); }
  }

  function closeCockpitFind(keepFilter) {
    var bar = findBar();
    if (!bar || bar.hidden) return;
    bar.hidden = true;
    clearFindHighlights();
    if (keepFilter) return;
    applyCockpitFilter(document.body.dataset.cockpitFocus === 'true' ? 'focus' : 'all');
  }

  function clearFindHighlights() {
    var view = cockpitView();
    if (!view) return;
    view.querySelectorAll('.cockpit-find-match').forEach(function (el) { el.classList.remove('cockpit-find-match'); });
  }

  function runCockpitFind(query) {
    clearFindHighlights();
    var view = cockpitView();
    if (!view || !query) return { hits: 0 };
    var q = query.toLowerCase();
    var hits = 0;
    var firstHit = null;
    var candidates = view.querySelectorAll('.cockpit-task-body, .cockpit-decision-question, .cockpit-decision-body, .cockpit-onetap-preview, .cockpit-brief-body p, .cockpit-brief-body li, .cockpit-drafts-body p, .cockpit-drafts-body h3, .cockpit-collapsible-body p, .cockpit-collapsible-body li, .cockpit-collapsible-body h3, .cockpit-collapsible-body h4');
    candidates.forEach(function (el) {
      if ((el.textContent || '').toLowerCase().indexOf(q) === -1) return;
      el.classList.add('cockpit-find-match');
      hits++;
      if (!firstHit) firstHit = el;
      var p = el.parentElement;
      while (p && p !== view) {
        if (p.tagName === 'DETAILS') p.open = true;
        p = p.parentElement;
      }
    });
    if (firstHit) firstHit.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return { hits: hits };
  }

  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;

    var optBtn = t.closest('.cockpit-decision-option');
    if (optBtn && !optBtn.disabled) { e.preventDefault(); handleDecisionPick(optBtn); return; }

    var undoBtn = t.closest('.cockpit-decision-undo');
    if (undoBtn && !undoBtn.disabled) { e.preventDefault(); handleDecisionUndo(undoBtn); return; }

    var chip = t.closest('button.cockpit-filter-chip');
    if (chip) { e.preventDefault(); applyCockpitFilter(chip.dataset.filter); return; }

    var findClose = t.closest('.cockpit-find-close');
    if (findClose) { e.preventDefault(); closeCockpitFind(false); return; }

    var railBtn = t.closest('.cockpit-rail-toggle');
    if (railBtn) { e.preventDefault(); toggleRail(); return; }
  });

  // Capture the user's intent before the browser keeps the new checkbox state.
  document.addEventListener('change', function (e) {
    var cb = e.target;
    if (cb && cb.classList && cb.classList.contains('cockpit-task-check')) handleTaskToggle(cb);
  });

  document.addEventListener('input', function (e) {
    var input = e.target;
    if (!input || !input.classList || !input.classList.contains('cockpit-find-input')) return;
    var bar = input.closest('.cockpit-find-bar');
    var status = bar ? bar.querySelector('.cockpit-find-status') : null;
    var result = runCockpitFind(input.value);
    if (status) status.textContent = input.value ? (result.hits + ' match' + (result.hits === 1 ? '' : 'es')) : '';
  });

  // Cmd/Ctrl+F also opens the plan's find bar (the browser's own find runs
  // too); the plan's find opens collapsed sections the browser cannot reach.
  document.addEventListener('keydown', function (e) {
    if (!cockpitView()) return;
    if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F')) {
      var bar = findBar();
      if (bar && bar.hidden) bar.hidden = false;
    }
    if (e.key === 'Escape') {
      var bar2 = findBar();
      if (bar2 && !bar2.hidden) closeCockpitFind(false);
    }
  });

  // ---- Refresh when the plan file changes on disk ----
  //
  // The plan is written by several actors through the day: this page's own
  // write-back, manual edits, the daily rituals and Slack sync. Every 30 s
  // the page compares the file's mtime with what it rendered and reloads
  // when it is newer, but never while the reader is mid-edit, the send modal
  // is open, a write is in flight, or the tab is hidden.
  var mtimeInflight = false;

  function isCockpitBusy() {
    var view = cockpitView();
    if (!view) return false;
    if (document.querySelector('.draft-textarea, .cockpit-onetap-editor')) return true;
    if (document.querySelector('.send-modal-overlay.visible, .palette-overlay')) return true;
    if (view.querySelector('.cockpit-decision[data-decided="false"] .cockpit-decision-option:disabled')) return true;
    var pendingTask = view.querySelector('.cockpit-task-check:disabled');
    if (pendingTask) {
      var task = pendingTask.closest('.cockpit-task');
      if (task && task.dataset.readonly !== 'true') return true;
    }
    var ae = document.activeElement;
    if (ae && ae.tagName === 'TEXTAREA') return true;
    if (ae && ae.classList && ae.classList.contains('cockpit-find-input') && ae.value) return true;
    return false;
  }

  function checkMtime() {
    if (mtimeInflight || document.hidden) return;
    var view = cockpitView();
    if (!view) return;
    var baseline = parseFloat(view.dataset.mtimeMs || '0');
    if (!view.dataset.source || !view.dataset.date || !baseline) return;
    mtimeInflight = true;
    fetch(cockpitUrl({ source: view.dataset.source, date: view.dataset.date }, '/mtime'), { cache: 'no-store' })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (body) {
        mtimeInflight = false;
        if (!body || body.ok !== true) return;
        var serverMtime = parseFloat(body.mtimeMs);
        if (!serverMtime || serverMtime <= baseline || isCockpitBusy()) return;
        window.location.reload();
      })
      .catch(function () { mtimeInflight = false; });
  }

  if (cockpitView() && cockpitView().dataset.mtimeMs) {
    setTimeout(function () {
      setInterval(checkMtime, 30000);
      document.addEventListener('visibilitychange', function () { if (!document.hidden) checkMtime(); });
      window.addEventListener('focus', checkMtime);
    }, 5000);
  }

  // ---- Plan rail: hide or show, remembered per browser ----
  var RAIL_KEY = 'sc_cockpit_right_hidden';

  function applyRail() {
    var shell = document.querySelector('.cockpit-shell');
    if (!shell) return;
    var hidden = read(RAIL_KEY) === 'true';
    shell.dataset.hideRight = hidden ? 'true' : 'false';
    document.querySelectorAll('.cockpit-rail-toggle').forEach(function (b) {
      b.setAttribute('aria-pressed', hidden ? 'false' : 'true');
      var label = b.querySelector('.rail-toggle-label');
      if (label) label.textContent = hidden ? 'Show panel' : 'Hide panel';
    });
  }

  function toggleRail() {
    store(RAIL_KEY, read(RAIL_KEY) === 'true' ? 'false' : 'true');
    applyRail();
  }

  applyRail();
})();
