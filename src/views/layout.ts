import type { Source } from "../config.js";
import { escapeHtml, escapeAttr } from "../utils.js";
import { SOURCES_COOKIE } from "../active-sources.js";
import pkg from "../../package.json";

export function layout(opts: {
  title: string;
  content: string;
  sources: Source[];
  activeSourceNames: string[];
  currentPath?: string;
  demoMode: boolean;
  /**
   * v0.9+: when true, the `<main>` container uses the wider layout
   * (`.container-wide`, ~1320px max). The cockpit's three-column shell
   * needs the extra horizontal space; other pages (`/projects`, `/initiatives`,
   * `/lessons`, `/plans` calendar) should leave this off so they keep
   * Pico's standard `.container` width.
   */
  wide?: boolean;
}): string {
  const visibleSources = opts.demoMode
    ? opts.sources.filter((s) => s.demo === true)
    : opts.sources;

  const isDemoActive =
    opts.demoMode ||
    opts.activeSourceNames.some((n) => opts.sources.find((s) => s.name === n)?.demo === true);

  const demoBadge = isDemoActive ? '<span class="badge badge-demo">DEMO</span>' : "";
  const nav = buildNav(opts.currentPath || "");
  const picker = buildSourcePicker(visibleSources, opts.activeSourceNames, opts.demoMode);

  return `<!DOCTYPE html>
<html lang="en" data-theme="light">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <!-- The console reads files fresh on every request. Never cache the HTML —
       any stored copy is by definition stale. HTTP Cache-Control headers
       (no-store, no-cache) are the primary defense; these meta tags are
       belt-and-suspenders in case headers are stripped by an intermediary. -->
  <meta http-equiv="Cache-Control" content="no-store, no-cache, must-revalidate, max-age=0">
  <meta http-equiv="Pragma" content="no-cache">
  <meta http-equiv="Expires" content="0">
  <title>${escapeHtml(opts.title)} - Synthesis Console</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.min.css">
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <header class="container">
    <nav>
      <ul>
        <li><a href="/projects" class="logo"><strong>Synthesis Console</strong></a> ${demoBadge}</li>
      </ul>
      <ul>
        ${nav}
        <li><a href="/sync" id="sync-chip" class="sync-chip" title="Repo sync status">●<span class="sync-chip-count"></span></a></li>
        <li><a href="/context" id="context-chip" class="sync-chip" title="Context integrity">◆<span class="sync-chip-count"></span></a></li>
        <li><a href="/conformance" id="conformance-chip" class="sync-chip" title="Agent conformance">▲<span class="sync-chip-count"></span></a></li>
        ${picker}
      </ul>
    </nav>
  </header>
  <main class="container${opts.wide ? " container-wide" : ""}">
    ${opts.content}
  </main>
  <footer class="container">
    <small>Synthesis Console v${pkg.version} — local-first tooling for synthesis engineering</small>
  </footer>
  <script>${layoutScript()}</script>
</body>
</html>`;
}

function buildNav(currentPath: string): string {
  const links = [
    { href: "/initiatives", label: "Initiatives", match: "/initiatives" },
    { href: "/projects", label: "Projects", match: "/projects" },
    { href: "/plans", label: "Plans", match: "/plans" },
    { href: "/people", label: "People", match: "/people" },
    { href: "/ledger", label: "Ledger", match: "/ledger" },
    { href: "/context", label: "Context", match: "/context" },
    { href: "/conformance", label: "Conformance", match: "/conformance" },
    { href: "/lessons", label: "Lessons", match: "/lessons" },
  ];

  return links
    .map((link) => {
      const active = currentPath.startsWith(link.match) ? ' class="active"' : "";
      return `<li><a href="${link.href}"${active}>${link.label}</a></li>`;
    })
    .join("\n");
}

function buildSourcePicker(
  sources: Source[],
  activeNames: string[],
  demoMode: boolean
): string {
  if (sources.length <= 1) return "";

  const activeSet = new Set(activeNames);
  const activeCount = sources.filter((s) => activeSet.has(s.name)).length;
  const summary =
    activeCount === sources.length
      ? "All sources"
      : activeCount === 0
        ? "No sources"
        : activeCount === 1
          ? sources.find((s) => activeSet.has(s.name))?.display_name ||
            sources.find((s) => activeSet.has(s.name))?.name ||
            "1 source"
          : `${activeCount} sources`;

  const disabled = demoMode ? " disabled" : "";
  const hint = demoMode
    ? `<p><small>Demo mode is active; source selection is disabled.</small></p>`
    : "";

  const items = sources
    .map((s) => {
      const checked = activeSet.has(s.name) ? " checked" : "";
      const label = escapeHtml(s.display_name || s.name);
      const demoLabel = s.demo
        ? ' <span class="badge badge-demo" style="font-size:0.7em">demo</span>'
        : "";
      return `<li>
        <label>
          <input type="checkbox" name="source" value="${escapeAttr(s.name)}"${checked}${disabled}>
          ${label}${demoLabel}
        </label>
      </li>`;
    })
    .join("\n");

  return `<li>
    <details class="source-picker" role="list">
      <summary aria-haspopup="listbox">${escapeHtml(summary)}</summary>
      <ul role="listbox" aria-label="Active sources">
        ${items}
      </ul>
      ${hint}
    </details>
  </li>`;
}

