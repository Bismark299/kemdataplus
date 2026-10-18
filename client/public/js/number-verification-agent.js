(() => {
  const $ = id => document.getElementById(id);
  const input = $('phoneNumbers');
  const excelInput = $('excelFile');
  const submitButton = $('submitButton');
  const message = $('submitMessage');
  let source = 'MANUAL';
  let excelValues = null;

  function normalize(value) {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const raw = String(value).trim();
    if (!raw || /[a-z]/i.test(raw)) return null;
    const compact = raw.replace(/[\s().-]/g, '');
    return /^\+?\d{7,15}$/.test(compact) ? compact : null;
  }

  function currentValues() {
    const rawValues = source === 'EXCEL'
      ? (excelValues || [])
      : input.value.split(/[\n,;]+/);
    const valid = [];
    const invalid = [];
    const seen = new Set();
    rawValues.forEach(value => {
      const normalized = normalize(value);
      if (normalized) {
        if (!seen.has(normalized)) {
          seen.add(normalized);
          valid.push(normalized);
        }
      } else if (String(value ?? '').trim()) {
        invalid.push(String(value).trim());
      }
    });
    return { valid, invalid };
  }

  function updatePreview() {
    const { valid, invalid } = currentValues();
    $('previewCount').textContent = `${valid.length} valid${invalid.length ? ` · ${invalid.length} skipped` : ''}`;
    submitButton.disabled = valid.length === 0 || valid.length > 500;
    if (valid.length > 500) $('previewCount').textContent = `${valid.length} numbers · maximum is 500`;
  }

  function showMessage(text, type = '') {
    message.className = `nv-status-message${type ? ` ${type}` : ''}`;
    message.textContent = text;
  }

  async function loadMine() {
    const tbody = $('submissionRows');
    tbody.innerHTML = '<tr><td colspan="3" class="nv-empty">Loading your submissions…</td></tr>';
    try {
      const response = await fetch('/api/number-verification/mine', { credentials: 'include' });
      if (response.status === 401 || response.status === 403) return location.replace('/pages/login.html');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not load submissions.');
      if (!data.submissions.length) {
        tbody.innerHTML = '<tr><td colspan="3" class="nv-empty">You have not submitted any numbers yet.</td></tr>';
        return;
      }
      tbody.innerHTML = data.submissions.map(item => {
        const status = item.status.toLowerCase();
        const label = item.status.charAt(0) + item.status.slice(1).toLowerCase();
        const note = item.reviewNote ? `<div class="nv-hint">${escapeHtml(item.reviewNote)}</div>` : '';
        return `<tr><td><span class="nv-phone">${escapeHtml(item.phoneNumber)}</span>${note}</td><td>${formatDate(item.createdAt)}</td><td><span class="nv-badge ${status}">${escapeHtml(label)}</span></td></tr>`;
      }).join('');
    } catch (error) {
      tbody.innerHTML = `<tr><td colspan="3" class="nv-empty">${escapeHtml(error.message)}</td></tr>`;
    }
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  }

  function formatDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
  }

  input.addEventListener('input', () => {
    source = 'MANUAL';
    excelValues = null;
    excelInput.value = '';
    $('fileName').textContent = 'Choose an Excel or CSV file';
    updatePreview();
  });

  excelInput.addEventListener('change', async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      showMessage('Choose a file smaller than 5 MB.', 'error');
      excelInput.value = '';
      return;
    }
    if (!window.XLSX) {
      showMessage('The Excel reader could not load. Refresh and try again, or paste the numbers.', 'error');
      return;
    }
    try {
      const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(firstSheet, { header: 1, raw: false, defval: '' });
      const values = rows.map(row => row?.[0]).filter(value => String(value ?? '').trim());
      if (values.length && /^(phone|phone number|mobile|mobile number|number|momo number|contact)$/i.test(String(values[0]).trim())) {
        values.shift();
      }
      source = 'EXCEL';
      excelValues = values;
      input.value = '';
      $('fileName').textContent = file.name;
      showMessage(values.length ? `Read ${values.length} non-empty cells from the first column.` : 'No numbers found in the first column.', values.length ? '' : 'error');
      updatePreview();
    } catch (error) {
      showMessage('Could not read this file. Please use .xlsx, .xls, or .csv.', 'error');
    }
  });

  submitButton.addEventListener('click', async () => {
    const { valid } = currentValues();
    if (!valid.length || valid.length > 500) return;
    submitButton.disabled = true;
    submitButton.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Submitting…';
    showMessage('');
    try {
      const response = await fetch('/api/number-verification', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ numbers: valid, source })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Submission failed.');
      input.value = '';
      excelInput.value = '';
      excelValues = null;
      source = 'MANUAL';
      $('fileName').textContent = 'Choose an Excel or CSV file';
      updatePreview();
      const extras = [
        data.duplicateCount ? `${data.duplicateCount} duplicate${data.duplicateCount === 1 ? '' : 's'} removed` : '',
        data.invalidCount ? `${data.invalidCount} invalid entr${data.invalidCount === 1 ? 'y' : 'ies'} skipped` : '',
        data.alreadyHandledCount ? `${data.alreadyHandledCount} already submitted or verified, not re-queued as pending` : ''
      ].filter(Boolean).join('; ');
      showMessage(`${data.submittedCount} number${data.submittedCount === 1 ? '' : 's'} submitted for verification${extras ? ` (${extras})` : ''}.`, 'success');
      await loadMine();
    } catch (error) {
      showMessage(error.message, 'error');
    } finally {
      submitButton.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Submit for verification';
      updatePreview();
    }
  });

  $('refreshButton').addEventListener('click', loadMine);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') loadMine();
  });
  setInterval(() => {
    if (document.visibilityState === 'visible') loadMine();
  }, 30000);
  updatePreview();
  loadMine();
})();
