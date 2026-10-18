(() => {
  const $ = id => document.getElementById(id);
  let page = 1;
  let total = 0;
  let searchTimer;
  const pageSize = 100;

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  }
  function formatDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
  }
  function queryString(includePage = true) {
    const params = new URLSearchParams();
    const q = $('searchInput').value.trim();
    const status = $('statusFilter').value;
    if (q) params.set('q', q);
    if (status) params.set('status', status);
    if (includePage) params.set('page', page);
    return params.toString();
  }
  async function api(url, options = {}) {
    const response = await fetch(url, { credentials: 'include', ...options });
    const data = response.headers.get('content-type')?.includes('application/json') ? await response.json() : null;
    if (response.status === 401 || response.status === 403) location.replace('/pages/login.html');
    if (!response.ok) throw new Error(data?.error || 'Request failed.');
    return { response, data };
  }
  function toast(text) {
    const element = $('toast');
    element.textContent = text;
    element.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { element.hidden = true; }, 3000);
  }
  async function load() {
    $('submissionRows').innerHTML = '<tr><td colspan="5" class="nv-empty">Loading submissions…</td></tr>';
    try {
      const { data } = await api(`/api/admin/number-verification?${queryString()}`);
      total = data.total;
      $('statusCounts').innerHTML = ['PENDING', 'SUBMITTED', 'VERIFIED', 'REJECTED'].map(status =>
        `<span class="nv-stat">${status}: <strong>${Number(data.counts?.[status] || 0).toLocaleString()}</strong></span>`
      ).join('');
      $('pageLabel').textContent = `Page ${data.page} · ${data.total.toLocaleString()} submissions`;
      $('previousPage').disabled = page <= 1;
      $('nextPage').disabled = page * pageSize >= total;
      if (!data.submissions.length) {
        $('submissionRows').innerHTML = '<tr><td colspan="5" class="nv-empty">No matching submissions.</td></tr>';
        return;
      }
      $('submissionRows').innerHTML = data.submissions.map(item => {
        const agent = item.submittedBy || {};
        const agentLine = [agent.name, agent.agentCode].filter(Boolean).map(escapeHtml).join(' · ');
        const reviewStatuses = item.status === 'PENDING'
          ? ['PENDING', 'VERIFIED', 'REJECTED']
          : item.status === 'SUBMITTED'
            ? ['SUBMITTED', 'VERIFIED', 'REJECTED']
            : ['VERIFIED', 'REJECTED'];
        return `<tr>
          <td><span class="nv-phone">${escapeHtml(item.phoneNumber)}</span></td>
          <td>${agentLine || '—'}<div class="nv-hint">${escapeHtml(agent.email || agent.phone || '')}</div></td>
          <td>${formatDate(item.createdAt)}</td>
          <td>${escapeHtml(item.source)}</td>
          <td>
            <div class="nv-review">
              <select class="nv-select" data-status-for="${escapeHtml(item.id)}" aria-label="Review status">
                ${reviewStatuses.map(status => `<option value="${status}" ${item.status === status ? 'selected' : ''}>${status.charAt(0) + status.slice(1).toLowerCase()}</option>`).join('')}
              </select>
              <input class="nv-search" data-note-for="${escapeHtml(item.id)}" maxlength="500" placeholder="Review note" value="${escapeHtml(item.reviewNote || '')}" aria-label="Review note">
              <button class="nv-button" data-save-id="${escapeHtml(item.id)}">Save</button>
            </div>
          </td>
        </tr>`;
      }).join('');
    } catch (error) {
      $('submissionRows').innerHTML = `<tr><td colspan="5" class="nv-empty">${escapeHtml(error.message)}</td></tr>`;
    }
  }
  async function exportFile(format) {
    try {
      const query = queryString(false);
      const url = `/api/admin/number-verification/export?${query}${query ? '&' : ''}format=${format}`;
      const response = await fetch(url, { credentials: 'include' });
      if (!response.ok) {
        let data = {};
        try { data = await response.json(); } catch {}
        throw new Error(data.error || 'Could not export the submissions.');
      }
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = format === 'csv' ? 'number-verification-submissions.csv' : 'submitted-phone-numbers.txt';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(objectUrl);
      toast('Download started.');
    } catch (error) {
      toast(error.message || 'Could not copy numbers. Check clipboard access.');
    }
  }
  async function copyPendingForVerification() {
    const button = $('copyNumbers');
    button.disabled = true;
    try {
      const response = await fetch('/api/admin/number-verification/copy-pending', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: $('searchInput').value.trim() })
      });
      const data = await response.json();
      if (response.status === 401 || response.status === 403) location.replace('/pages/login.html');
      if (!response.ok) throw new Error(data.error || 'Could not copy pending numbers.');
      if (!data.numbers.length) {
        toast('No matching pending numbers to copy.');
        return;
      }
      const text = data.numbers.join('\n');
      try {
        await navigator.clipboard.writeText(text);
        toast(`Copied ${data.copiedCount} unique number${data.copiedCount === 1 ? '' : 's'}; marked ${data.markedCount} entries Submitted.`);
      } catch {
        $('copyFallbackText').value = text;
        $('copyFallback').hidden = false;
        $('copyFallbackText').focus();
        $('copyFallbackText').select();
        toast(`Marked ${data.markedCount} entries Submitted. Select the numbers in the dialog to copy them.`);
      }
      $('statusFilter').value = 'SUBMITTED';
      page = 1;
      await load();
    } catch (error) {
      toast(error.message);
    } finally {
      button.disabled = false;
    }
  }
  async function retryFallbackCopy() {
    const text = $('copyFallbackText').value;
    try {
      await navigator.clipboard.writeText(text);
      $('copyFallback').hidden = true;
      toast('Submitted numbers copied.');
    } catch {
      $('copyFallbackText').focus();
      $('copyFallbackText').select();
      toast('The list is selected. Copy it using your keyboard or device menu.');
    }
  }
  function updateCopyButton() {
    const status = $('statusFilter').value;
    const unavailable = Boolean(status && status !== 'PENDING');
    $('copyNumbers').disabled = unavailable;
    $('copyNumbers').title = unavailable
      ? 'Choose Pending or All statuses to copy numbers for verification.'
      : 'Copies unique pending numbers and marks them Submitted.';
  }
  $('applyFilters').addEventListener('click', () => { page = 1; load(); });
  $('searchInput').addEventListener('keydown', event => {
    if (event.key === 'Enter') { page = 1; load(); }
  });
  $('searchInput').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { page = 1; load(); }, 350);
  });
  $('statusFilter').addEventListener('change', () => { page = 1; updateCopyButton(); load(); });
  $('previousPage').addEventListener('click', () => { if (page > 1) { page--; load(); } });
  $('nextPage').addEventListener('click', () => { if (page * pageSize < total) { page++; load(); } });
  $('copyNumbers').addEventListener('click', copyPendingForVerification);
  $('downloadNumbers').addEventListener('click', () => exportFile('txt'));
  $('downloadCsv').addEventListener('click', () => exportFile('csv'));
  $('copyFallbackButton').addEventListener('click', retryFallbackCopy);
  $('closeCopyFallback').addEventListener('click', () => { $('copyFallback').hidden = true; });
  $('copyFallback').addEventListener('click', event => {
    if (event.target === $('copyFallback')) $('copyFallback').hidden = true;
  });
  $('submissionRows').addEventListener('click', async event => {
    const button = event.target.closest('[data-save-id]');
    if (!button) return;
    button.disabled = true;
    try {
      const id = button.dataset.saveId;
      const status = document.querySelector(`[data-status-for="${CSS.escape(id)}"]`).value;
      const reviewNote = document.querySelector(`[data-note-for="${CSS.escape(id)}"]`).value;
      await api(`/api/admin/number-verification/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, reviewNote })
      });
      toast('Review saved.');
      await load();
    } catch (error) {
      toast(error.message);
    } finally {
      button.disabled = false;
    }
  });
  updateCopyButton();
  load();
})();