function layoutScript(): string {
  return `
    (function() {
      const COOKIE = ${JSON.stringify(SOURCES_COOKIE)};

      function setCookie(value) {
        // Cookie lasts 1 year. Local-only tool; no Secure/HttpOnly needed.
        document.cookie = COOKIE + '=' + encodeURIComponent(value) + '; path=/; max-age=31536000; samesite=lax';
      }

      function currentSelection() {
        return Array.from(document.querySelectorAll('input[type=checkbox][name=source]'))
          .filter(cb => cb.checked)
          .map(cb => cb.value);
      }

      const picker = document.querySelector('.source-picker');
      if (picker) {
        picker.addEventListener('change', function(e) {
          if (e.target && e.target.name === 'source') {
            const names = currentSelection();
            setCookie(names.join(','));
            try { localStorage.setItem(COOKIE, names.join(',')); } catch (_) {}
            // Reload to re-fetch content for the new selection.
            const url = new URL(window.location.href);
            url.searchParams.delete('sources');
            window.location.href = url.toString();
          }
        });
      }

      // On first visit with nothing checked but localStorage populated, sync cookie and reload.
      try {
        if (!document.cookie.split('; ').some(c => c.startsWith(COOKIE + '='))) {
          const cached = localStorage.getItem(COOKIE);
          if (cached) {
            setCookie(cached);
            window.location.reload();
          }
        }
      } catch (_) {}

      // Slack directory island: name/alias → user ID, channel name → channel ID.
      // Used for Smart Copy: rewrite @Name and #channel-name to canonical Slack
      // syntax (<@U...>, <#C...|name>) before writing to the clipboard so
      // mentions resolve when the message is pasted-and-sent in Slack.
      var __slackDir = (function () {
        try {
          var el = document.getElementById('slack-directory');
          if (!el) return { users: [], channels: [], userByKey: {}, channelByName: {} };
          var data = JSON.parse(el.textContent || '{}');
          var userByKey = {};
          (data.users || []).forEach(function (u) {
            var keys = [u.name].concat(u.aliases || []);
            keys.forEach(function (k) {
              if (!k) return;
              var nk = k.trim().toLowerCase().replace(/\\s+/g, ' ');
              if (nk && !(nk in userByKey)) userByKey[nk] = u;
            });
          });
          var channelByName = {};
          (data.channels || []).forEach(function (c) {
            channelByName[c.name.toLowerCase()] = c;
          });
          return { users: data.users || [], channels: data.channels || [], userByKey: userByKey, channelByName: channelByName };
        } catch (_) {
          return { users: [], channels: [], userByKey: {}, channelByName: {} };
        }
      })();

      function escapeRegex(s) {
        return s.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
      }

      function smartResolveMentions(text) {
        if (!text) return text;
        var result = text;

        // Channels: #name -> <#C...|name> if mapped. Skip if already preceded
        // by a left angle bracket (already canonical syntax).
        result = result.replace(/(?<!<)#([a-zA-Z][\\w-]{1,79})\\b/g, function (m, name) {
          var ch = __slackDir.channelByName[name.toLowerCase()];
          return ch ? '<#' + ch.id + '|' + name + '>' : m;
        });

        // @U... → <@U...>; skip if already canonical.
        result = result.replace(/(?<!<)@(U[A-Z0-9]{6,})\\b/g, function (_m, id) { return '<@' + id + '>'; });

        // @<DisplayName> from directory; longest first to avoid partial overrides.
        var keys = Object.keys(__slackDir.userByKey).sort(function (a, b) { return b.length - a.length; });
        if (keys.length > 0) {
          var alt = keys.map(escapeRegex).join('|');
          var re = new RegExp('(?<!<)@(' + alt + ')\\\\b', 'gi');
          result = result.replace(re, function (m, raw) {
            var u = __slackDir.userByKey[raw.trim().toLowerCase().replace(/\\s+/g, ' ')];
            return u ? '<@' + u.id + '>' : m;
          });
        }

        return result;
      }

      function getDraftText(actionsEl) {
        // Canonical source: data-original-text holds the parser's bodyText
        // (kind-aware: inside-fence content for "fenced", >-stripped content
        // for "blockquote", verbatim region for "multi-segment"). For Copy/
        // Send, this is what we want — Slack receives a paste-ready message
        // that doesn't include outer fence delimiters but does preserve
        // multi-segment internal structure.
        if (typeof actionsEl.dataset !== 'undefined' &&
            typeof actionsEl.dataset.originalText === 'string') {
          return actionsEl.dataset.originalText.replace(/\\u00A0/g, ' ').trim();
        }
        // Fallback for sections without a parser-tracked draft (rare): read
        // text from the preceding draft-body-region wrapper or directly from
        // a pre/blockquote sibling.
        var prev = actionsEl.previousElementSibling;
        if (prev && prev.classList && prev.classList.contains('draft-body-region')) {
          return (prev.innerText || prev.textContent || '').replace(/\\u00A0/g, ' ').trim();
        }
        if (prev && prev.classList && prev.classList.contains('draft-sent-body')) {
          var inner = prev.querySelector('pre, blockquote');
          if (inner) return (inner.innerText || inner.textContent || '').replace(/\\u00A0/g, ' ').trim();
        }
        if (!prev) return '';
        var raw = prev.innerText || prev.textContent || '';
        return raw.replace(/\\u00A0/g, ' ').trim();
      }

      function flashCopied(button) {
        var original = button.textContent;
        button.textContent = 'Copied';
        button.classList.add('draft-copied');
        setTimeout(function () {
          button.textContent = original;
          button.classList.remove('draft-copied');
        }, 1500);
      }

      function copyText(text, button) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(function () {
            flashCopied(button);
          }).catch(function () {
            fallbackCopy(text, button);
          });
        } else {
          fallbackCopy(text, button);
        }
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

      function findMessageEl(actionsEl) {
        // v0.8.5+: the action bar is preceded by a .draft-body-region wrapper
        // that contains the entire draft body (one fence, one blockquote, OR
        // a heterogeneous multi-segment body). The wrapper is the unit Edit
        // mode hides and shows.
        var node = actionsEl.previousElementSibling;
        while (node) {
          if (node.classList && node.classList.contains('draft-body-region')) return node;
          // Skip an existing textarea inserted by an in-progress Edit.
          if (node.tagName === 'TEXTAREA') {
            node = node.previousElementSibling;
            continue;
          }
          // Backward-compat fallback: pre-v0.8.5 augmentation wrapped a single
          // pre/blockquote without a region wrapper.
          var tag = node.tagName;
          if (tag === 'PRE' || tag === 'BLOCKQUOTE') return node;
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

        var existing = findEditTextarea(actionsEl);
        var textarea = existing;
        if (!textarea) {
          textarea = document.createElement('textarea');
          textarea.className = 'draft-textarea';
          textarea.value = original;
          textarea.spellcheck = true;
          var lineCount = original.split('\\n').length;
          textarea.rows = Math.max(5, Math.min(40, lineCount + 2));
          actionsEl.parentNode.insertBefore(textarea, actionsEl);
        }
        messageEl.style.display = 'none';
        actionsEl.dataset.mode = 'editing';
        setStatus(actionsEl, '', false);
        textarea.focus();
        // Place cursor at the end so the user can keep typing.
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
        var m = window.location.pathname.match(/^\\/plans\\/([^/]+)\\/(\\d{4}-\\d{2}-\\d{2})/);
        return m ? { source: m[1], date: m[2] } : null;
      }

      function saveDraft(actionsEl) {
        var textarea = findEditTextarea(actionsEl);
        if (!textarea) return;
        var newText = textarea.value;
        var originalText = actionsEl.dataset.originalText || '';
        var draftIndex = actionsEl.dataset.draftIndex || '';
        var base = planUrlBase();
        if (!base) {
          setStatus(actionsEl, 'Cannot determine plan URL.', true);
          return;
        }
        var url = '/plans/' + encodeURIComponent(base.source) +
                  '/' + encodeURIComponent(base.date) +
                  '/draft/' + encodeURIComponent(draftIndex);

        setStatus(actionsEl, 'Saving…', false);
        var saveBtn = actionsEl.querySelector('.draft-save');
        var cancelBtn = actionsEl.querySelector('.draft-cancel');
        if (saveBtn) saveBtn.disabled = true;
        if (cancelBtn) cancelBtn.disabled = true;

        fetch(url, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ originalText: originalText, newText: newText })
        }).then(function (res) {
          if (res.ok) {
            // Re-render with fresh data.
            window.location.reload();
            return;
          }
          return res.json().catch(function () { return null; }).then(function (body) {
            var msg = (body && body.error) ? body.error : ('Save failed (' + res.status + ').');
            setStatus(actionsEl, msg, true);
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
            // In edit mode, copy from the textarea so the user can copy-as-typed.
            var text;
            if (actions.dataset.mode === 'editing') {
              var ta = findEditTextarea(actions);
              text = ta ? ta.value : '';
            } else {
              text = getDraftText(actions);
            }
            // Smart Copy: rewrite @Name and #channel-name to canonical Slack
            // mention syntax so they resolve when pasted-and-sent in Slack.
            if (text) text = smartResolveMentions(text);
            if (text) copyText(text, copyBtn);
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
          var email = emailLink.dataset.email || '';
          var subject = emailLink.dataset.subject || '';
          var url = 'mailto:' + email;
          var qs = [];
          if (subject) qs.push('subject=' + encodeURIComponent(subject));
          if (body) qs.push('body=' + encodeURIComponent(body));
          if (qs.length) url += '?' + qs.join('&');
          window.location.href = url;
          return;
        }

        var editBtn = t.closest('.draft-edit');
        if (editBtn) {
          e.preventDefault();
          var ea = editBtn.closest('.draft-actions');
          if (ea) enterEditMode(ea);
          return;
        }

        var saveBtn = t.closest('.draft-save');
        if (saveBtn) {
          e.preventDefault();
          var sa = saveBtn.closest('.draft-actions');
          if (sa) saveDraft(sa);
          return;
        }

        var cancelBtn = t.closest('.draft-cancel');
        if (cancelBtn) {
          e.preventDefault();
          var ca = cancelBtn.closest('.draft-actions');
          if (ca) exitEditMode(ca);
          return;
        }

        var sendBtn = t.closest('.draft-send');
        if (sendBtn) {
          e.preventDefault();
          var sendActions = sendBtn.closest('.draft-actions');
          if (sendActions) openSendModal(sendActions);
          return;
        }

        // ---- v0.10 one-tap actions (NEEDS YOU) ----
        var oneTapBtn = t.closest('.cockpit-onetap-btn');
        if (oneTapBtn) {
          e.preventDefault();
          var action = oneTapBtn.dataset.onetapAction;
          var card = oneTapBtn.closest('.cockpit-onetap-draft');
          if (!card || !action) return;
          if (action === 'skip') handleOneTapSkip(card);
          else if (action === 'undo-skip') handleOneTapUndoSkip(card);
          else if (action === 'edit') handleOneTapEdit(card);
          else if (action === 'approve') handleOneTapApprove(card);
          return;
        }
      });

      // ---- v0.10 one-tap handlers ----
      function oneTapEndpoint(card, suffix) {
        var src = card.dataset.source;
        var date = card.dataset.date;
        var idx = card.dataset.draftIndex;
        return '/plans/' + encodeURIComponent(src) + '/' + encodeURIComponent(date) + '/draft/' + encodeURIComponent(idx) + suffix;
      }

      function setOneTapStatus(card, msg, cls) {
        var status = card.querySelector('.cockpit-onetap-status');
        if (!status) return;
        status.textContent = msg || '';
        status.classList.remove('cockpit-status-error', 'cockpit-status-ok');
        if (cls) status.classList.add(cls);
      }

      function setOneTapBusy(card, busy) {
        var btns = card.querySelectorAll('.cockpit-onetap-btn');
        for (var i = 0; i < btns.length; i++) btns[i].disabled = !!busy;
      }

      function handleOneTapSkip(card) {
        setOneTapBusy(card, true);
        setOneTapStatus(card, 'Marking skipped…');
        fetch(oneTapEndpoint(card, '/skip'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({})
        }).then(function (r) {
          return r.json().then(function (j) { return { status: r.status, body: j }; });
        }).then(function (res) {
          if (res.status >= 200 && res.status < 300) {
            // Trigger the mtime poller to refresh the whole plan cleanly.
            location.reload();
          } else {
            setOneTapBusy(card, false);
            setOneTapStatus(card, (res.body && res.body.error) || 'Skip failed.', 'cockpit-status-error');
          }
        }).catch(function () {
          setOneTapBusy(card, false);
          setOneTapStatus(card, 'Network error — try again.', 'cockpit-status-error');
        });
      }

      function handleOneTapUndoSkip(card) {
        setOneTapBusy(card, true);
        setOneTapStatus(card, 'Restoring…');
        fetch(oneTapEndpoint(card, '/unskip'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({})
        }).then(function (r) {
          return r.json().then(function (j) { return { status: r.status, body: j }; });
        }).then(function (res) {
          if (res.status >= 200 && res.status < 300) {
            location.reload();
          } else {
            setOneTapBusy(card, false);
            setOneTapStatus(card, (res.body && res.body.error) || 'Undo failed.', 'cockpit-status-error');
          }
        }).catch(function () {
          setOneTapBusy(card, false);
          setOneTapStatus(card, 'Network error — try again.', 'cockpit-status-error');
        });
      }

      function handleOneTapEdit(card) {
        var details = card.querySelector('.cockpit-onetap-body');
        if (details && !details.open) details.open = true;
        var content = card.querySelector('.cockpit-onetap-body-content');
        if (!content) return;
        var originalBody = card.dataset.bodyText || '';
        if (card.dataset.mode === 'editing') return;
        card.dataset.mode = 'editing';
        card.dataset.originalBody = originalBody;
        var ta = document.createElement('textarea');
        ta.className = 'cockpit-onetap-editor';
        ta.value = originalBody;
        ta.rows = Math.max(3, originalBody.split('\\n').length + 1);
        var actionRow = document.createElement('div');
        actionRow.className = 'cockpit-onetap-editor-actions';
        actionRow.innerHTML = '<button type="button" class="cockpit-onetap-btn cockpit-onetap-btn-cancel">Cancel</button>' +
                              '<button type="button" class="cockpit-onetap-btn cockpit-onetap-btn-save">Save</button>';
        content.style.display = 'none';
        content.parentNode.appendChild(ta);
        content.parentNode.appendChild(actionRow);
        ta.focus();
        actionRow.querySelector('.cockpit-onetap-btn-cancel').addEventListener('click', function () {
          exitOneTapEdit(card);
        });
        actionRow.querySelector('.cockpit-onetap-btn-save').addEventListener('click', function () {
          saveOneTapEdit(card, ta.value);
        });
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
          if (res.status >= 200 && res.status < 300) {
            location.reload();
          } else {
            setOneTapBusy(card, false);
            setOneTapStatus(card, (res.body && res.body.error) || 'Save failed.', 'cockpit-status-error');
          }
        }).catch(function () {
          setOneTapBusy(card, false);
          setOneTapStatus(card, 'Network error — try again.', 'cockpit-status-error');
        });
      }

      function handleOneTapApprove(card) {
        var body = card.dataset.bodyText || '';
        var slackConfigured = card.querySelector('[data-slack-configured="true"]');
        var tierAEnabled = card.querySelector('[data-tier-a-enabled="true"]');
        if (!slackConfigured) {
          // Slack not configured — copy the body and open Slack's web app.
          var copyResolved = smartResolveMentions(body);
          copyText(copyResolved, card.querySelector('.cockpit-onetap-btn-approve'));
          setOneTapStatus(card, 'Copied — paste into Slack. Then click Skip if you sent it.', 'cockpit-status-ok');
          return;
        }
        // Slack configured — use the same confirm modal as the standard
        // draft send path. Build a minimal draft-actions element so
        // openSendModal has what it needs; the modal reads dataset.source,
        // dataset.date, dataset.draftIndex from the closest .cockpit-view
        // wrapper and the closest .draft-actions.
        // openSendModal walks up the DOM to find the cockpit-view element
        // (which carries data-source / data-date) and reads dataset.draftIndex
        // from the actions element. getDraftText reads dataset.originalText.
        // Build a hidden proxy inside the card that satisfies both lookups
        // without duplicating any of the send-modal wiring below.
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

      // ---- Send-to-Slack confirm modal ----
      // Created on demand and reused across sends.
      var __sendModal = null;

      function buildSendModal() {
        var overlay = document.createElement('div');
        overlay.className = 'send-modal-overlay';
        overlay.innerHTML = '<div class="send-modal" role="dialog" aria-labelledby="send-modal-title">' +
          '<h3 id="send-modal-title" class="send-modal-title">Send to Slack</h3>' +
          '<div class="send-modal-meta"></div>' +
          '<div class="send-modal-mentions"></div>' +
          '<div class="send-modal-preview-label">Preview (with mentions resolved):</div>' +
          '<pre class="send-modal-preview"></pre>' +
          '<div class="send-modal-status" role="status" aria-live="polite"></div>' +
          '<div class="send-modal-actions">' +
            '<button type="button" class="send-modal-cancel">Cancel</button>' +
            '<button type="button" class="send-modal-confirm">Send</button>' +
          '</div>' +
        '</div>';
        overlay.addEventListener('click', function (ev) {
          if (ev.target === overlay) closeSendModal();
        });
        overlay.querySelector('.send-modal-cancel').addEventListener('click', closeSendModal);
        overlay.querySelector('.send-modal-confirm').addEventListener('click', confirmSend);
        document.body.appendChild(overlay);
        return overlay;
      }

      function ensureSendModal() {
        if (!__sendModal) __sendModal = buildSendModal();
        return __sendModal;
      }

      function setSendModalStatus(msg, isError) {
        var modal = ensureSendModal();
        var s = modal.querySelector('.send-modal-status');
        s.textContent = msg || '';
        s.classList.toggle('send-modal-status-error', !!isError);
      }

      function setSendModalButtonsDisabled(disabled) {
        var modal = ensureSendModal();
        modal.querySelector('.send-modal-confirm').disabled = !!disabled;
        modal.querySelector('.send-modal-cancel').disabled = !!disabled;
      }

      var __sendModalTargetActions = null;

      function openSendModal(actionsEl) {
        __sendModalTargetActions = actionsEl;
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

        var base = planUrlBase();
        var idx = actionsEl.dataset.draftIndex;
        if (!base || idx === undefined) {
          meta.textContent = 'Could not determine plan URL.';
          return;
        }

        var url = '/plans/' + encodeURIComponent(base.source) +
                  '/' + encodeURIComponent(base.date) +
                  '/draft/' + encodeURIComponent(idx) +
                  '/preflight';

        fetch(url).then(function (res) {
          return res.json().then(function (json) { return { ok: res.ok, body: json }; });
        }).then(function (r) {
          if (!r.ok || !r.body || r.body.ok === false) {
            meta.textContent = (r.body && r.body.error) ? r.body.error : 'Preflight failed.';
            setSendModalButtonsDisabled(true);
            return;
          }
          var b = r.body;
          var sendTo = b.sendToText ? b.sendToText.replace(/\\s+/g, ' ').trim() : '(unknown target)';
          meta.innerHTML = '<strong>To:</strong> ' + escapeText(sendTo);

          var mlines = [];
          if (b.mentions && b.mentions.users && b.mentions.users.length > 0) {
            mlines.push('Will mention: ' + b.mentions.users.map(function (u) { return '@' + u.display; }).join(', '));
          }
          if (b.mentions && b.mentions.channels && b.mentions.channels.length > 0) {
            mlines.push('Channels: ' + b.mentions.channels.map(function (c) { return '#' + c.display; }).join(', '));
          }
          if (b.mentions && b.mentions.unresolved && b.mentions.unresolved.length > 0) {
            mlines.push('Unresolved (will send as plain text): ' + b.mentions.unresolved.map(function (u) { return u.raw; }).join(', '));
          }
          mentionsEl.textContent = mlines.join('\\n');

          preview.textContent = b.bodyResolved || b.bodyOriginal || '';

          if (!b.tokenConfigured) {
            meta.innerHTML += ' <span class="send-modal-warn">(Slack token not configured — Send disabled.)</span>';
            setSendModalButtonsDisabled(true);
          }
        }).catch(function (err) {
          meta.textContent = 'Network error: ' + (err && err.message ? err.message : 'unknown');
          setSendModalButtonsDisabled(true);
        });
      }

      function closeSendModal() {
        if (__sendModal) __sendModal.classList.remove('visible');
        __sendModalTargetActions = null;
      }

      function confirmSend() {
        var actions = __sendModalTargetActions;
        if (!actions) return;
        var base = planUrlBase();
        if (!base) { setSendModalStatus('Cannot determine plan URL.', true); return; }
        var idx = actions.dataset.draftIndex;
        var url = '/plans/' + encodeURIComponent(base.source) +
                  '/' + encodeURIComponent(base.date) +
                  '/draft/' + encodeURIComponent(idx) +
                  '/send';

        setSendModalStatus('Sending…', false);
        setSendModalButtonsDisabled(true);

        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirmed: true })
        }).then(function (res) {
          return res.json().then(function (json) { return { ok: res.ok, body: json }; });
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
          var msg = (r.body && r.body.error) ? r.body.error : ('Send failed (' + (r.ok ? 'unknown' : 'HTTP ' + r.body && r.body.status) + ').');
          setSendModalStatus(msg, true);
          setSendModalButtonsDisabled(false);
        }).catch(function (err) {
          setSendModalStatus('Network error: ' + (err && err.message ? err.message : 'unknown'), true);
          setSendModalButtonsDisabled(false);
        });
      }

      function escapeText(s) {
        var div = document.createElement('div');
        div.textContent = s;
        return div.innerHTML;
      }

      // Escape-key on the modal closes it.
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && __sendModal && __sendModal.classList.contains('visible')) {
          closeSendModal();
        }
      });

      // Keyboard shortcuts inside the edit textarea: Cmd/Ctrl+Enter saves, Escape cancels.
      document.addEventListener('keydown', function (e) {
        var ta = e.target;
        if (!ta || ta.tagName !== 'TEXTAREA' || !ta.classList || !ta.classList.contains('draft-textarea')) return;
        var actions = ta.nextElementSibling;
        if (!actions || !actions.classList.contains('draft-actions')) return;
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          e.preventDefault();
          saveDraft(actions);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          exitEditMode(actions);
        }
      });

      // ===== Cockpit handlers (decision pick, task check, filter, find) =====

      function cockpitView() {
        return document.querySelector('.cockpit-view');
      }

      function cockpitBase() {
        var v = cockpitView();
        if (!v) return null;
        return { source: v.dataset.source, date: v.dataset.date, editable: v.dataset.editable === 'true' };
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
        var idx = card.dataset.decisionIndex;
        var option = button.dataset.option;
        var statusEl = card.querySelector('.cockpit-decision-status');
        setCockpitStatus(statusEl, 'Recording…', false);

        // Disable all option buttons in this card during the request.
        var opts = card.querySelectorAll('.cockpit-decision-option');
        opts.forEach(function (b) { b.disabled = true; });

        var url = '/plans/' + encodeURIComponent(base.source) +
                  '/' + encodeURIComponent(base.date) +
                  '/decision/' + encodeURIComponent(idx);
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ option: option, decidedAtIso: new Date().toISOString().replace('T', ' ').replace(/\\.\\d+Z$/, ' UTC') })
        }).then(function (res) {
          return res.json().then(function (json) { return { ok: res.ok, body: json }; });
        }).then(function (r) {
          if (r.ok && r.body && r.body.ok) {
            window.location.reload();
            return;
          }
          var msg = (r.body && r.body.error) ? r.body.error : 'Could not record decision.';
          setCockpitStatus(statusEl, msg, true);
          opts.forEach(function (b) { b.disabled = false; });
        }).catch(function (err) {
          setCockpitStatus(statusEl, 'Network error: ' + (err && err.message ? err.message : 'unknown'), true);
          opts.forEach(function (b) { b.disabled = false; });
        });
      }

      function formatLocalCockpitTime(d) {
        // "11:14 EDT" — matches the existing in-plan convention.
        try {
          var s = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short' }).format(d);
          return s.replace(/^24:/, '00:');
        } catch (_) {
          var hh = String(d.getHours()).padStart(2, '0');
          var mm = String(d.getMinutes()).padStart(2, '0');
          return hh + ':' + mm;
        }
      }

      function handleTaskToggle(checkbox) {
        var task = checkbox.closest('.cockpit-task');
        if (!task) return;
        var base = cockpitBase();
        if (!base || !base.editable) {
          checkbox.checked = !checkbox.checked; // revert
          return;
        }
        var idx = task.dataset.taskIndex;
        var originalText = task.dataset.originalText || '';
        var statusEl = task.querySelector('.cockpit-task-status');
        var willBeDone = checkbox.checked;

        checkbox.disabled = true;
        setCockpitStatus(statusEl, willBeDone ? 'Marking done…' : 'Reopening…', false);

        var url = '/plans/' + encodeURIComponent(base.source) +
                  '/' + encodeURIComponent(base.date) +
                  '/task/' + encodeURIComponent(idx) +
                  '/' + (willBeDone ? 'done' : 'undone');

        var payload = { originalText: originalText };
        if (willBeDone) {
          payload.doneAtLocal = formatLocalCockpitTime(new Date());
        }

        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        }).then(function (res) {
          return res.json().then(function (json) { return { ok: res.ok, body: json }; });
        }).then(function (r) {
          if (r.ok && r.body && r.body.ok) {
            window.location.reload();
            return;
          }
          var msg = (r.body && r.body.error) ? r.body.error : 'Could not update task.';
          setCockpitStatus(statusEl, msg, true);
          // Revert the checkbox state.
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
        var chips = view.querySelectorAll('.cockpit-filter-chip');
        chips.forEach(function (c) {
          c.classList.toggle('cockpit-filter-active', c.dataset.filter === filter);
        });
        if (filter === 'find') {
          openCockpitFind();
          // Don't change focus state; find is overlaid.
          return;
        }
        document.body.dataset.cockpitFocus = filter === 'focus' ? 'true' : 'false';
        if (filter !== 'find') {
          closeCockpitFind();
        }
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

      function closeCockpitFind() {
        var bar = findBar();
        if (!bar) return;
        bar.hidden = true;
        clearFindHighlights();
        // Restore the previously-active chip — Focus or All.
        var view = cockpitView();
        if (view && document.body.dataset.cockpitFocus === 'true') {
          applyCockpitFilter('focus');
        } else {
          applyCockpitFilter('all');
        }
      }

      function clearFindHighlights() {
        var view = cockpitView();
        if (!view) return;
        view.querySelectorAll('.cockpit-find-match').forEach(function (el) {
          el.classList.remove('cockpit-find-match');
        });
      }

      function runCockpitFind(query) {
        clearFindHighlights();
        var view = cockpitView();
        if (!view || !query) return { hits: 0 };
        var q = query.toLowerCase();
        var hits = 0;
        var firstHit = null;

        // Walk text-bearing leaf elements.
        var candidates = view.querySelectorAll('.cockpit-task-body, .cockpit-decision-question, .cockpit-decision-body, .cockpit-collapsible-body p, .cockpit-collapsible-body li, .cockpit-collapsible-body h3, .cockpit-collapsible-body h4');
        candidates.forEach(function (el) {
          var t = (el.textContent || '').toLowerCase();
          if (t.indexOf(q) !== -1) {
            el.classList.add('cockpit-find-match');
            hits++;
            if (!firstHit) firstHit = el;
            // Open ancestor <details>.
            var p = el.parentElement;
            while (p && p !== view) {
              if (p.tagName === 'DETAILS') p.open = true;
              p = p.parentElement;
            }
          }
        });

        if (firstHit) {
          firstHit.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        return { hits: hits };
      }

      // Delegated click for cockpit interactions.
      document.addEventListener('click', function (e) {
        var t = e.target;
        if (!t || !t.closest) return;

        var optBtn = t.closest('.cockpit-decision-option');
        if (optBtn && !optBtn.disabled) {
          e.preventDefault();
          handleDecisionPick(optBtn);
          return;
        }

        var chip = t.closest('.cockpit-filter-chip');
        if (chip) {
          e.preventDefault();
          applyCockpitFilter(chip.dataset.filter);
          return;
        }

        var findClose = t.closest('.cockpit-find-close');
        if (findClose) {
          e.preventDefault();
          closeCockpitFind();
          return;
        }
      });

      // Delegated change for task checkboxes (so we capture the user's intent
      // before the browser persists the new state, in case we need to revert).
      document.addEventListener('change', function (e) {
        var cb = e.target;
        if (!cb || !cb.classList || !cb.classList.contains('cockpit-task-check')) return;
        handleTaskToggle(cb);
      });

      // Find input: live filter on input.
      document.addEventListener('input', function (e) {
        var input = e.target;
        if (!input || !input.classList || !input.classList.contains('cockpit-find-input')) return;
        var bar = input.closest('.cockpit-find-bar');
        var status = bar ? bar.querySelector('.cockpit-find-status') : null;
        var result = runCockpitFind(input.value);
        if (status) status.textContent = input.value ? (result.hits + ' match' + (result.hits === 1 ? '' : 'es')) : '';
      });

      // Escape closes the find bar; Cmd/Ctrl+F opens it (without preventing
      // browser-native find from also working — we just mirror it).
      document.addEventListener('keydown', function (e) {
        if (!cockpitView()) return;
        if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F')) {
          // Open the cockpit find bar but DO NOT preventDefault — let the
          // browser's native find run too. The cockpit's find-and-expand
          // covers collapsed sections that the browser won't reach.
          var bar = findBar();
          if (bar && bar.hidden) {
            // Don't auto-focus the input (would steal from browser find);
            // just unhide so the user can click it.
            bar.hidden = false;
          }
        }
        if (e.key === 'Escape') {
          var bar2 = findBar();
          if (bar2 && !bar2.hidden) {
            closeCockpitFind();
          }
        }
      });

      // ===== Cockpit auto-refresh on file mtime change =====
      //
      // The plan file is written by multiple actors throughout the day:
      //   - the human (this UI's write-back; manual edits in another editor)
      //   - the daily-rituals skill (morning/mid-day/end-of-day rituals)
      //   - the slack-sync skill (carries new threads into briefing)
      //   - any automation that appends to the file
      //
      // Without polling, the page silently drifts: the human sees decisions
      // and tasks frozen at page-load time even after the file changed. This
      // poller closes the gap by checking the file's mtime every 30s and
      // soft-reloading when it has advanced beyond what we rendered.
      //
      // Skip rules — never reload while:
      //   - a draft Edit textarea is open (would lose unsaved typing)
      //   - the Send-to-Slack confirm modal is visible
      //   - a decision is currently being recorded (button disabled mid-flight)
      //   - any input/textarea inside the cockpit holds focus (user is typing)
      //   - the document is hidden (no point reloading what no one is looking at;
      //     the next focus event will trigger an immediate check)
      //
      // The reload uses window.location.reload() — same as the existing
      // post-mutation reloads. The browser's no-store headers guarantee fresh
      // content; the page rerenders cleanly with the new mtime baseline.
      var __mtimePollHandle = null;
      var __mtimePollVisHandle = null;
      var __mtimePollIntervalMs = 30000;
      var __mtimePollInflight = false;

      function isCockpitBusy() {
        var view = cockpitView();
        if (!view) return false;
        // Edit-mode textarea anywhere on the page.
        if (document.querySelector('.draft-textarea')) return true;
        // Send modal is visible.
        var modal = document.querySelector('.send-modal-overlay.visible');
        if (modal) return true;
        // A decision option is mid-request (we disable buttons during the call).
        var pendingDecision = view.querySelector('.cockpit-decision[data-decided="false"] .cockpit-decision-option:disabled');
        if (pendingDecision) return true;
        // A task checkbox is mid-request.
        var pendingTask = view.querySelector('.cockpit-task-check:disabled:not([data-readonly="true"])');
        if (pendingTask) {
          // Read-only checkboxes (demo source) are always disabled — exclude them.
          var task = pendingTask.closest('.cockpit-task');
          if (task && task.dataset.readonly !== 'true') return true;
        }
        // User is typing into the find input or any focused textarea/input.
        var ae = document.activeElement;
        if (ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT')) {
          // The find input is fine to interrupt with a reload; only block on
          // typing into editable surfaces (textarea = draft body / find input
          // is OK to reload because find filters DOM only).
          if (ae.tagName === 'TEXTAREA') return true;
          // INPUT — only block on the search/text find input if it has a value
          // the user might lose (we don't store search queries server-side).
          if (ae.classList && ae.classList.contains('cockpit-find-input') && ae.value) return true;
        }
        return false;
      }

      function checkMtime() {
        if (__mtimePollInflight) return;
        if (document.hidden) return;
        var view = cockpitView();
        if (!view) return;
        var source = view.dataset.source;
        var date = view.dataset.date;
        var baseline = parseFloat(view.dataset.mtimeMs || '0');
        if (!source || !date || !baseline) return;

        var url = '/plans/' + encodeURIComponent(source) +
                  '/' + encodeURIComponent(date) + '/mtime';
        __mtimePollInflight = true;
        fetch(url, { cache: 'no-store' }).then(function (res) {
          if (!res.ok) return null;
          return res.json();
        }).then(function (body) {
          __mtimePollInflight = false;
          if (!body || body.ok !== true) return;
          var serverMtime = parseFloat(body.mtimeMs);
          if (!serverMtime || serverMtime <= baseline) return;
          if (isCockpitBusy()) {
            // Defer: the next tick will pick it up once the user is idle.
            return;
          }
          // The file is newer than what we rendered — reload to show fresh state.
          window.location.reload();
        }).catch(function () {
          __mtimePollInflight = false;
        });
      }

      function startMtimePoller() {
        if (__mtimePollHandle) return;
        if (!cockpitView()) return;
        __mtimePollHandle = setInterval(checkMtime, __mtimePollIntervalMs);
        // Also re-check on focus (returning to the tab after a long idle).
        if (!__mtimePollVisHandle) {
          __mtimePollVisHandle = function () { if (!document.hidden) checkMtime(); };
          document.addEventListener('visibilitychange', __mtimePollVisHandle);
          window.addEventListener('focus', __mtimePollVisHandle);
        }
      }

      // Start the poller after the page settles, but only on cockpit views.
      if (cockpitView()) {
        // Defer first poll by a few seconds — no need to race against the
        // initial render.
        setTimeout(startMtimePoller, 5000);
      }

      // ===== v0.9.1: sidebar hide/show toggles =====
      //
      // The three-column shell can feel constraining when the user wants
      // to focus on a long active draft. Either sidebar can be hidden via
      // a small toggle in its header; state persists in localStorage so
      // the choice survives reloads. With both sidebars hidden, the main
      // column expands to fill the freed width.
      var SIDEBAR_LEFT_KEY = 'sc_cockpit_left_hidden';
      var SIDEBAR_RIGHT_KEY = 'sc_cockpit_right_hidden';

      function applySidebarState() {
        var shell = document.querySelector('.cockpit-shell');
        if (!shell) return;
        var leftHidden = false;
        var rightHidden = false;
        try {
          leftHidden = localStorage.getItem(SIDEBAR_LEFT_KEY) === 'true';
          rightHidden = localStorage.getItem(SIDEBAR_RIGHT_KEY) === 'true';
        } catch (_) {}
        shell.dataset.hideLeft = leftHidden ? 'true' : 'false';
        shell.dataset.hideRight = rightHidden ? 'true' : 'false';
        // Update the show buttons' visibility based on hidden state.
        var showLeft = document.querySelector('.cockpit-show-left-btn');
        var showRight = document.querySelector('.cockpit-show-right-btn');
        if (showLeft) showLeft.hidden = !leftHidden;
        if (showRight) showRight.hidden = !rightHidden;
      }

      function toggleSidebar(side) {
        var key = side === 'left' ? SIDEBAR_LEFT_KEY : SIDEBAR_RIGHT_KEY;
        var current = false;
        try { current = localStorage.getItem(key) === 'true'; } catch (_) {}
        try { localStorage.setItem(key, current ? 'false' : 'true'); } catch (_) {}
        applySidebarState();
      }

      document.addEventListener('click', function(e) {
        var t = e.target;
        if (!t || !t.closest) return;
        var hideBtn = t.closest('.cockpit-aside-hide-btn');
        if (hideBtn) {
          e.preventDefault();
          toggleSidebar(hideBtn.dataset.side);
          return;
        }
        var showBtn = t.closest('.cockpit-show-left-btn, .cockpit-show-right-btn');
        if (showBtn) {
          e.preventDefault();
          var side = showBtn.classList.contains('cockpit-show-left-btn') ? 'left' : 'right';
          toggleSidebar(side);
          return;
        }
      });

      // Apply persisted sidebar state on initial load.
      if (cockpitView()) applySidebarState();

      // ===== Repo-sync chip (synthesis-repo-guard v2) =====
      //
      // Ambient sync status in the nav on every page. Polls the read-only
      // status endpoint every 5 minutes (plus once at load). The endpoint
      // itself refreshes the underlying detector report when stale, so the
      // chip stays current without any mutating background job. Colors:
      //   green  — all repos clean & pushed
      //   amber  — repos need attention (dirty/ahead/behind)
      //   red    — checkpoint alerts need a human (divergence, blocked hook)
      //   gray   — repo-guard skill not installed / status unavailable
      // A 🔇 suffix mirrors the quiet-audio mute state.
      var SYNC_POLL_MS = 5 * 60 * 1000;

      function renderSyncChip(data) {
        var chip = document.getElementById('sync-chip');
        if (!chip) return;
        var count = chip.querySelector('.sync-chip-count');
        chip.classList.remove('sync-ok', 'sync-dirty', 'sync-alert', 'sync-na');
        if (!data || data.installed === false) {
          chip.classList.add('sync-na');
          chip.title = 'Repo sync: status unavailable';
          if (count) count.textContent = '';
          return;
        }
        var cls = 'sync-ok';
        var label = 'all repos synced';
        if (data.alertCount > 0) {
          cls = 'sync-alert';
          label = data.alertCount + ' checkpoint alert(s) need you';
        } else if (data.dirtyCount > 0) {
          cls = 'sync-dirty';
          label = data.dirtyCount + ' repo(s) with unsynced changes';
        }
        chip.classList.add(cls);
        var muted = data.quietAudio ? ' · audio muted' : '';
        chip.title = 'Repo sync: ' + label + (data.generatedAt ? ' (as of ' + data.generatedAt + ')' : '') + muted;
        if (count) {
          var n = data.alertCount > 0 ? data.alertCount : data.dirtyCount;
          count.textContent = (n > 0 ? String(n) : '') + (data.quietAudio ? '🔇' : '');
        }
      }

      function pollSyncChip() {
        if (!document.getElementById('sync-chip')) return;
        fetch('/api/sync-status', { cache: 'no-store' })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(renderSyncChip)
          .catch(function () { renderSyncChip(null); });
      }

      if (document.getElementById('sync-chip')) {
        pollSyncChip();
        setInterval(pollSyncChip, SYNC_POLL_MS);
        document.addEventListener('visibilitychange', function () {
          if (!document.hidden) pollSyncChip();
        });
      }

      // Context-integrity chip: green — corpus clean; amber — defects in the
      // durable layer; gray — no report and no doctor. Same visual language
      // as the sync chip; the number is the defect count.
      function renderContextChip(data) {
        var chip = document.getElementById('context-chip');
        if (!chip) return;
        var count = chip.querySelector('.sync-chip-count');
        chip.classList.remove('sync-ok', 'sync-dirty', 'sync-alert', 'sync-na');
        if (!data || (data.defects === null && !data.doctorAvailable)) {
          chip.classList.add('sync-na');
          chip.title = 'Context integrity: status unavailable';
          if (count) count.textContent = '';
          return;
        }
        var defects = data.defects || 0;
        chip.classList.add(defects > 0 ? 'sync-dirty' : 'sync-ok');
        chip.title = 'Context integrity: ' + (defects > 0 ? defects + ' defect(s) in the durable layer' : 'corpus clean')
          + (data.generatedAt ? ' (as of ' + data.generatedAt + ')' : '')
          + (data.auditing ? ' · audit running' : '');
        if (count) count.textContent = defects > 0 ? String(defects) : '';
      }

      function pollContextChip() {
        if (!document.getElementById('context-chip')) return;
        fetch('/api/context-status', { cache: 'no-store' })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(renderContextChip)
          .catch(function () { renderContextChip(null); });
      }

      if (document.getElementById('context-chip')) {
        pollContextChip();
        setInterval(pollContextChip, SYNC_POLL_MS);
        document.addEventListener('visibilitychange', function () {
          if (!document.hidden) pollContextChip();
        });
      }

      // Agent-conformance chip: green only for fresh PASS evidence; amber for
      // stale/unknown results; red for required failures; gray when both the
      // checker and its evidence cache are unavailable.
      function renderConformanceChip(data) {
        var chip = document.getElementById('conformance-chip');
        if (!chip) return;
        var count = chip.querySelector('.sync-chip-count');
        chip.classList.remove('sync-ok', 'sync-dirty', 'sync-alert', 'sync-na');
        if (data && data.auditError) {
          chip.classList.add('sync-dirty');
          chip.title = 'Agent conformance: audit error · ' + data.auditError;
          if (count) count.textContent = '!';
          return;
        }
        if (!data || (!data.conformanceAvailable && !data.status)) {
          chip.classList.add('sync-na');
          chip.title = 'Agent conformance: status unavailable';
          if (count) count.textContent = '';
          return;
        }
        var failures = data.requiredFailures || 0;
        var cls = failures > 0 ? 'sync-alert' : (data.stale || data.status !== 'PASS' ? 'sync-dirty' : 'sync-ok');
        chip.classList.add(cls);
        var label = failures > 0
          ? failures + ' required failure(s)'
          : (data.stale ? 'evidence stale' : (data.status || 'no recorded result'));
        chip.title = 'Agent conformance: ' + label
          + (data.checkedAt ? ' (as of ' + data.checkedAt + ')' : '')
          + (data.auditing ? ' · audit running' : '');
        if (count) count.textContent = failures > 0 ? String(failures) : (data.stale ? '!' : '');
      }

      function pollConformanceChip() {
        if (!document.getElementById('conformance-chip')) return;
        fetch('/api/conformance-status', { cache: 'no-store' })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(renderConformanceChip)
          .catch(function () { renderConformanceChip(null); });
      }

      if (document.getElementById('conformance-chip')) {
        pollConformanceChip();
        setInterval(pollConformanceChip, SYNC_POLL_MS);
        document.addEventListener('visibilitychange', function () {
          if (!document.hidden) pollConformanceChip();
        });
      }
    })();
  `;
}
