/* Outreach Studio — front-end glue.
 * Vanilla JS. No build step.
 */

(function () {
  'use strict';

  function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatRelative(iso) {
    if (!iso) return 'never';
    const then = new Date(iso.replace(' ', 'T') + 'Z');
    const diffSec = Math.floor((Date.now() - then.getTime()) / 1000);
    if (Number.isNaN(diffSec)) return iso;
    if (diffSec < 60) return `${diffSec}s ago`;
    const m = Math.floor(diffSec / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    return `${d}d ago`;
  }

  const statusLabels = {
    not_started: 'cold',
    contacts_loaded: 'people added',
    drafts_ready: 'ready to send',
    sending: 'in the air',
    done: 'wrapped up',
  };

  function statusBadge(status) {
    const chipClass = {
      not_started: 'chip-cold',
      contacts_loaded: 'chip-warm',
      drafts_ready: 'chip-ready',
      sending: 'chip-live',
      done: 'chip-done',
    }[status] || 'chip-cold';
    const label = statusLabels[status] || status;
    return `<span class="chip ${chipClass}">${escapeHtml(label)}</span>`;
  }

  async function api(path, options = {}) {
    const opts = { headers: {}, ...options };
    if (opts.body && typeof opts.body !== 'string' && !(opts.body instanceof FormData)) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
    }
    const res = await fetch(path, opts);
    if (res.status === 204) return null;
    const text = await res.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { /* non-json */ }
    }
    if (!res.ok) {
      const message = (data && data.error && data.error.message) || res.statusText || `HTTP ${res.status}`;
      const err = new Error(message);
      err.payload = data;
      throw err;
    }
    return data;
  }

  // -------------------------------------------------------------------------
  // Home dashboard
  // -------------------------------------------------------------------------
  const KPI_DEFS = [
    { key: 'companies_tracked', label: 'Campaigns' },
    { key: 'contacts_loaded',   label: 'Humans' },
    { key: 'drafts_ready',      label: 'Drafted' },
    { key: 'sent_today',        label: 'Sent today' },
    { key: 'replies_received',  label: 'Replied' },
    { key: 'suppressed',        label: 'Opted-out' },
  ];

  function renderKpi(value, label) {
    return `
      <div class="card card-hover p-4">
        <div class="text-[0.65rem] uppercase tracking-widest text-[rgb(var(--ink-muted))] font-semibold">${escapeHtml(label)}</div>
        <div class="mt-1.5 text-3xl font-semibold tabular-nums text-ink-grad">${value}</div>
      </div>`;
  }

  function eventLine(e) {
    const m = e.metadata || {};
    const labels = {
      campaign_created: () => `Company "${escapeHtml(m.name || '')}" added`,
      campaign_deleted: () => `Company "${escapeHtml(m.name || '')}" deleted`,
      campaign_started: () => `Campaign queued (${m.queued || 0} draft${m.queued === 1 ? '' : 's'})`,
      campaign_paused: () => `Campaign paused`,
      campaign_resumed: () => `Campaign resumed`,
      campaign_completed: () => `Campaign completed`,
      contacts_uploaded: () => `Contacts uploaded (${m.inserted || 0} new, ${m.updated || 0} updated)`,
      cv_uploaded: () => `CV uploaded`,
      artifact_uploaded: () => `Artifact uploaded`,
      draft_generated: () => `Draft generated (tokens in ${m.tokens?.input ?? '?'}, out ${m.tokens?.output ?? '?'})`,
      draft_regenerated: () => `Draft regenerated`,
      draft_edited: () => `Draft edited`,
      draft_approved: () => `Draft approved`,
      email_sent: () => `Email sent to ${escapeHtml(m.recipient || '')}`,
      email_failed: () => `Email failed: ${escapeHtml((m.error || '').slice(0, 80))}`,
      email_bounced: () => `Email bounced from ${escapeHtml(m.recipient || '')}`,
      reply_detected: () => `Reply detected from ${escapeHtml(m.sender || '')}`,
      unsubscribe_received: () => `Unsubscribe from ${escapeHtml(m.email || '')}`,
      suppression_added: () => `Suppression added (${escapeHtml(m.email || '')}, ${escapeHtml(m.reason || '')})`,
    };
    // Cover-letter events and settings events — add readable labels for raw types
    const extra = {
      cover_letter_uploaded: () => `Cover letter uploaded`,
      cover_letter_saved: () => `Cover letter saved`,
      settings_throttle_updated: () => `Send throttle updated`,
      settings_schedule_updated: () => `Working hours updated`,
      settings_gmail_updated: () => `Gmail settings saved`,
      settings_updated: () => `Settings saved`,
      batch_generated: () => `Batch drafts generated (${m.count || 0})`,
      batch_queued: () => `Batch queued (${m.count || 0})`,
    };
    const render = labels[e.event_type] || extra[e.event_type];
    // Fallback: turn snake_case into readable "Snake case"
    if (!render) {
      const readable = e.event_type.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
      return escapeHtml(readable);
    }
    return render();
  }

  function renderKpiChip(value, label, index, animate) {
    const animClass  = animate ? ' chip-pop' : '';
    const animStyle  = animate ? `animation-delay:${index * 65}ms; ` : '';
    const valClass   = animate ? ' num-reveal' : '';
    const valDelay   = animate ? ` animation-delay:${index * 65 + 80}ms;` : '';
    return `<div class="stat-chip${animClass} card-glow" data-kpi-idx="${index}" style="${animStyle}transition:transform 200ms,border-color 200ms,box-shadow 200ms;">
      <div class="stat-chip__value${valClass}" style="${valDelay}">${escapeHtml(String(value))}</div>
      <div class="stat-chip__label">${escapeHtml(label)}</div>
    </div>`;
  }

  async function loadHome() {
    const grid = document.querySelector('#home-kpis');
    if (!grid) return;

    let data;
    try {
      data = await api('/api/dashboard');
    } catch (err) {
      grid.innerHTML = `<div class="col-span-6 text-xs" style="color:rgb(var(--rose));">Failed: ${escapeHtml(err.message)}</div>`;
      return;
    }

    // Render KPI chips — animate on first load; update values in-place on refresh
    const isFirstRender = !grid.querySelector('.stat-chip');
    if (isFirstRender) {
      grid.innerHTML = KPI_DEFS.map(({ key, label }, i) => renderKpiChip(data.kpis[key] ?? 0, label, i, true)).join('');
    } else {
      KPI_DEFS.forEach(({ key }, i) => {
        const valueEl = grid.querySelector(`[data-kpi-idx="${i}"] .stat-chip__value`);
        if (valueEl) valueEl.textContent = String(data.kpis[key] ?? 0);
      });
    }

    const stopAllBtn = document.querySelector('#home-stop-all');
    if (stopAllBtn) stopAllBtn.classList.toggle('hidden', !data.any_sending);
  }

  // Renders campaigns + cost + activity into the log-page status panels.
  // Shares the same /api/dashboard data; can be called from any page that has those IDs.
  function applyStatusData(data, prefix) {
    const p = prefix || 'log';
    const activity  = document.querySelector(`#${p}-activity`);
    const campaigns = document.querySelector(`#${p}-campaigns`);

    // Activity feed
    if (activity) {
      if (!data.recent_activity || data.recent_activity.length === 0) {
        activity.innerHTML = `<li class="activity-row py-1" style="color:rgb(var(--ink-faint));font-size:0.7rem;">Nothing yet. Make a move.</li>`;
      } else {
        activity.innerHTML = data.recent_activity.map((e, i) => `
          <li class="activity-row" style="animation-delay:${i * 22}ms">
            <span class="text-[0.72rem] leading-tight flex-1 min-w-0 truncate" style="color:rgb(var(--ink-muted));">${eventLine(e)}</span>
            <span class="text-[0.58rem] whitespace-nowrap tabular-nums flex-none" style="color:rgb(var(--ink-faint));">${escapeHtml(formatRelative(e.created_at))}</span>
          </li>`).join('');
      }
    }

    // Campaigns in flight
    if (campaigns) {
      const sending = data.sending_campaigns || [];
      const paused  = data.paused_campaigns  || [];
      const combined = [
        ...sending.map((c) => ({ ...c, badge: 'sending', dotColor: 'rgb(var(--emerald))' })),
        ...paused.map((c)  => ({ ...c, badge: 'paused',  dotColor: 'rgb(var(--rose))'    })),
      ];
      if (combined.length === 0) {
        campaigns.innerHTML = `<li class="text-[0.72rem] py-0.5" style="color:rgb(var(--ink-faint));">Nothing active. <a href="/companies.html" class="hover:text-[rgb(var(--coral-soft))] transition-colors">Start one →</a></li>`;
      } else {
        campaigns.innerHTML = combined.map((c, idx) => `
          <li class="flex items-center gap-2 slide-right py-0.5" style="animation-delay:${idx * 50}ms">
            <span class="live-dot flex-shrink-0" style="color:${c.dotColor};"></span>
            <a href="/sending/${encodeURIComponent(c.slug)}"
              class="text-[0.8rem] truncate flex-1 hover:text-[rgb(var(--coral-soft))] transition-colors"
              style="color:rgb(var(--ink-soft));">${escapeHtml(c.name)}</a>
            <span class="text-[0.6rem] font-semibold uppercase tracking-widest"
              style="color:${c.dotColor};">${escapeHtml(c.badge)}</span>
          </li>`).join('');
      }
    }

    // Cost breakdown
    const cost = data.cost || {};
    const costUsd    = document.querySelector(`#${p}-cost-usd`);
    const costDrafts = document.querySelector(`#${p}-cost-drafts`);
    const costInput  = document.querySelector(`#${p}-cost-input`);
    const costOutput = document.querySelector(`#${p}-cost-output`);
    const costBasis  = document.querySelector(`#${p}-cost-basis`);
    const newUsd = cost.local ? '$0.00' : `$${(cost.estimated_usd ?? 0).toFixed(4)}`;
    if (costUsd) {
      if (costUsd.textContent !== newUsd) {
        costUsd.textContent = newUsd;
        costUsd.classList.remove('num-reveal');
        void costUsd.offsetWidth;
        costUsd.classList.add('num-reveal');
      }
    }
    if (costDrafts) costDrafts.textContent = cost.draft_count ?? 0;
    if (costInput)  costInput.textContent  = (cost.input_tokens  ?? 0).toLocaleString();
    if (costOutput) costOutput.textContent = (cost.output_tokens ?? 0).toLocaleString();
    if (costBasis && cost.pricing_basis) {
      costBasis.textContent = cost.pricing_basis.label
        || `${cost.pricing_basis.model}: $${cost.pricing_basis.inputPerMTok}/M in, $${cost.pricing_basis.outputPerMTok}/M out`;
    }
  }

  async function loadLogStatus() {
    const campaigns = document.querySelector('#log-campaigns');
    if (!campaigns) return;
    let data;
    try {
      data = await api('/api/dashboard');
    } catch (err) {
      campaigns.innerHTML = `<li class="text-xs py-1" style="color:rgb(var(--rose));">Failed: ${escapeHtml(err.message)}</li>`;
      return;
    }
    applyStatusData(data, 'log');
  }

  function bindHome() {
    if (!document.querySelector('#home-kpis')) return;
    loadHome();

    document.querySelector('#home-stop-all')?.addEventListener('click', async () => {
      if (!confirm('STOP ALL sends across the whole tool? This reverts queued drafts back to approved.')) return;
      try {
        await api('/api/send/stop-all', { method: 'POST' });
        await loadHome();
      } catch (err) { alert(err.message); }
    });

    // Home "New Campaign" → inline searchable panel (no popup).
    // Typing searches existing campaigns; click a match to open the existing one
    // (the campaign lives inside that company). A name with no match reveals the
    // create form, so you never make a duplicate company.
    const homeNewBtn = document.querySelector('#home-new-campaign-btn');
    const ncPanel = document.querySelector('#new-campaign-panel');
    const ncSearch = document.querySelector('#company-search');
    const ncResults = document.querySelector('#company-search-results');
    const ncForm = document.querySelector('#new-campaign-form');
    const ncNameInput = ncForm?.querySelector('input[name="name"]');
    const ncNameEcho = document.querySelector('#nc-name-echo');
    let ncCompanies = [];

    function ncRender() {
      if (!ncResults) return;
      const q = (ncSearch.value || '').trim();
      const ql = q.toLowerCase();
      const matches = ql
        ? ncCompanies.filter((c) => (c.name || '').toLowerCase().includes(ql))
        : ncCompanies.slice(0, 6);
      ncResults.innerHTML = matches
        .map(
          (c) => `
        <li>
          <a href="/companies/${encodeURIComponent(c.slug)}"
             class="flex items-center justify-between rounded-lg px-3 py-2 text-sm transition-colors hover:bg-white/[0.04]">
            <span class="truncate"><span style="color:rgb(var(--ink));">${escapeHtml(c.name)}</span>
              <span class="ml-2 text-xs" style="color:rgb(var(--ink-faint));">${escapeHtml(c.industry || c.slug)}</span></span>
            <span class="ml-3 shrink-0 text-xs" style="color:rgb(var(--coral-soft));">open →</span>
          </a>
        </li>`
        )
        .join('');
      const exact = ncCompanies.find((c) => (c.name || '').trim().toLowerCase() === ql);
      if (q && !exact) {
        if (ncNameInput) ncNameInput.value = q;
        if (ncNameEcho) ncNameEcho.textContent = q;
        ncForm?.classList.remove('hidden');
      } else {
        ncForm?.classList.add('hidden');
      }
    }

    async function ncOpen() {
      ncPanel.classList.remove('hidden');
      try {
        ncCompanies = await api('/api/companies');
      } catch {
        ncCompanies = [];
      }
      ncRender();
      ncSearch?.focus();
    }

    if (homeNewBtn && ncPanel) {
      homeNewBtn.addEventListener('click', () => {
        if (ncPanel.classList.contains('hidden')) ncOpen();
        else ncPanel.classList.add('hidden');
      });
      ncSearch?.addEventListener('input', ncRender);
      ncSearch?.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          ncPanel.classList.add('hidden');
          return;
        }
        if (event.key !== 'Enter') return;
        event.preventDefault();
        const ql = (ncSearch.value || '').trim().toLowerCase();
        const exact = ncCompanies.find((c) => (c.name || '').trim().toLowerCase() === ql);
        if (exact) {
          window.location.href = `/companies/${encodeURIComponent(exact.slug)}`;
        } else if (ql && ncForm) {
          if (ncNameInput) ncNameInput.value = ncSearch.value.trim();
          if (ncForm.requestSubmit) ncForm.requestSubmit();
          else ncForm.dispatchEvent(new Event('submit', { cancelable: true }));
        }
      });
      document
        .querySelector('#close-new-campaign-panel')
        ?.addEventListener('click', () => ncPanel.classList.add('hidden'));
    }
    document.querySelector('#new-campaign-form')?.addEventListener('submit', handleCreateCompany);

    // Refresh every 10s while home is open
    setInterval(loadHome, 10_000);
  }

  // -------------------------------------------------------------------------
  // Companies list page
  // -------------------------------------------------------------------------
  async function loadCompanies() {
    const tbody = document.querySelector('#companies-tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="8" class="px-4 py-10 text-center text-sm text-slate-500">Pulling your campaigns…</td></tr>';
    try {
      const rows = await api('/api/companies');
      if (rows.length === 0) {
        tbody.innerHTML =
          '<tr><td colspan="8" class="px-4 py-14 text-center text-sm text-slate-500">No campaigns yet. <span class="text-slate-300">Start a new one</span> and we\'ll do the heavy lifting.</td></tr>';
        return;
      }
      tbody.innerHTML = rows.map(renderCompanyRow).join('');
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="8" class="px-4 py-10 text-center text-sm text-rose-400">Failed to load: ${escapeHtml(err.message)}</td></tr>`;
    }
  }

  function renderCompanyRow(c) {
    return `
      <tr data-id="${c.id}" class="border-t border-white/5 transition-colors hover:bg-white/[0.025]">
        <td class="px-4 py-3.5">
          <a href="/companies/${encodeURIComponent(c.slug)}" class="font-medium text-[rgb(var(--ink))] hover:text-[rgb(var(--coral-soft))]">${escapeHtml(c.name)}</a>
          <div class="text-xs text-[rgb(var(--ink-faint))]">${escapeHtml(c.industry || c.slug)}</div>
        </td>
        <td class="px-4 py-3.5">${statusBadge(c.status)}</td>
        <td class="px-4 py-3.5 text-right tabular-nums text-[rgb(var(--ink-soft))]">${c.contact_count}</td>
        <td class="px-4 py-3.5 text-right tabular-nums text-[rgb(var(--ink-soft))]">${c.draft_count}</td>
        <td class="px-4 py-3.5 text-right tabular-nums text-[rgb(var(--ink-soft))]">${c.send_count}</td>
        <td class="px-4 py-3.5 text-right tabular-nums ${c.replied_count > 0 ? 'text-[rgb(var(--coral))] font-semibold' : 'text-[rgb(var(--ink-soft))]'}">${c.replied_count}</td>
        <td class="px-4 py-3.5 text-sm text-[rgb(var(--ink-faint))]">${escapeHtml(formatRelative(c.updated_at))}</td>
        <td class="px-4 py-3.5 text-right">
          <button type="button" data-action="delete-company" data-id="${c.id}" data-name="${escapeHtml(c.name)}"
            title="Delete ${escapeHtml(c.name)}"
            class="rounded-md p-1.5 text-[rgb(var(--ink-faint))] hover:bg-rose-500/10 hover:text-[rgb(var(--rose))] transition-colors"
          ><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="h-4 w-4 pointer-events-none"><path fill-rule="evenodd" d="M8.75 1A2.75 2.75 0 0 0 6 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 1 0 .23 1.482l.149-.022.841 10.518A2.75 2.75 0 0 0 7.596 19h4.807a2.75 2.75 0 0 0 2.742-2.53l.841-10.52.149.023a.75.75 0 0 0 .23-1.482A41.03 41.03 0 0 0 14 4.193V3.75A2.75 2.75 0 0 0 11.25 1h-2.5ZM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4ZM8.58 7.72a.75.75 0 0 0-1.5.06l.3 7.5a.75.75 0 1 0 1.5-.06l-.3-7.5Zm4.34.06a.75.75 0 1 0-1.5-.06l-.3 7.5a.75.75 0 1 0 1.5.06l.3-7.5Z" clip-rule="evenodd"/></svg></button>
        </td>
      </tr>`;
  }

  async function handleCreateCompany(event) {
    event.preventDefault();
    const form = event.target;
    const fd = new FormData(form);
    const payload = {
      name: (fd.get('name') || '').toString().trim(),
      company_link: ((fd.get('company_link') || '').toString().trim()) || null,
      industry: ((fd.get('industry') || '').toString().trim()) || null,
      key_products: ((fd.get('key_products') || '').toString().trim()) || null,
      custom_context: ((fd.get('custom_context') || '').toString().trim()) || null,
    };
    const errBox = form.querySelector('[data-role="error"]');
    if (errBox) errBox.textContent = '';
    try {
      const company = await api('/api/companies', { method: 'POST', body: payload });
      form.reset();
      document.querySelector('#new-campaign-modal')?.close();
      // Go straight to the new company page — no extra click needed
      window.location.href = `/companies/${encodeURIComponent(company.slug)}`;
    } catch (err) {
      if (errBox) errBox.textContent = err.message;
    }
  }

  async function handleDeleteCompany(button) {
    const id = button.dataset.id;
    const name = button.dataset.name;
    if (!confirm(`Delete "${name}"? This removes its contacts, drafts, and uploads from the database.`)) {
      return;
    }
    try {
      await api(`/api/companies/${id}`, { method: 'DELETE' });
      await loadCompanies();
    } catch (err) {
      alert(`Delete failed: ${err.message}`);
    }
  }

  function bindCompaniesPage() {
    if (!document.querySelector('#companies-tbody')) return;
    document.querySelector('#new-campaign-btn')?.addEventListener('click', () => {
      document.querySelector('#new-campaign-modal').showModal();
      document.querySelector('#new-campaign-modal input[name="name"]')?.focus();
    });
    document.querySelector('#new-campaign-form')?.addEventListener('submit', handleCreateCompany);
    document.querySelector('#companies-tbody')?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-action="delete-company"]');
      if (button) handleDeleteCompany(button);
    });
    document.querySelector('#cancel-new-campaign')?.addEventListener('click', () => {
      document.querySelector('#new-campaign-modal').close();
    });
    loadCompanies();
  }

  // -------------------------------------------------------------------------
  // Company detail page
  // -------------------------------------------------------------------------
  let currentCompany = null;
  let currentPreview = null;
  // Global default CV status (from /api/settings). Lets us tell the user when a
  // campaign with no per-campaign CV will still attach their setup-once default.
  let defaultCvStatus = null;

  function setActiveTab(name) {
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      const active = btn.dataset.tab === name;
      btn.classList.toggle('tab-btn--active', active);
      btn.classList.toggle('tab-btn--inactive', !active);
      btn.classList.toggle('border-transparent', !active);
    });
    document.querySelectorAll('.tab-panel').forEach((panel) => {
      const show = panel.dataset.panel === name;
      panel.classList.toggle('hidden', !show);
      if (show) {
        // Re-trigger slide-in animation on each tab reveal
        panel.classList.remove('tab-panel-in');
        void panel.offsetWidth;
        panel.classList.add('tab-panel-in');
      }
    });
  }

  function fileLine(label, pathValue) {
    if (!pathValue) return 'Not uploaded yet.';
    const parts = pathValue.split('/');
    const name = parts[parts.length - 1];
    return `<span class="rounded-md bg-slate-800 px-2 py-0.5 font-mono text-xs">${escapeHtml(name)}</span> <span class="ml-2 text-xs text-slate-500">${escapeHtml(pathValue)}</span>`;
  }

  // Render the "CV / Resume" current-state line(s). Three cases:
  //  - per-campaign CV uploaded → show that file (overrides the default)
  //  - no per-campaign CV but a global default is set → tell them the default attaches
  //  - neither → warn that no CV will be attached, point to Settings
  function renderCvCurrent() {
    if (!currentCompany) return;
    let html;
    if (currentCompany.cv_path) {
      html = fileLine('CV', currentCompany.cv_path) + ' <span class="text-xs text-slate-500">· this campaign</span>';
    } else if (defaultCvStatus && defaultCvStatus.configured) {
      html =
        '<span style="color:rgb(var(--emerald));">Using your default CV</span> ' +
        '<span class="rounded-md bg-slate-800 px-2 py-0.5 font-mono text-xs">' +
        escapeHtml(defaultCvStatus.filename || 'default.pdf') +
        '</span> <span class="text-xs text-slate-500">· from Settings · upload to override for this campaign</span>';
    } else {
      html =
        '<span style="color:rgb(var(--amber));">No CV will be attached.</span> ' +
        '<span class="text-xs text-slate-500">Set a <a href="/settings.html" class="underline hover:text-[rgb(var(--coral-soft))]">default CV</a> once, or upload one here.</span>';
    }
    document.querySelectorAll('[data-cv-current]').forEach((el) => { el.innerHTML = html; });
  }

  // Upload-flow helpers at module scope so loadSavedContacts can also call them

  /** Switch between "Upload file" and "Paste data" modes inside the upload card */
  function setUploadMode(mode) {
    const filePane  = document.querySelector('#upload-file-pane');
    const pastePane = document.querySelector('#upload-paste-pane');
    document.querySelectorAll('.upload-pill').forEach((btn) => {
      const active = btn.dataset.mode === mode;
      btn.classList.toggle('active', active);
    });
    if (filePane)  filePane.classList.toggle('hidden', mode !== 'file');
    if (pastePane) pastePane.classList.toggle('hidden', mode !== 'paste');
    // Clear both inputs when switching so validation is clean
    const errEl = document.querySelector('#upload-master-error');
    if (errEl) errEl.textContent = '';
  }

  function openUploadFlow() {
    const flow = document.querySelector('#upload-flow');
    flow?.classList.remove('hidden');
    // Re-trigger entrance animation
    if (flow) {
      flow.classList.remove('upload-flow-in');
      void flow.offsetWidth;
      flow.classList.add('upload-flow-in');
    }
    document.querySelector('#upload-step-1')?.classList.remove('hidden');
    document.querySelector('#contacts-preview')?.classList.add('hidden');
    setUploadMode('file'); // always start in file mode
    // Refresh the current-attachment lines for this campaign
    renderCvCurrent();
  }

  function closeUploadFlow() {
    document.querySelector('#upload-flow')?.classList.add('hidden');
    // Reset file input label so a re-open looks fresh
    const label = document.querySelector('#drop-zone-label');
    if (label) label.textContent = 'or click to browse · CSV, XLSX, XLS';
    const errEl = document.querySelector('#upload-master-error');
    if (errEl) errEl.textContent = '';
  }

  async function loadCompanyDetail() {
    // Only run on the company-detail page (companies/:slug or company.html).
    const loading = document.querySelector('#company-loading');
    if (!loading) return;

    const errorBox = document.querySelector('#company-error');
    const detail = document.querySelector('#company-detail');

    const pageMatch = window.location.pathname.match(/^\/companies\/([^/?#]+)/);
    if (!pageMatch) {
      // Landed on /company.html directly (no slug in URL). Show a useful pointer
      // instead of an indefinite "Loading…".
      loading.classList.add('hidden');
      errorBox.innerHTML =
        'Open a company from the <a href="/companies.html" class="text-[rgb(var(--coral-soft))] underline">Companies list</a>.';
      errorBox.classList.remove('hidden');
      return;
    }

    const slug = decodeURIComponent(pageMatch[1]);

    try {
      currentCompany = await api(`/api/companies/by-slug/${encodeURIComponent(slug)}`);
    } catch (err) {
      loading.classList.add('hidden');
      errorBox.textContent = `Failed to load company "${slug}": ${err.message}`;
      errorBox.classList.remove('hidden');
      return;
    }

    document.title = `${currentCompany.name} · Outreach Studio`;
    const crumb = document.querySelector('#crumb-company-name');
    if (crumb) crumb.textContent = currentCompany.name;
    document.querySelector('#company-name').textContent = currentCompany.name;
    document.querySelector('#company-slug').textContent = currentCompany.slug;
    document.querySelector('#company-status').innerHTML = statusBadge(currentCompany.status);
    // Populate new unified-page elements
    const statusPillSlot = document.querySelector('#company-status-pill');
    if (statusPillSlot) statusPillSlot.innerHTML = statusBadge(currentCompany.status);
    const meta = document.querySelector('#company-meta');
    if (meta) {
      const bits = [];
      if (currentCompany.industry) bits.push(currentCompany.industry);
      if (currentCompany.slug)     bits.push(currentCompany.slug);
      meta.textContent = bits.join(' · ');
    }
    const angle = document.querySelector('#company-angle');
    if (angle) angle.textContent = currentCompany.custom_context || '';
    if (currentCompany.company_link) {
      const row = document.querySelector('#company-link-row');
      const a = document.querySelector('#company-link');
      if (row && a) { row.classList.remove('hidden'); a.href = currentCompany.company_link; a.textContent = currentCompany.company_link; }
    }
    if (currentCompany.key_products) {
      const row = document.querySelector('#company-products-row');
      const p = document.querySelector('#company-products');
      if (row && p) { row.classList.remove('hidden'); p.textContent = currentCompany.key_products; }
    }
    if (currentCompany.fetched_text) {
      const block = document.querySelector('#fetched-block');
      const txt   = document.querySelector('#fetched-text');
      const ch    = document.querySelector('#fetched-chars');
      if (block && txt) {
        block.classList.remove('hidden');
        txt.textContent = currentCompany.fetched_text;
        if (ch) ch.textContent = `(${currentCompany.fetched_text.length} chars)`;
      }
    }
    // Wire the unified-page action buttons that exist outside the legacy hidden block
    const reviewBtn = document.querySelector('#review-btn');
    if (reviewBtn) reviewBtn.href = `/companies/${encodeURIComponent(currentCompany.slug)}/review`;

    // Build the context block with all the new fields
    const ctxParts = [];
    if (currentCompany.company_link) ctxParts.push(`<div><span class="text-slate-500">Link:</span> <a href="${escapeHtml(currentCompany.company_link)}" target="_blank" rel="noreferrer" class="text-[rgb(var(--coral-soft))] underline">${escapeHtml(currentCompany.company_link)}</a></div>`);
    if (currentCompany.industry) ctxParts.push(`<div><span class="text-slate-500">Industry:</span> ${escapeHtml(currentCompany.industry)}</div>`);
    if (currentCompany.key_products) ctxParts.push(`<div><span class="text-slate-500">Products:</span> ${escapeHtml(currentCompany.key_products)}</div>`);
    if (currentCompany.custom_context) ctxParts.push(`<div class="mt-2 whitespace-pre-line"><span class="text-slate-500">Angle:</span> ${escapeHtml(currentCompany.custom_context)}</div>`);
    if (currentCompany.fetched_text) {
      ctxParts.push(`<details class="mt-2 rounded-md border border-slate-800 bg-slate-950/40 p-2"><summary class="cursor-pointer text-xs text-slate-400">Fetched page text (${currentCompany.fetched_text.length} chars, ${escapeHtml(formatRelative(currentCompany.fetched_at))})</summary><div class="mt-2 max-h-64 overflow-y-auto text-xs text-slate-400 whitespace-pre-wrap">${escapeHtml(currentCompany.fetched_text)}</div></details>`);
    } else if (currentCompany.company_link && currentCompany.fetch_error) {
      ctxParts.push(`<div class="text-xs text-amber-300">Page fetch: ${escapeHtml(currentCompany.fetch_error)}</div>`);
    } else if (currentCompany.company_link && !currentCompany.fetched_at) {
      ctxParts.push(`<div class="text-xs text-slate-500 italic">Fetching page text…</div>`);
    }
    document.querySelector('#company-context').innerHTML = ctxParts.join('') || '<span class="text-[rgb(var(--ink-faint))]">No angle added yet. Edit the campaign to add your hook.</span>';

    try {
      const s = await api('/api/settings');
      defaultCvStatus = s.default_cv || null;
    } catch (e) {
      defaultCvStatus = null;
    }
    renderCvCurrent();
    const artCurrentEl = document.querySelector('#artifact-current');
    if (artCurrentEl) artCurrentEl.innerHTML = fileLine('Artifact', currentCompany.artifact_path);
    const coverLabel = currentCompany.cover_letter_path
      ? `PDF: ${currentCompany.cover_letter_path.split('/').pop()}`
      : (currentCompany.cover_letter_text ? `${currentCompany.cover_letter_text.length} chars of text` : 'Not set yet.');
    document.querySelectorAll('[data-cover-current]').forEach((el) => { el.textContent = coverLabel; });

    loading.classList.add('hidden');
    detail.classList.remove('hidden');

    setActiveTab('people');
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => setActiveTab(btn.dataset.tab));
    });

    document.querySelector('#upload-flow-close')?.addEventListener('click', closeUploadFlow);
    document.querySelector('#people-upload-toggle')?.addEventListener('click', () => {
      const flow = document.querySelector('#upload-flow');
      if (flow?.classList.contains('hidden')) { openUploadFlow(); } else { closeUploadFlow(); }
    });

    bindAssetUpload('cv');
    bindAssetUpload('artifact');
    bindCoverLetter();
    bindArtifactsList();
    loadArtifacts();
    bindContactsUpload();
    bindPreviewActions();
    bindDraftActions();
    await loadSavedContacts();
    await loadDrafts();
  }

  function bindCoverLetter() {
    document.querySelectorAll('[data-cover-form]').forEach((form) => {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const msg = form.querySelector('[data-role="cover-msg"]');
        if (msg) msg.textContent = '';
        const fd = new FormData(form);
        fd.append('company_id', currentCompany.id);
        try {
          const r = await api('/api/artifacts/cover-letter', { method: 'POST', body: fd });
          if (msg) { msg.textContent = `saved · ${r.chars || 0} chars of text`; msg.className = 'text-xs text-emerald-300'; }
          const label = r.path ? `PDF: ${r.path.split('/').pop()}` : `${r.chars} chars of text`;
          document.querySelectorAll('[data-cover-current]').forEach((el) => { el.textContent = label; });
          form.reset();
        } catch (err) { if (msg) { msg.textContent = err.message; msg.className = 'text-xs text-rose-300'; } }
      });
    });
  }

  async function loadArtifacts() {
    const lists = document.querySelectorAll('[data-artifacts-list]');
    if (!lists.length || !currentCompany) return;
    let html;
    try {
      const rows = await api(`/api/artifacts?company_id=${currentCompany.id}`);
      html = !rows.length
        ? '<li class="py-2 text-slate-500">No named artifacts yet.</li>'
        : rows.map(r => `
        <li class="flex items-center justify-between py-2">
          <div>
            <div class="text-slate-200">${escapeHtml(r.name)}</div>
            <div class="text-xs text-slate-500">${escapeHtml(r.path.split('/').pop())} · ${Math.round((r.size_bytes||0)/1024)} KB</div>
          </div>
          <button data-artifact-del="${r.id}" class="rounded-md px-2 py-1 text-xs text-rose-300 hover:bg-rose-900/40">Remove</button>
        </li>`).join('');
    } catch (err) {
      html = `<li class="py-2 text-rose-400">${escapeHtml(err.message)}</li>`;
    }
    lists.forEach((list) => { list.innerHTML = html; });
  }

  function bindArtifactsList() {
    document.querySelectorAll('[data-artifact-form]').forEach((form) => {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const msg = form.querySelector('[data-role="artifact-msg"]');
        if (msg) msg.textContent = '';
        const fd = new FormData(form);
        fd.append('company_id', currentCompany.id);
        try {
          await api('/api/artifacts', { method: 'POST', body: fd });
          form.reset();
          if (msg) { msg.textContent = 'added'; msg.className = 'col-span-3 mt-1 text-xs text-emerald-300'; }
          loadArtifacts();
        } catch (err) { if (msg) { msg.textContent = err.message; msg.className = 'col-span-3 mt-1 text-xs text-rose-300'; } }
      });
    });
    document.querySelectorAll('[data-artifacts-list]').forEach((list) => {
      list.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-artifact-del]');
        if (!btn) return;
        if (!confirm('Remove this artifact?')) return;
        try {
          await api(`/api/artifacts/${btn.dataset.artifactDel}`, { method: 'DELETE' });
          loadArtifacts();
        } catch (err) { alert(err.message); }
      });
    });
  }

  function bindAssetUpload(kind) {
    document.querySelectorAll(`form[data-upload="${kind}"]`).forEach((form) => {
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const errBox = form.querySelector('[data-role="error"]');
        if (errBox) errBox.textContent = '';
        const fd = new FormData(form);
        fd.append('company_id', currentCompany.id);
        try {
          const result = await api(`/api/uploads/${kind}`, { method: 'POST', body: fd });
          if (kind === 'cv') {
            currentCompany.cv_path = result.path;
            renderCvCurrent();
          } else {
            currentCompany.artifact_path = result.path;
            const artEl = document.querySelector('#artifact-current');
            if (artEl) artEl.innerHTML = fileLine('Artifact', result.path);
          }
          form.reset();
        } catch (err) {
          if (errBox) errBox.textContent = err.message;
        }
      });
    });
  }

  function bindContactsUpload() {
    const form = document.querySelector('#upload-master-form');
    if (!form) return;

    // Mode switching
    document.querySelector('#mode-file')?.addEventListener('click', () => setUploadMode('file'));
    document.querySelector('#mode-paste')?.addEventListener('click', () => setUploadMode('paste'));

    // Drag-and-drop on the drop zone label
    const dropZone = document.querySelector('#drop-zone');
    if (dropZone) {
      ['dragenter', 'dragover'].forEach((ev) => {
        dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.add('drop-zone--over'); });
      });
      ['dragleave', 'drop'].forEach((ev) => {
        dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.remove('drop-zone--over'); });
      });
      dropZone.addEventListener('drop', (e) => {
        const file = e.dataTransfer?.files?.[0];
        if (file) {
          const fi = document.querySelector('#upload-file-input');
          if (fi) {
            try { const dt = new DataTransfer(); dt.items.add(file); fi.files = dt.files; } catch { /* Safari */ }
          }
          const lbl = document.querySelector('#drop-zone-label');
          if (lbl) lbl.textContent = file.name;
        }
      });
    }

    // File input change — update label
    document.querySelector('#upload-file-input')?.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      const lbl = document.querySelector('#drop-zone-label');
      if (lbl) lbl.textContent = file ? file.name : 'or click to browse · CSV, XLSX, XLS';
    });

    form.addEventListener('submit', handleMasterFormSubmit);
  }

  async function handleMasterFormSubmit(event) {
    event.preventDefault();
    const errEl = document.querySelector('#upload-master-error');
    if (errEl) errEl.textContent = '';
    const submitBtn = document.querySelector('#upload-parse-btn');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<svg viewBox="0 0 16 16" fill="none" class="h-3.5 w-3.5 spin" aria-hidden="true"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="2" opacity=".25"/><path d="M14 8a6 6 0 0 1-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg> Parsing…';
    }

    const isPasteMode = !document.querySelector('#upload-paste-pane')?.classList.contains('hidden');

    try {
      if (isPasteMode) {
        // Paste mode: send raw CSV/TSV text as JSON
        const csvText = (document.querySelector('#upload-paste-textarea')?.value || '').trim();
        if (!csvText) {
          if (errEl) errEl.textContent = 'Paste some contact data first (CSV or spreadsheet rows).';
          return;
        }
        currentPreview = await api('/api/uploads/contacts-text', {
          method: 'POST',
          body: { company_id: currentCompany.id, csv_text: csvText },
        });
      } else {
        // File mode: multipart upload
        const fileInput = document.querySelector('#upload-file-input');
        if (!fileInput?.files?.length) {
          if (errEl) errEl.textContent = 'Select a CSV or Excel file first.';
          return;
        }
        const fd = new FormData();
        fd.append('file', fileInput.files[0]);
        fd.append('company_id', currentCompany.id);
        currentPreview = await api('/api/uploads/contacts', { method: 'POST', body: fd });
      }
      renderContactsPreview(); // advance to preview step
    } catch (err) {
      if (errEl) errEl.textContent = err.message;
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = 'Parse <svg viewBox="0 0 16 16" fill="currentColor" class="h-3.5 w-3.5" aria-hidden="true"><path fill-rule="evenodd" d="M6.22 4.22a.75.75 0 011.06 0l3.25 3.25a.75.75 0 010 1.06l-3.25 3.25a.75.75 0 01-1.06-1.06L8.94 8 6.22 5.28a.75.75 0 010-1.06z" clip-rule="evenodd"/></svg>';
      }
    }
  }

  function renderContactsPreview() {
    const step1 = document.querySelector('#upload-step-1');
    const wrap = document.querySelector('#contacts-preview');
    const summary = document.querySelector('#contacts-summary');
    const tbody = document.querySelector('#contacts-preview-tbody');
    if (!currentPreview) {
      // Go back to step 1
      wrap?.classList.add('hidden');
      step1?.classList.remove('hidden');
      return;
    }
    // Advance: hide step 1, show step 2
    step1?.classList.add('hidden');
    const { stats, rows, source_file, columnMap } = currentPreview;
    const detectedCols = Object.keys(columnMap).join(', ');
    if (summary) {
      summary.innerHTML =
        `<span class="font-semibold text-[rgb(var(--ink))]">${stats.total}</span> rows detected · ` +
        `<span class="text-[rgb(var(--emerald))]">${stats.valid} valid</span>` +
        (stats.invalid ? ` · <span class="text-[rgb(var(--rose))]">${stats.invalid} issues</span>` : '') +
        `<span class="ml-2 text-[rgb(var(--ink-faint))] text-xs">cols: ${escapeHtml(detectedCols)}</span>`;
    }
    if (tbody) {
      tbody.innerHTML = rows.map((row, idx) => `
        <tr class="border-t border-white/5 ${row.valid ? 'hover:bg-white/[0.02]' : 'bg-rose-950/20'}">
          <td class="px-3 py-2"><input type="checkbox" data-preview-row="${idx}" ${row.valid ? 'checked' : ''} /></td>
          <td class="px-3 py-2 text-[rgb(var(--ink-faint))]">${row.source_row}</td>
          <td class="px-3 py-2 text-[rgb(var(--ink))]">${escapeHtml(row.full_name || '')}</td>
          <td class="px-3 py-2 text-[rgb(var(--ink-soft))]">${escapeHtml(row.title || '')}</td>
          <td class="px-3 py-2 text-xs text-[rgb(var(--ink-muted))]">${escapeHtml(row.seniority || '')}</td>
          <td class="px-3 py-2 text-[rgb(var(--ink))]">${escapeHtml(row.email || '')}</td>
          <td class="px-3 py-2 text-xs ${row.warnings.length ? 'text-[rgb(var(--amber))]' : 'text-[rgb(var(--ink-faint))]'}">${escapeHtml((row.warnings || []).join(', ') || '')}</td>
        </tr>`).join('');
    }
    wrap?.classList.remove('hidden');
    // Re-trigger the slide-in animation each time the preview appears
    if (wrap) {
      wrap.classList.remove('slide-in');
      void wrap.offsetWidth; // force reflow
      wrap.classList.add('slide-in');
    }
  }

  function bindPreviewActions() {
    document.querySelector('#contacts-select-all')?.addEventListener('change', (event) => {
      const checked = event.target.checked;
      document.querySelectorAll('[data-preview-row]').forEach((cb) => { cb.checked = checked; });
    });

    // "← Re-upload" — go back to step 1
    document.querySelector('#contacts-discard')?.addEventListener('click', () => {
      currentPreview = null;
      renderContactsPreview(); // null preview → reverts to step 1
    });

    // "Initiate outreach →" — optionally upload CV, commit contacts, generate personalized drafts, open wizard
    document.querySelector('#contacts-commit')?.addEventListener('click', async () => {
      if (!currentPreview) return;
      const btn = document.querySelector('#contacts-commit');
      const errEl = document.querySelector('#contacts-preview-error');

      const selectedIndices = Array.from(document.querySelectorAll('[data-preview-row]'))
        .filter((cb) => cb.checked)
        .map((cb) => Number(cb.dataset.previewRow));
      const selectedRows = selectedIndices
        .map((i) => currentPreview.rows[i])
        .filter((r) => r && r.email && !r.warnings.includes('invalid_email'));

      if (selectedRows.length === 0) {
        if (errEl) errEl.textContent = 'Select at least one row with a valid email address.';
        return;
      }
      if (errEl) errEl.textContent = '';

      function setStatus(msg) {
        if (btn) {
          btn.disabled = true;
          btn.innerHTML = `<svg viewBox="0 0 16 16" fill="none" class="h-3.5 w-3.5 spin" aria-hidden="true"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="2" opacity=".25"/><path d="M14 8a6 6 0 0 1-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><span class="opacity-80">${escapeHtml(msg)}</span>`;
        }
      }

      const resetBtn = () => {
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = 'Initiate outreach <svg viewBox="0 0 16 16" fill="currentColor" class="h-3.5 w-3.5 inline-block"><path fill-rule="evenodd" d="M6.22 4.22a.75.75 0 011.06 0l3.25 3.25a.75.75 0 010 1.06l-3.25 3.25a.75.75 0 01-1.06-1.06L8.94 8 6.22 5.28a.75.75 0 010-1.06z" clip-rule="evenodd"/></svg>';
        }
      };

      setStatus('Saving…');

      try {
        // CV / cover letter / artifacts are uploaded from the Attachments card.
        // 1. Save contacts to DB
        setStatus('Saving contacts…');
        await api('/api/contacts/commit', {
          method: 'POST',
          body: {
            company_id: currentCompany.id,
            source_file: currentPreview.source_file,
            rows: selectedRows.map((r) => ({
              full_name: r.full_name,
              first_name: r.first_name,
              last_name: r.last_name,
              title: r.title,
              email: r.email,
              linkedin_url: r.linkedin_url,
              seniority: r.seniority,
            })),
          },
        });

        // 2. Generate personalized drafts via LLM (one per contact)
        const n = selectedRows.length;
        setStatus(`Writing ${n} personalised email${n !== 1 ? 's' : ''}… (${Math.max(15, n * 3)}s)`);
        await api('/api/drafts/generate-batch', {
          method: 'POST',
          body: { company_id: currentCompany.id, only_missing: true },
        });

        // 3. Open the review wizard. It handles the no-draft / partial-draft case on
        //    its own (shows a notice + per-draft Regenerate), so we always land there.
        window.location.href = `/companies/${encodeURIComponent(currentCompany.slug)}/review`;
      } catch (err) {
        if (errEl) errEl.textContent = err.message;
        resetBtn();
      }
    });
  }

  function peoplePill(p) {
    if (p.sent_at) {
      return p.replied
        ? '<span class="pill text-[rgb(var(--sky))]">replied</span>'
        : '<span class="pill text-[rgb(var(--emerald))]">sent</span>';
    }
    if (!p.draft_id) return '<span class="pill text-[rgb(var(--ink-muted))]">no draft</span>';
    const s = p.draft_status || 'draft';
    const colors = {
      draft: 'text-[rgb(var(--ink-soft))]',
      approved: 'text-[rgb(var(--emerald))]',
      queued: 'text-[rgb(var(--coral-soft))]',
      skipped: 'text-[rgb(var(--ink-faint))]',
      failed: 'text-[rgb(var(--rose))]',
    };
    return `<span class="pill ${colors[s] || 'text-[rgb(var(--ink-soft))]'}">${escapeHtml(s)}</span>`;
  }

  async function loadSavedContacts() {
    const listWrap = document.querySelector('#people-list-wrap');
    if (!listWrap) return;
    try {
      const data = await api(`/api/companies/${currentCompany.id}/people-with-drafts`);
      const people = data.people || [];
      if (people.length === 0) {
        // No contacts yet — auto-open the upload flow
        listWrap.classList.add('hidden');
        openUploadFlow();
        return;
      }
      // Contacts exist — close any open upload flow, show people table
      document.querySelector('#upload-flow')?.classList.add('hidden');
      listWrap.classList.remove('hidden');
      const tbody = document.querySelector('#people-tbody');
      if (tbody) {
        const slug = currentCompany.slug;
        tbody.innerHTML = people.map((p) => `
          <tr class="border-t border-white/5 hover:bg-white/[0.025] cursor-pointer" onclick="location.href='/companies/${escapeHtml(slug)}/people/${p.contact_id}'">
            <td class="px-4 py-3 text-[rgb(var(--ink))]">${escapeHtml(p.full_name || '(unnamed)')}</td>
            <td class="px-4 py-3 text-[rgb(var(--ink-muted))]">${escapeHtml(p.title || '')}</td>
            <td class="px-4 py-3 text-[rgb(var(--ink-soft))]">${escapeHtml(p.email || '')}</td>
            <td class="px-4 py-3">${peoplePill(p)}</td>
            <td class="px-4 py-3 text-[rgb(var(--ink-muted))] max-w-xs truncate">${escapeHtml(p.draft_subject || '(none)')}</td>
            <td class="px-4 py-3 text-right text-xs text-[rgb(var(--coral-soft))]">open →</td>
          </tr>`).join('');
      }

      // "Initiate outreach" — shown only when contacts exist but some have no draft yet.
      // Generates the missing drafts, then lands on the review page
      // (the flow is: upload → see the list → initiate outreach → review → send).
      const initiateBtn = document.querySelector('#people-initiate-outreach');
      if (initiateBtn) {
        const missing = people.filter((p) => !p.draft_id).length;
        if (missing > 0) {
          initiateBtn.classList.remove('hidden');
          initiateBtn.classList.add('inline-flex');
        } else {
          initiateBtn.classList.add('hidden');
          initiateBtn.classList.remove('inline-flex');
        }
        if (!initiateBtn._bound) {
          initiateBtn._bound = true;
          initiateBtn.addEventListener('click', async () => {
            const original = initiateBtn.innerHTML;
            initiateBtn.disabled = true;
            initiateBtn.innerHTML = '<svg viewBox="0 0 16 16" fill="none" class="h-3.5 w-3.5 spin" aria-hidden="true"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="2" opacity=".25"/><path d="M14 8a6 6 0 0 1-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><span class="opacity-80">Initiating…</span>';
            try {
              await api('/api/drafts/generate-batch', {
                method: 'POST',
                body: { company_id: currentCompany.id, only_missing: true },
              });
              window.location.href = `/companies/${encodeURIComponent(currentCompany.slug)}/review`;
            } catch (err) {
              alert(err.message);
              initiateBtn.disabled = false;
              initiateBtn.innerHTML = original;
            }
          });
        }
      }

      // Wire up search filter
      const searchInput = document.querySelector('#people-search');
      if (searchInput && !searchInput._bound) {
        searchInput._bound = true;
        searchInput.addEventListener('input', () => {
          clearTimeout(searchInput._debounce);
          searchInput._debounce = setTimeout(() => {
            const q = searchInput.value.toLowerCase();
            document.querySelectorAll('#people-tbody tr').forEach((row) => {
              row.style.display = q === '' || row.textContent.toLowerCase().includes(q) ? '' : 'none';
            });
          }, 150);
        });
      }
    } catch (err) {
      // On API error, show the people table area with the error message
      if (listWrap) {
        listWrap.classList.remove('hidden');
        const tbody = document.querySelector('#people-tbody');
        if (tbody) tbody.innerHTML = `<tr><td colspan="6" class="px-4 py-6 text-center text-rose-400">${escapeHtml(err.message)}</td></tr>`;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Drafts tab
  // -------------------------------------------------------------------------
  let drafts = [];
  let selectedDraftId = null;

  function draftStatusBadge(status) {
    const map = {
      draft: ['chip-cold', 'draft'],
      approved: ['chip-warm', 'approved'],
      sent: ['chip-done', 'sent'],
      skipped: ['chip-skip', 'skipped'],
      queued: ['chip-live', 'queued'],
      failed: ['chip-skip', 'failed'],
    };
    const [cls, label] = map[status] || ['chip-cold', status];
    return `<span class="chip ${cls}">${escapeHtml(label)}</span>`;
  }

  // Friendly labels for the quality-check warning codes the drafting engine emits.
  const WARNING_LABELS = {
    too_short: 'Body too short (under 80 words)',
    subject_too_long: 'Subject over 60 characters',
    subject_bad_prefix: 'Subject starts with a weak phrase',
    exclamation_mark: 'Contains an exclamation mark',
    unsubstituted_variable: 'Unfilled {placeholder}',
    company_name_missing: 'No company reference',
    first_name_missing: 'Missing recipient first name',
    first_sentence_about_sender: 'Opens about the sender, not the recipient',
    opening_repeated: 'Opening reused from another draft',
    emoji_detected: 'Contains an emoji',
  };

  function warningLabel(code) {
    if (!code) return '';
    if (code.startsWith('banned_word:')) return `Banned word: ${code.slice('banned_word:'.length)}`;
    if (code.startsWith('too_long:')) return `Body too long (${code.slice('too_long:'.length)} words)`;
    if (code.startsWith('ai_overuse:')) return `"AI" used ${code.slice('ai_overuse:'.length)} times`;
    return WARNING_LABELS[code] || code;
  }

  function warningChip(code) {
    return `<span class="inline-flex rounded-full bg-amber-900/40 px-2 py-0.5 text-xs font-medium text-amber-200">${escapeHtml(warningLabel(code))}</span>`;
  }

  function needsReviewBadge() {
    return '<span class="inline-flex rounded-full bg-rose-900/50 px-2 py-0.5 text-xs font-semibold text-rose-200">Needs review</span>';
  }

  async function loadDrafts({ keepSelection = true } = {}) {
    if (!currentCompany) return;
    try {
      drafts = await api(`/api/drafts?company_id=${currentCompany.id}`);
    } catch (err) {
      showDraftsError(`Failed to load drafts: ${err.message}`);
      return;
    }
    renderDraftsList();
    if (keepSelection && selectedDraftId) {
      const stillExists = drafts.find((d) => d.id === selectedDraftId);
      if (stillExists) {
        renderDraftEditor(stillExists);
        return;
      }
    }
    if (drafts.length > 0) {
      selectedDraftId = drafts[0].id;
      renderDraftEditor(drafts[0]);
    } else {
      selectedDraftId = null;
      document.querySelector('#draft-editor').innerHTML =
        '<p class="text-sm text-slate-500">No drafts yet. Click <span class="text-slate-300">Generate all drafts</span> after uploading contacts.</p>';
    }
  }

  function renderDraftsList() {
    const list = document.querySelector('#drafts-list');
    const summary = document.querySelector('#drafts-summary');
    if (!list || !summary) return;

    const total = drafts.length;
    const approved = drafts.filter((d) => d.status === 'approved').length;
    const sent = drafts.filter((d) => d.status === 'sent').length;
    const skipped = drafts.filter((d) => d.status === 'skipped').length;
    const withWarnings = drafts.filter((d) => (d.quality_warnings || []).length > 0).length;
    const replied = drafts.filter((d) => d.replied).length;
    summary.innerHTML = `<span class="text-slate-300">${total}</span> total · <span class="text-emerald-300">${approved}</span> approved · <span class="text-emerald-300">${sent}</span> sent · <span class="text-sky-300">${replied}</span> replied · <span class="text-slate-400">${skipped}</span> skipped · <span class="text-amber-300">${withWarnings}</span> with warnings`;

    if (total === 0) {
      list.innerHTML = '<li class="px-4 py-6 text-sm text-slate-500">No drafts yet.</li>';
      return;
    }

    list.innerHTML = drafts
      .map((d) => {
        const isSelected = d.id === selectedDraftId;
        const warns = (d.quality_warnings || []).length;
        const repliedBadge = d.replied
          ? '<span class="ml-1 inline-flex rounded-full bg-sky-900/60 px-2 py-0.5 text-xs font-medium text-sky-200">REPLIED</span>'
          : '';
        return `
          <li>
            <button type="button" data-action="select-draft" data-id="${d.id}"
              class="block w-full px-4 py-3 text-left ${isSelected ? 'bg-slate-900' : 'hover:bg-slate-900/60'}">
              <div class="flex items-start justify-between gap-2">
                <div class="min-w-0">
                  <div class="truncate text-sm font-medium text-slate-100">${escapeHtml(d.contact?.full_name || '(no name)')}</div>
                  <div class="truncate text-xs text-slate-500">${escapeHtml(d.contact?.title || '')}</div>
                </div>
                <div class="flex flex-col items-end gap-1">
                  ${draftStatusBadge(d.status)}
                  ${repliedBadge}
                </div>
              </div>
              <div class="mt-1 truncate text-xs text-slate-400">${escapeHtml(d.subject || '')}</div>
              ${warns > 0 ? `<div class="mt-1 text-xs text-amber-300">${warns} warning${warns === 1 ? '' : 's'}</div>` : ''}
            </button>
          </li>`;
      })
      .join('');
  }

  function renderDraftEditor(draft) {
    const root = document.querySelector('#draft-editor');
    const tmpl = document.querySelector('#draft-editor-template');
    if (!root || !tmpl) return;

    root.innerHTML = '';
    const node = tmpl.content.firstElementChild.cloneNode(true);

    const set = (key, value) => {
      const el = node.querySelector(`[data-bind="${key}"]`);
      if (el) el.textContent = value;
    };
    const setHtml = (key, html) => {
      const el = node.querySelector(`[data-bind="${key}"]`);
      if (el) el.innerHTML = html;
    };

    set('contact_name', draft.contact?.full_name || '(no name)');
    set('contact_title', draft.contact?.title || '');
    set('contact_seniority', draft.contact?.seniority || 'other');
    set('contact_email', draft.contact?.email || '');
    const repliedBadge = draft.replied
      ? `<span class="ml-2 inline-flex rounded-full bg-sky-900/60 px-2 py-0.5 text-xs font-medium text-sky-200">REPLIED ${draft.replied_at ? formatRelative(draft.replied_at) : ''}</span>`
      : '';
    setHtml('status_badge', `${draftStatusBadge(draft.status)}${repliedBadge}`);

    const warnings = draft.quality_warnings || [];
    const hasNeedsReview = warnings.includes('needs_review');
    const checkChips = warnings.filter((w) => w !== 'needs_review');
    setHtml(
      'warnings',
      warnings.length === 0
        ? '<span class="text-xs text-emerald-400">no warnings</span>'
        : [hasNeedsReview ? needsReviewBadge() : '', ...checkChips.map(warningChip)].filter(Boolean).join(' ')
    );

    node.querySelector('[data-bind="subject_input"]').value = draft.subject || '';
    node.querySelector('[data-bind="body_input"]').value = draft.body || '';

    const attachments = draft.attachments || [];
    setHtml(
      'attachments',
      attachments.length === 0
        ? '<li class="list-none text-slate-500">none</li>'
        : attachments.map((a) => `<li><span class="font-mono">${escapeHtml(a)}</span></li>`).join('')
    );

    set(
      'tokens',
      `Tokens: in=${draft.llm_input_tokens ?? 0}, out=${draft.llm_output_tokens ?? 0} · generated ${formatRelative(draft.generated_at)}`
    );

    const isLocked = draft.status === 'sent';
    const sendBtn = node.querySelector('button[data-action="send"]');
    if (sendBtn) sendBtn.disabled = draft.status !== 'approved';

    if (isLocked) {
      node.querySelector('[data-bind="subject_input"]').disabled = true;
      node.querySelector('[data-bind="body_input"]').disabled = true;
      node.querySelectorAll('button[data-action]').forEach((b) => {
        if (b.dataset.action !== 'regenerate') b.disabled = true;
      });
    }

    root.appendChild(node);
  }

  function showDraftsProgress(text) {
    const el = document.querySelector('#drafts-progress');
    if (!el) return;
    el.textContent = text;
    el.classList.remove('hidden');
  }
  function clearDraftsProgress() {
    document.querySelector('#drafts-progress')?.classList.add('hidden');
  }
  function showDraftsError(text) {
    const el = document.querySelector('#drafts-error');
    if (!el) return;
    el.textContent = text;
    el.classList.remove('hidden');
  }
  function clearDraftsError() {
    document.querySelector('#drafts-error')?.classList.add('hidden');
  }

  async function generateBatch({ onlyMissing }) {
    clearDraftsError();
    showDraftsProgress(
      onlyMissing
        ? 'Generating drafts for contacts without one yet… (~5s per contact)'
        : 'Generating drafts for all selected contacts… (~5s per contact)'
    );
    document.querySelector('#drafts-generate-all').disabled = true;
    document.querySelector('#drafts-generate-missing').disabled = true;
    try {
      const result = await api('/api/drafts/generate-batch', {
        method: 'POST',
        body: { company_id: currentCompany.id, only_missing: !!onlyMissing },
      });
      let msg = `Generated ${result.generated} draft(s).`;
      if (result.errors && result.errors.length > 0) {
        msg += ` ${result.errors.length} failure(s) — first: ${result.errors[0].error}`;
      }
      showDraftsProgress(msg);
      setTimeout(clearDraftsProgress, 4000);
      await loadDrafts({ keepSelection: false });
    } catch (err) {
      clearDraftsProgress();
      showDraftsError(err.message);
    } finally {
      document.querySelector('#drafts-generate-all').disabled = false;
      document.querySelector('#drafts-generate-missing').disabled = false;
    }
  }

  function moveDraftSelection(delta) {
    if (drafts.length === 0) return;
    const idx = drafts.findIndex((d) => d.id === selectedDraftId);
    const nextIdx = Math.max(0, Math.min(drafts.length - 1, (idx < 0 ? 0 : idx) + delta));
    selectedDraftId = drafts[nextIdx].id;
    renderDraftsList();
    renderDraftEditor(drafts[nextIdx]);
    // Scroll the selected list row into view.
    document.querySelector(`#drafts-list [data-id="${selectedDraftId}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  function clickEditorAction(action) {
    const btn = document.querySelector(`#draft-editor button[data-action="${action}"]`);
    if (btn && !btn.disabled) btn.click();
  }

  function focusBodyEditor() {
    document.querySelector('[data-bind="body_input"]')?.focus();
  }

  function showShortcutsHelp() {
    const id = 'shortcuts-help-dialog';
    let dlg = document.getElementById(id);
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.id = id;
      dlg.className = 'mx-auto mt-32 w-full max-w-md rounded-xl border border-slate-800 bg-slate-900 p-6 text-slate-100 shadow-2xl';
      dlg.innerHTML = `
        <h3 class="text-lg font-semibold">Keyboard shortcuts</h3>
        <p class="mt-1 text-xs text-slate-500">Active on the Drafts tab (when not typing in an input).</p>
        <table class="mt-4 w-full text-sm">
          <tbody class="divide-y divide-slate-800">
            <tr><td class="py-1.5"><kbd class="rounded bg-slate-800 px-1.5 py-0.5 text-xs font-mono">j</kbd> / <kbd class="rounded bg-slate-800 px-1.5 py-0.5 text-xs font-mono">k</kbd></td><td class="text-slate-300">Next / previous draft</td></tr>
            <tr><td class="py-1.5"><kbd class="rounded bg-slate-800 px-1.5 py-0.5 text-xs font-mono">a</kbd></td><td class="text-slate-300">Approve current</td></tr>
            <tr><td class="py-1.5"><kbd class="rounded bg-slate-800 px-1.5 py-0.5 text-xs font-mono">e</kbd></td><td class="text-slate-300">Edit body (focus textarea)</td></tr>
            <tr><td class="py-1.5"><kbd class="rounded bg-slate-800 px-1.5 py-0.5 text-xs font-mono">r</kbd></td><td class="text-slate-300">Regenerate</td></tr>
            <tr><td class="py-1.5"><kbd class="rounded bg-slate-800 px-1.5 py-0.5 text-xs font-mono">s</kbd></td><td class="text-slate-300">Skip</td></tr>
            <tr><td class="py-1.5"><kbd class="rounded bg-slate-800 px-1.5 py-0.5 text-xs font-mono">⌘</kbd> / <kbd class="rounded bg-slate-800 px-1.5 py-0.5 text-xs font-mono">Ctrl</kbd>+<kbd class="rounded bg-slate-800 px-1.5 py-0.5 text-xs font-mono">Enter</kbd></td><td class="text-slate-300">Send campaign (queue all approved)</td></tr>
            <tr><td class="py-1.5"><kbd class="rounded bg-slate-800 px-1.5 py-0.5 text-xs font-mono">?</kbd></td><td class="text-slate-300">Show this help</td></tr>
          </tbody>
        </table>
        <div class="mt-5 text-right">
          <button data-action="close" class="rounded-md bg-[rgb(var(--coral))] px-3 py-1.5 text-sm font-medium text-white hover:bg-[rgb(var(--coral-deep))]">Got it</button>
        </div>`;
      document.body.appendChild(dlg);
      dlg.querySelector('[data-action="close"]').addEventListener('click', () => dlg.close());
    }
    dlg.showModal();
  }

  function bindDraftsKeyboard() {
    document.addEventListener('keydown', (event) => {
      // Only active on company detail page with the Drafts tab visible.
      const draftsPanel = document.querySelector('[data-panel="drafts"]');
      if (!draftsPanel || draftsPanel.classList.contains('hidden')) return;
      // Skip when user is typing in a field (except for ?, which is handy globally).
      const t = event.target;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (event.key === '?' && !typing) { event.preventDefault(); showShortcutsHelp(); return; }
      if (typing) return;
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        document.querySelector('#drafts-send-campaign')?.click();
        return;
      }
      switch (event.key) {
        case 'j': event.preventDefault(); moveDraftSelection(1); break;
        case 'k': event.preventDefault(); moveDraftSelection(-1); break;
        case 'a': event.preventDefault(); clickEditorAction('approve'); break;
        case 'e': event.preventDefault(); focusBodyEditor(); break;
        case 'r': event.preventDefault(); clickEditorAction('regenerate'); break;
        case 's': event.preventDefault(); clickEditorAction('skip'); break;
        default: /* ignore */
      }
    });
  }

  async function createBlankDrafts() {
    clearDraftsError();
    showDraftsProgress('Creating blank-template drafts (no LLM needed)…');
    const btn = document.querySelector('#drafts-create-blank');
    if (btn) btn.disabled = true;
    try {
      const result = await api('/api/drafts/blank-batch', {
        method: 'POST',
        body: { company_id: currentCompany.id, only_missing: true },
      });
      let msg = result.created > 0
        ? `Created ${result.created} blank draft${result.created === 1 ? '' : 's'}. Edit each — the {curly-brace bits} are placeholders for you to fill in.`
        : (result.message || 'No new drafts created — all contacts already have drafts.');
      showDraftsProgress(msg);
      setTimeout(clearDraftsProgress, 6000);
      await loadDrafts({ keepSelection: false });
    } catch (err) {
      clearDraftsProgress();
      showDraftsError(err.message);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function bindDraftActions() {
    document.querySelector('#drafts-generate-all')?.addEventListener('click', () => generateBatch({ onlyMissing: false }));
    document.querySelector('#drafts-generate-missing')?.addEventListener('click', () => generateBatch({ onlyMissing: true }));
    bindDraftsKeyboard();

    const reviewLink = document.querySelector('#drafts-review-wizard');
    if (reviewLink && currentCompany) reviewLink.href = `/companies/${encodeURIComponent(currentCompany.slug)}/review`;
    document.querySelector('#drafts-send-campaign')?.addEventListener('click', async () => {
      const approved = drafts.filter((d) => d.status === 'approved').length;
      if (approved === 0) {
        alert('No approved drafts to send. Approve at least one first.');
        return;
      }
      if (!confirm(
        `Queue ${approved} approved draft${approved === 1 ? '' : 's'} for ${currentCompany.name}?\n\nSends will happen one at a time with throttling (default: 90s between sends).`
      )) return;
      try {
        const result = await api('/api/send/start-campaign', {
          method: 'POST',
          body: { company_id: currentCompany.id },
        });
        showDraftsProgress(`Queued ${result.queued} draft(s). Watch live progress…`);
        setTimeout(() => {
          window.location.href = `/sending/${encodeURIComponent(currentCompany.slug)}`;
        }, 600);
      } catch (err) {
        showDraftsError(err.message);
      }
    });

    document.querySelector('#drafts-list')?.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-action="select-draft"]');
      if (!btn) return;
      selectedDraftId = Number(btn.dataset.id);
      const draft = drafts.find((d) => d.id === selectedDraftId);
      if (draft) {
        renderDraftsList();
        renderDraftEditor(draft);
      }
    });

    document.querySelector('#draft-editor')?.addEventListener('click', async (event) => {
      const btn = event.target.closest('button[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      const draft = drafts.find((d) => d.id === selectedDraftId);
      if (!draft) return;
      const errEl = document.querySelector('[data-bind="action_error"]');
      if (errEl) errEl.textContent = '';
      btn.disabled = true;
      try {
        if (action === 'save') {
          const subject = document.querySelector('[data-bind="subject_input"]').value.trim();
          const body = document.querySelector('[data-bind="body_input"]').value.trim();
          await api(`/api/drafts/${draft.id}`, { method: 'PUT', body: { subject, body } });
        } else if (action === 'approve') {
          const subject = document.querySelector('[data-bind="subject_input"]').value.trim();
          const body = document.querySelector('[data-bind="body_input"]').value.trim();
          if (subject !== draft.subject || body !== draft.body) {
            await api(`/api/drafts/${draft.id}`, { method: 'PUT', body: { subject, body } });
          }
          await api(`/api/drafts/${draft.id}/approve`, { method: 'POST' });
        } else if (action === 'skip') {
          if (!confirm(`Skip draft for ${draft.contact?.full_name || 'this contact'}?`)) return;
          await api(`/api/drafts/${draft.id}/skip`, { method: 'POST' });
        } else if (action === 'regenerate') {
          showDraftsProgress(`Regenerating draft for ${draft.contact?.full_name || ''}…`);
          await api(`/api/drafts/${draft.id}/regenerate`, { method: 'POST' });
          clearDraftsProgress();
        } else if (action === 'send') {
          if (draft.status !== 'approved') {
            alert('Approve the draft before sending.');
            return;
          }
          if (!confirm(`Send to ${draft.contact?.email}? This will dispatch an email through Gmail right now.`)) return;
          showDraftsProgress(`Sending to ${draft.contact?.email}…`);
          await api(`/api/send/draft/${draft.id}`, { method: 'POST' });
          clearDraftsProgress();
        }
        await loadDrafts({ keepSelection: true });
      } catch (err) {
        if (errEl) errEl.textContent = err.message;
        else alert(err.message);
      } finally {
        btn.disabled = false;
      }
    });
  }

  // -------------------------------------------------------------------------
  // Sending page (/sending/:slug)
  // -------------------------------------------------------------------------
  let sendingCompany = null;
  let sendingEventSource = null;
  let nextInTimer = null;
  let nextInUntil = null;

  function logEvent(event) {
    const list = document.querySelector('#sending-log');
    if (!list) return;
    if (list.dataset.populated !== '1') {
      list.innerHTML = '';
      list.dataset.populated = '1';
    }
    const li = document.createElement('li');
    const colors = {
      send_started: 'text-[rgb(var(--coral-soft))]',
      send_success: 'text-emerald-300',
      send_failed: 'text-rose-300',
      next_in: 'text-amber-300',
      campaign_started: 'text-slate-200',
      campaign_paused: 'text-slate-400',
      campaign_resumed: 'text-slate-200',
      campaign_completed: 'text-emerald-300',
      stop_all: 'text-rose-300 font-semibold',
      hello: 'text-slate-500',
    };
    li.className = `px-4 py-2 ${colors[event.type] || 'text-slate-300'}`;
    const ts = event.ts ? new Date(event.ts).toLocaleTimeString() : new Date().toLocaleTimeString();
    const payload = { ...event };
    delete payload.ts;
    delete payload.type;
    const tail = Object.keys(payload).length ? ' ' + JSON.stringify(payload) : '';
    li.textContent = `[${ts}] ${event.type}${tail}`;
    list.prepend(li);
    while (list.children.length > 200) list.removeChild(list.lastChild);
  }

  async function refreshSendingKpis() {
    if (!sendingCompany) return;
    try {
      const snap = await api(`/api/send/campaign/${sendingCompany.id}/status`);
      const c = snap.counts || {};
      document.querySelector('#kpi-queued').textContent = c.queued || 0;
      document.querySelector('#kpi-sending').textContent = c.sending || 0;
      document.querySelector('#kpi-sent').textContent = c.sent || 0;
      document.querySelector('#kpi-failed').textContent = c.failed || 0;
      const pauseBtn = document.querySelector('#btn-pause');
      const resumeBtn = document.querySelector('#btn-resume');
      if (snap.paused) {
        pauseBtn?.classList.add('hidden');
        resumeBtn?.classList.remove('hidden');
      } else {
        pauseBtn?.classList.remove('hidden');
        resumeBtn?.classList.add('hidden');
      }
    } catch (err) {
      logEvent({ type: 'status_error', error: err.message });
    }
  }

  function setNextInCountdown(seconds) {
    if (typeof seconds !== 'number' || seconds < 0) {
      nextInUntil = null;
      return;
    }
    nextInUntil = Date.now() + seconds * 1000;
  }

  function tickNextIn() {
    const el = document.querySelector('#kpi-next-in');
    if (!el) return;
    if (!nextInUntil) {
      el.textContent = '';
      return;
    }
    const remaining = Math.max(0, Math.ceil((nextInUntil - Date.now()) / 1000));
    el.textContent = `${remaining}s`;
    if (remaining === 0) nextInUntil = null;
  }

  function openSseStream() {
    if (sendingEventSource) sendingEventSource.close();
    const es = new EventSource('/api/events/sends');
    sendingEventSource = es;

    es.onopen = () => {
      const s = document.querySelector('#sending-stream-status');
      if (s) {
        s.textContent = 'connected';
        s.className = 'text-emerald-300';
      }
    };
    es.onerror = () => {
      const s = document.querySelector('#sending-stream-status');
      if (s) {
        s.textContent = 'disconnected — retrying';
        s.className = 'text-rose-300';
      }
    };
    es.onmessage = (m) => {
      let event;
      try { event = JSON.parse(m.data); } catch { return; }
      if (!sendingCompany || (event.company_id && event.company_id !== sendingCompany.id) && event.type !== 'stop_all') {
        // ignore events for other companies
      } else {
        logEvent(event);
      }
      if (event.type === 'next_in' && typeof event.seconds === 'number') {
        setNextInCountdown(event.seconds);
      }
      if (['send_started', 'send_success', 'send_failed', 'campaign_started', 'campaign_paused',
           'campaign_resumed', 'campaign_completed', 'stop_all'].includes(event.type)) {
        refreshSendingKpis();
      }
      if (event.type === 'send_success' || event.type === 'send_started') {
        nextInUntil = null;
      }
    };

    es.addEventListener('hello', (m) => {
      try { logEvent({ type: 'hello', ...JSON.parse(m.data) }); } catch { /* */ }
    });
  }

  async function bindSendingPage() {
    const loading = document.querySelector('#sending-loading');
    if (!loading) return;

    const errBox = document.querySelector('#sending-error');
    const detail = document.querySelector('#sending-detail');

    const match = window.location.pathname.match(/^\/sending\/([^/?#]+)/);
    if (!match) {
      loading.classList.add('hidden');
      errBox.innerHTML =
        'Pick a campaign from <a href="/companies.html" class="text-[rgb(var(--coral-soft))] underline">Companies</a> and click <span class="text-slate-200">Send campaign</span> on its Drafts tab.';
      errBox.classList.remove('hidden');
      return;
    }
    const slug = decodeURIComponent(match[1]);

    try {
      sendingCompany = await api(`/api/companies/by-slug/${encodeURIComponent(slug)}`);
    } catch (err) {
      loading.classList.add('hidden');
      errBox.textContent = `Failed to load campaign "${slug}": ${err.message}`;
      errBox.classList.remove('hidden');
      return;
    }

    document.title = `Sending: ${sendingCompany.name} · Outreach Studio`;
    document.querySelector('#sending-name').textContent = `Sending: ${sendingCompany.name}`;
    document.querySelector('#back-link').href = `/companies/${encodeURIComponent(sendingCompany.slug)}`;
    document.querySelector('#back-link').textContent = `← Back to ${sendingCompany.name}`;
    loading.classList.add('hidden');
    detail.classList.remove('hidden');

    document.querySelector('#btn-pause')?.addEventListener('click', async () => {
      try {
        await api('/api/send/pause-campaign', { method: 'POST', body: { company_id: sendingCompany.id } });
      } catch (err) { alert(err.message); }
    });
    document.querySelector('#btn-resume')?.addEventListener('click', async () => {
      try {
        await api('/api/send/resume-campaign', { method: 'POST', body: { company_id: sendingCompany.id } });
      } catch (err) { alert(err.message); }
    });
    document.querySelector('#btn-stop-all')?.addEventListener('click', async () => {
      if (!confirm('STOP ALL sends across the whole tool? This reverts all queued drafts back to approved status.')) return;
      try {
        const r = await api('/api/send/stop-all', { method: 'POST' });
        logEvent({ type: 'stop_all', reverted: r.reverted });
      } catch (err) { alert(err.message); }
    });

    openSseStream();
    await refreshSendingKpis();
    nextInTimer = setInterval(tickNextIn, 1000);
    // Periodic refresh as a safety net for any missed SSE events.
    setInterval(refreshSendingKpis, 10_000);
  }

  // -------------------------------------------------------------------------
  // Log page (/log.html)
  // -------------------------------------------------------------------------
  const logState = { page: 1, page_size: 50, total: 0 };

  const logStatusStyles = {
    sent: 'bg-emerald-900/40 text-emerald-300',
    replied: 'bg-sky-900/60 text-sky-200',
    bounced: 'bg-rose-900/60 text-rose-200',
  };

  function logStatusBadge(s) {
    return `<span class="inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${logStatusStyles[s] || logStatusStyles.sent}">${escapeHtml(s)}</span>`;
  }

  function logFiltersFromForm() {
    const form = document.querySelector('#log-filters');
    if (!form) return {};
    const fd = new FormData(form);
    const out = {};
    for (const [k, v] of fd.entries()) {
      const s = (v || '').toString().trim();
      if (s) out[k] = s;
    }
    return out;
  }

  function logQueryString() {
    const params = new URLSearchParams({
      ...logFiltersFromForm(),
      page: String(logState.page),
      page_size: String(logState.page_size),
    });
    return params.toString();
  }

  async function loadLog() {
    const tbody = document.querySelector('#log-tbody');
    const summary = document.querySelector('#log-summary');
    const pageEl = document.querySelector('#log-page');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="6" class="px-4 py-10 text-center text-sm text-slate-500">Loading…</td></tr>';
    try {
      const res = await api(`/api/log?${logQueryString()}`);
      logState.total = res.total;
      const totalPages = Math.max(1, Math.ceil(res.total / logState.page_size));
      summary.textContent = `${res.total} send${res.total === 1 ? '' : 's'} match · page ${res.page} of ${totalPages}`;
      pageEl.textContent = `page ${res.page} of ${totalPages}`;
      document.querySelector('#log-prev').disabled = res.page <= 1;
      document.querySelector('#log-next').disabled = res.page >= totalPages;

      if (res.rows.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="px-4 py-10 text-center text-sm text-slate-500">No sends match the current filters.</td></tr>';
        return;
      }
      tbody.innerHTML = res.rows.map((r) => `
        <tr class="border-t border-slate-800 hover:bg-slate-900/40">
          <td class="px-3 py-2 text-xs text-slate-400">${escapeHtml(formatRelative(r.sent_at))}<div class="text-slate-600">${escapeHtml(r.sent_at)}</div></td>
          <td class="px-3 py-2 text-slate-200"><a href="/companies/${encodeURIComponent(r.company_slug || '')}" class="hover:text-[rgb(var(--coral-soft))]">${escapeHtml(r.company_name || '')}</a></td>
          <td class="px-3 py-2 text-slate-200">${escapeHtml(r.recipient)}<div class="text-xs text-slate-500">${escapeHtml(r.contact_name || '')}</div></td>
          <td class="px-3 py-2 text-slate-300">${escapeHtml(r.subject || '')}</td>
          <td class="px-3 py-2">${logStatusBadge(r.status)}</td>
          <td class="px-3 py-2 text-right tabular-nums text-slate-400">${r.sequence_step}</td>
        </tr>`).join('');
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="6" class="px-4 py-10 text-center text-sm text-rose-400">Failed to load: ${escapeHtml(err.message)}</td></tr>`;
    }
  }

  async function populateCompanyFilter() {
    try {
      const rows = await api('/api/companies');
      const select = document.querySelector('select[name="company_id"]');
      if (!select) return;
      for (const c of rows) {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = c.name;
        select.appendChild(opt);
      }
    } catch { /* non-fatal */ }
  }

  function bindLogPage() {
    if (!document.querySelector('#log-tbody')) return;
    loadLogStatus();
    setInterval(loadLogStatus, 15_000);
    populateCompanyFilter().then(loadLog);

    const form = document.querySelector('#log-filters');
    form?.addEventListener('change', () => {
      logState.page = 1;
      loadLog();
    });
    form?.addEventListener('input', (e) => {
      if (e.target.matches('input[type="search"]')) {
        clearTimeout(form._debounce);
        form._debounce = setTimeout(() => {
          logState.page = 1;
          loadLog();
        }, 300);
      }
    });
    document.querySelector('#log-prev')?.addEventListener('click', () => {
      if (logState.page > 1) {
        logState.page -= 1;
        loadLog();
      }
    });
    document.querySelector('#log-next')?.addEventListener('click', () => {
      logState.page += 1;
      loadLog();
    });
    document.querySelector('#log-export')?.addEventListener('click', () => {
      const params = new URLSearchParams(logFiltersFromForm());
      const url = `/api/log/export.csv?${params.toString()}`;
      window.location.href = url;
    });
  }

  // -------------------------------------------------------------------------
  // Settings page (/settings.html)
  // -------------------------------------------------------------------------
  const settingsStatusStyles = {
    configured: 'bg-emerald-900/40 text-emerald-300',
    placeholder: 'bg-amber-900/40 text-amber-300',
    not_configured: 'bg-rose-900/40 text-rose-300',
  };

  function statusChip(status) {
    return `<span class="inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${settingsStatusStyles[status] || settingsStatusStyles.not_configured}">${escapeHtml(status)}</span>`;
  }

  function renderConnections(data) {
    const body = document.querySelector('#connections-body');
    if (!body) return;
    const { anthropic, smtp, imap } = data.connections;
    body.innerHTML = `
      <div class="grid grid-cols-1 gap-3 md:grid-cols-3">
        <div class="rounded-md border border-slate-800 bg-slate-950/40 p-4">
          <div class="flex items-center justify-between"><span class="text-sm font-medium text-slate-200">Anthropic</span>${statusChip(anthropic.status)}</div>
          <div class="mt-1 text-xs text-slate-500">model: ${escapeHtml(anthropic.model)}</div>
          <button data-action="test-anthropic" class="mt-3 rounded-md border border-slate-700 px-3 py-1 text-xs text-slate-200 hover:bg-slate-800">Test</button>
          <p data-result="test-anthropic" class="mt-2 text-xs"></p>
        </div>
        <div class="rounded-md border border-slate-800 bg-slate-950/40 p-4">
          <div class="flex items-center justify-between"><span class="text-sm font-medium text-slate-200">SMTP</span>${statusChip(smtp.status)}</div>
          <div class="mt-1 text-xs text-slate-500">${escapeHtml(smtp.user)} @ ${escapeHtml(smtp.host)}:${smtp.port}</div>
          <button data-action="test-smtp" class="mt-3 rounded-md border border-slate-700 px-3 py-1 text-xs text-slate-200 hover:bg-slate-800">Test</button>
          <p data-result="test-smtp" class="mt-2 text-xs"></p>
        </div>
        <div class="rounded-md border border-slate-800 bg-slate-950/40 p-4">
          <div class="flex items-center justify-between"><span class="text-sm font-medium text-slate-200">IMAP</span>${statusChip(imap.status)}</div>
          <div class="mt-1 text-xs text-slate-500">${escapeHtml(imap.user)} @ ${escapeHtml(imap.host)}:${imap.port}</div>
          <button data-action="test-imap" class="mt-3 rounded-md border border-slate-700 px-3 py-1 text-xs text-slate-200 hover:bg-slate-800">Test</button>
          <p data-result="test-imap" class="mt-2 text-xs"></p>
        </div>
      </div>`;
  }

  function fillThrottleForm(tc) {
    const form = document.querySelector('#throttle-form');
    if (!form) return;
    for (const [k, v] of Object.entries(tc)) {
      const el = form.elements[k];
      if (el) el.value = v;
    }
  }

  function renderTemplates(templates) {
    const body = document.querySelector('#templates-body');
    if (!body) return;
    if (templates.length === 0) {
      body.innerHTML = '<p class="text-slate-500">No templates seeded.</p>';
      return;
    }
    body.innerHTML = templates.map((t) => `
      <details class="rounded-md border border-slate-800 bg-slate-950/40 p-3" data-template-id="${t.id}">
        <summary class="cursor-pointer text-sm font-medium text-slate-200">
          ${escapeHtml(t.name)} <span class="ml-2 text-xs text-slate-500">${escapeHtml(t.seniority || 'any')} · step ${t.sequence_step} · v${t.version}</span>
        </summary>
        <div class="mt-3 space-y-2 text-xs">
          <label class="block">
            <span class="block font-medium text-slate-300">Subject template</span>
            <input type="text" data-bind="subject" value="${escapeHtml(t.subject_template)}"
              class="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 font-mono text-slate-100" />
          </label>
          <label class="block">
            <span class="block font-medium text-slate-300">Body template</span>
            <textarea data-bind="body" rows="10" class="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 font-mono leading-5 text-slate-100">${escapeHtml(t.body_template)}</textarea>
          </label>
          <div class="flex items-center justify-end gap-3">
            <p data-result class="text-xs text-emerald-400 mr-auto"></p>
            <button data-action="save-template" type="button" class="rounded-md bg-[rgb(var(--coral))] px-3 py-1 text-xs font-medium text-white hover:bg-[rgb(var(--coral-deep))]">Save (bumps version)</button>
          </div>
        </div>
      </details>`).join('');
  }

  async function loadSettings() {
    try {
      const [data, profile, templates] = await Promise.all([
        api('/api/settings'),
        api('/api/settings/user-profile'),
        api('/api/settings/templates'),
      ]);
      renderConnections(data);
      fillThrottleForm(data.throttle);
      const profileForm = document.querySelector('#profile-form');
      if (profileForm) {
        const p = profile.contents || {};
        const setField = (name, val) => {
          const el = profileForm.elements[name];
          if (el) el.value = val || '';
        };
        setField('name', p.name);
        setField('first_name', p.first_name);
        setField('current_role', p.current_role);
        setField('current_company', p.current_company);
        setField('location', p.location);
        setField('summary', p.summary);
        setField('linkedin', p.links?.linkedin);
        setField('email', p.links?.email);
        const achievements = Array.isArray(p.key_achievements) ? p.key_achievements.join('\n') : (p.key_achievements || '');
        setField('key_achievements', achievements);
      }
      renderTemplates(templates);
    } catch (err) {
      const body = document.querySelector('#connections-body');
      if (body) body.innerHTML = `<p class="text-rose-400">Failed to load: ${escapeHtml(err.message)}</p>`;
    }
  }

  function bindSettingsPage() {
    if (!document.querySelector('#throttle-form')) return;
    loadSettings();

    document.querySelector('#connections-body')?.addEventListener('click', async (event) => {
      const btn = event.target.closest('button[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      const target = action.replace('test-', '');
      const result = document.querySelector(`[data-result="${action}"]`);
      if (result) { result.textContent = 'testing…'; result.className = 'mt-2 text-xs text-slate-400'; }
      btn.disabled = true;
      try {
        const r = await api(`/api/settings/test/${target}`, { method: 'POST' });
        if (result) {
          result.textContent = r.message || 'ok';
          result.className = 'mt-2 text-xs text-emerald-300';
        }
      } catch (err) {
        if (result) {
          result.textContent = err.message;
          result.className = 'mt-2 text-xs text-rose-300';
        }
      } finally {
        btn.disabled = false;
      }
    });

    document.querySelector('#throttle-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.target;
      const err = form.querySelector('[data-role="error"]');
      const saved = form.querySelector('[data-role="saved"]');
      if (err) err.textContent = '';
      if (saved) saved.textContent = '';
      const payload = {};
      for (const el of form.elements) {
        if (!el.name) continue;
        const v = el.value.trim();
        if (v === '') continue;
        payload[el.name] = el.type === 'number' ? Number(v) : v;
      }
      try {
        await api('/api/settings/throttle', { method: 'PUT', body: payload });
        if (saved) saved.textContent = 'Saved — takes effect immediately';
      } catch (e) {
        if (err) err.textContent = e.message;
      }
    });

    document.querySelector('#throttle-reset')?.addEventListener('click', async () => {
      if (!confirm('Reset throttle to .env defaults?')) return;
      try {
        const r = await api('/api/settings/throttle/reset', { method: 'POST' });
        fillThrottleForm(r.effective);
      } catch (e) { alert(e.message); }
    });

    document.querySelector('#user-profile-save')?.addEventListener('click', async () => {
      const form = document.querySelector('#profile-form');
      const err = document.querySelector('[data-role="profile-error"]');
      const saved = document.querySelector('[data-role="profile-saved"]');
      if (err) err.textContent = '';
      if (saved) saved.textContent = '';
      const getField = (name) => (form?.elements[name]?.value || '').trim();
      const rawAchievements = getField('key_achievements');
      const achievements = rawAchievements
        ? rawAchievements.split('\n').map((s) => s.trim()).filter(Boolean)
        : [];
      const payload = {
        name: getField('name'),
        first_name: getField('first_name'),
        current_role: getField('current_role'),
        current_company: getField('current_company'),
        location: getField('location'),
        summary: getField('summary'),
        key_achievements: achievements,
        links: {
          linkedin: getField('linkedin'),
          email: getField('email'),
        },
      };
      try {
        await api('/api/settings/user-profile', { method: 'PUT', body: payload });
        if (saved) saved.textContent = 'Saved';
      } catch (e) { if (err) err.textContent = e.message; }
    });

    document.querySelector('#templates-body')?.addEventListener('click', async (event) => {
      const btn = event.target.closest('button[data-action="save-template"]');
      if (!btn) return;
      const details = btn.closest('details[data-template-id]');
      const id = Number(details.dataset.templateId);
      const subject = details.querySelector('[data-bind="subject"]').value;
      const body = details.querySelector('[data-bind="body"]').value;
      const result = details.querySelector('[data-result]');
      if (result) result.textContent = '';
      try {
        const updated = await api(`/api/settings/templates/${id}`, {
          method: 'PUT',
          body: { subject_template: subject, body_template: body },
        });
        if (result) result.textContent = `Saved (v${updated.version})`;
        // Refresh just the version label
        const summary = details.querySelector('summary span');
        if (summary) summary.textContent = `${updated.seniority || 'any'} · step ${updated.sequence_step} · v${updated.version}`;
      } catch (e) {
        if (result) {
          result.textContent = e.message;
          result.className = 'text-xs text-rose-400 mr-auto';
        }
      }
    });

    document.querySelector('#theme-toggle')?.addEventListener('click', () => {
      document.documentElement.classList.toggle('dark');
      try {
        localStorage.setItem('outreach-theme', document.documentElement.classList.contains('dark') ? 'dark' : 'light');
      } catch { /* private mode */ }
    });

    try {
      const t = localStorage.getItem('outreach-theme');
      if (t === 'light') document.documentElement.classList.remove('dark');
    } catch { /* private mode */ }

    // --- Setup-once CV + Summary section ---
    async function loadSetupExtras() {
      try {
        const r = await api('/api/setup');
        const cvStatus = document.querySelector('#setup-cv-status');
        if (cvStatus) {
          cvStatus.textContent = r.cv_path
            ? `✅ ${r.cv_path.split('/').pop()} · ${r.cv_text?.length || 0} chars · uploaded ${formatRelative(r.cv_uploaded_at)}`
            : 'Not uploaded yet';
        }
        const ta = document.querySelector('#setup-summary');
        if (ta && r.detailed_summary) ta.value = r.detailed_summary;
      } catch { /* non-fatal */ }
    }
    document.querySelector('#setup-cv-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = e.target.querySelector('[data-role="setup-cv-msg"]');
      msg.textContent = 'uploading…'; msg.className = 'text-xs text-slate-400';
      try {
        const fd = new FormData(e.target);
        const r = await api('/api/setup/cv', { method: 'POST', body: fd });
        msg.textContent = `saved · extracted ${r.chars} chars${r.error?` (${r.error})`:''}`;
        msg.className = 'text-xs text-emerald-300';
        loadSetupExtras();
      } catch (err) { msg.textContent = err.message; msg.className='text-xs text-rose-300'; }
    });
    document.querySelector('#setup-summary-save')?.addEventListener('click', async () => {
      const msg = document.querySelector('[data-role="setup-summary-msg"]');
      msg.textContent = '';
      try {
        const v = document.querySelector('#setup-summary').value;
        await api('/api/setup/summary', { method: 'PUT', body: { detailed_summary: v } });
        msg.textContent = 'saved · used on next draft'; msg.className = 'mr-auto text-xs text-emerald-300';
      } catch (err) { msg.textContent = err.message; msg.className = 'mr-auto text-xs text-rose-300'; }
    });
    loadSetupExtras();
  }

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------
  function boot() {
    bindHome();
    bindCompaniesPage();
    loadCompanyDetail();
    bindSendingPage();
    bindLogPage();
    bindSettingsPage();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
