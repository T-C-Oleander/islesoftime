// =============================================================================
// CONTINUANCE ARCHIVE -- RENDERER
// renderer.js
// Loads index.json manifest, builds nav, fetches and renders Atlas documents.
// Adapted from AtlOS renderer.js. Tauri bridge removed. No folder management.
// =============================================================================

'use strict';

// Nav index -- all manifest entries.
let navIndex = [];

// Active filter sets.
const activeEraFilters = new Set();
const activeVerificationFilters = new Set();

// Map from filing code ref -> nav entry.
const navDocMap = new Map();

// =============================================================================
// FILE READ -- fetch only (no Tauri)
// =============================================================================

async function readFile(filePath) {
  const res = await fetch(filePath);
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${filePath}`);
  return await res.text();
}

// =============================================================================
// PARSER
// Parses a raw .txt Atlas Directive document into a structured object.
// =============================================================================

function parseFilingCode(code) {
  if (!code) return { raw: '', valid: false };
  const match = code.trim().match(/^([A-Z]{3})-E(\d{2})-D(\d{4})$/);
  if (!match) return { raw: code.trim(), valid: false };
  return {
    raw: match[0], prefix: match[1],
    era: parseInt(match[2], 10), eraLabel: `E${match[2]}`,
    position: parseInt(match[3], 10), valid: true
  };
}

function parseDocument(raw) {
  const lines = raw.split('\n');

  const header = {};
  for (const line of lines) {
    if (line.includes('FIDES UNITATIS')) break;
    const match = line.match(/^([A-Z][A-Z\s\/]{2,})\s*:\s*(.+)$/);
    if (match) header[match[1].trim()] = match[2].trim();
  }

  const sections = {};
  let currentSection = null;
  let currentLines = [];
  let inHeader = true;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.includes('FIDES UNITATIS')) { continue; }
    if (/^preserve\.\s+record\.\s+reconcile\.$/i.test(trimmed)) { inHeader = false; continue; }
    if (inHeader) continue;
    if (/^[=\-]{4,}$/.test(trimmed)) continue;

    if (trimmed === 'NOTE ON THIS FILING:') {
      if (currentSection && currentLines.length) sections[currentSection] = currentLines.join('\n').trim();
      currentSection = 'NOTE'; currentLines = []; continue;
    }

    const sectionMatch = trimmed.match(/^\[\s*(.+?)\s*\]$/);
    if (sectionMatch) {
      if (currentSection && currentLines.length) sections[currentSection] = currentLines.join('\n').trim();
      currentSection = sectionMatch[1].trim(); currentLines = []; continue;
    }

    if (trimmed.startsWith('FILED BY') || trimmed === 'ATLAS DIRECTIVE RECORD -- END OF FILING') break;
    if (currentSection) currentLines.push(line);
  }
  if (currentSection && currentLines.length) sections[currentSection] = currentLines.join('\n').trim();

  const footer = {};
  let inFooter = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('FILED BY')) inFooter = true;
    if (trimmed === 'ATLAS DIRECTIVE RECORD -- END OF FILING') break;
    if (inFooter) {
      const match = line.match(/^([A-Z][A-Z\s]{2,})\s*:\s*(.+)$/);
      if (match) footer[match[1].trim()] = match[2].trim();
    }
  }

  const compilation = { contributors: [], primaryAuth: '' };
  let inCompilation = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === 'COMPILATION INDEX') { inCompilation = true; continue; }
    if (trimmed === 'ATLAS DIRECTIVE RECORD -- END OF FILING') break;
    if (!inCompilation || /^[=]{4,}$/.test(trimmed)) continue;
    if (!trimmed || trimmed === 'Contributing departments:') continue;
    if (trimmed.startsWith('Primary issuing authority')) {
      const m = trimmed.match(/:\s*([A-Z]{2,4})\s/);
      if (m) compilation.primaryAuth = m[1].trim();
      continue;
    }
    if (trimmed.startsWith('Filing code')) continue;
    const m = trimmed.match(/^([A-Z]{2,4})\s{2,}(.+)$/);
    if (m) compilation.contributors.push({ code: m[1].trim(), name: m[2].trim() });
  }

  return {
    filingCode: parseFilingCode(header['DOCUMENT REF'] || ''),
    compilation: compilation.contributors.length ? compilation : null,
    header: {
      ref:            header['DOCUMENT REF']   || '',
      issuingAuth:    header['ISSUING AUTH']   || '',
      subject:        header['SUBJECT']        || '',
      title:          header['DOCUMENT TITLE'] || '',
      fileDate:       header['FILE DATE']      || '',
      earthRef:       header['EARTH REF']      || '',
      classification: header['CLASSIFICATION'] || '',
      verification:   header['VERIFICATION']   || '',
      sealStatus:     header['SEAL STATUS']    || '',
    },
    sections,
    footer: {
      filedBy:      footer['FILED BY']      || '',
      sealCode:     footer['SEAL CODE']     || '',
      humanImprint: footer['HUMAN IMPRINT'] || ''
    }
  };
}

// =============================================================================
// RENDERER
// =============================================================================

function verificationClass(state) {
  const map = {
    'SOURCE': 'source', 'VERIFIED': 'verified', 'UNVERIFIED': 'unverified',
    'DISPUTED': 'disputed', 'FLAGGED': 'disputed',
    'CLASSIFIED': 'restricted', 'BLACKBOX': 'restricted',
    'HOSTILE': 'restricted', 'HAZARDOUS': 'restricted', 'BASILISK': 'restricted'
  };
  return map[state] || 'unverified';
}

function escapeHtml(str) {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderSection(name, content, index) {
  if (!content) return '';
  const esc = escapeHtml(content);

  if (name === 'NOTE') {
    return `<div class="arc-note stagger-reveal" style="--i:${index}">${esc.replace(/\n/g, '<br>')}</div>`;
  }

  if (name === 'MANDATE STATEMENT') {
    const items = esc.split('\n').filter(l => l.trim());
    let i = index;
    const itemsHtml = items.map(line =>
      `<div class="arc-mandate-item stagger-reveal" style="--i:${i++}">${line}</div>`
    ).join('');
    return `
      <div class="arc-section-label stagger-reveal" style="--i:${index}">Mandate Statement</div>
      <div class="arc-mandate">${itemsHtml}</div>`;
  }

  if (name === 'COMMENTARY') {
    const paras = esc.split(/\n\n+/).filter(p => p.trim());
    let i = index;
    const parasHtml = paras.map(p =>
      `<p class="arc-text stagger-reveal" style="--i:${i++}">${p.replace(/\n/g, ' ').trim()}</p>`
    ).join('');
    return `
      <div class="arc-section-label stagger-reveal" style="--i:${index}">${name.charAt(0) + name.slice(1).toLowerCase()}</div>
      <div class="arc-commentary">${parasHtml}</div>`;
  }

  if (name === 'BENEDICTION') {
    return `
      <div class="arc-benediction stagger-reveal" style="--i:${index}">
        <div class="arc-benediction-text">${esc.replace(/\n/g, '&nbsp;&nbsp;&nbsp;')}</div>
      </div>`;
  }

  const label = name.charAt(0) + name.slice(1).toLowerCase();
  const paras = esc.split(/\n\n+/).filter(p => p.trim());
  let i = index + 1;
  const parasHtml = paras.map(p =>
    `<p class="arc-text stagger-reveal" style="--i:${i++}">${p.replace(/\n/g, ' ').trim()}</p>`
  ).join('');
  return `<div class="arc-section-label stagger-reveal" style="--i:${index}">${label}</div>${parasHtml}`;
}

function renderDocument(doc) {
  const v = doc.header.verification;
  const vClass = verificationClass(v);

  document.querySelector('.arc-doc-ref').textContent =
    `${doc.header.ref} \u00a0/\u00a0 ${doc.header.issuingAuth}`;
  document.querySelector('.arc-doc-title').textContent = doc.header.title;

  const metaRow = document.querySelector('.arc-meta-row');
  metaRow.innerHTML = [
    ['File Date',      doc.header.fileDate],
    ['Earth Ref',      doc.header.earthRef],
    ['Classification', doc.header.classification],
    ['Seal Status',    doc.header.sealStatus],
  ].filter(([, val]) => val).map(([key, val]) => `
    <div class="arc-meta-item">
      <span class="arc-meta-key">${key}</span>
      <span class="arc-meta-value">${escapeHtml(val)}</span>
    </div>`).join('');

  document.querySelector('.arc-verify-state').textContent = v || 'UNVERIFIED';
  document.querySelector('.arc-verify-state').className = `arc-verify-state ${vClass}`;
  document.querySelector('.arc-verify .status-dot').className = `status-dot ${vClass}`;

  const ORDER = ['NOTE', 'PREAMBLE', 'MANDATE STATEMENT', 'OPERATIONAL NOTES', 'COMMENTARY'];
  let index = 0;
  const hasSections = Object.keys(doc.sections).length > 0;

  let bodyHtml;
  if (hasSections) {
    const rendered = new Set(['BENEDICTION']);
    bodyHtml = ORDER.map(name => {
      if (!doc.sections[name]) return '';
      rendered.add(name);
      const html = renderSection(name, doc.sections[name], index);
      index += 6;
      return html;
    }).join('');
    for (const name of Object.keys(doc.sections)) {
      if (!rendered.has(name)) {
        bodyHtml += renderSection(name, doc.sections[name], index);
        index += 6;
      }
    }
    if (doc.sections['BENEDICTION']) {
      bodyHtml += renderSection('BENEDICTION', doc.sections['BENEDICTION'], index);
    }
  } else {
    const raw = doc.raw || '';
    const lines = raw.split('\n');
    let inBody = false;
    const bodyLines = [];
    for (const line of lines) {
      if (/preserve\.\s+record\.\s+reconcile\./i.test(line)) { inBody = true; continue; }
      if (!inBody) continue;
      if (/^[=]{4,}$/.test(line.trim())) continue;
      if (line.trim().startsWith('FILED BY') || line.trim() === 'ATLAS DIRECTIVE RECORD -- END OF FILING') break;
      bodyLines.push(line);
    }
    const text = bodyLines.join('\n').trim();
    const paras = text.split(/\n\n+/).filter(p => p.trim());
    bodyHtml = paras.map((p, i) =>
      `<p class="arc-text stagger-reveal" style="--i:${i}">${escapeHtml(p.replace(/\n/g, ' ').trim())}</p>`
    ).join('');
  }

  if (doc.compilation) {
    const primary = doc.compilation.primaryAuth;
    const depts = doc.compilation.contributors.map(c => `
      <div class="arc-compilation-dept">
        <span class="arc-compilation-code">${escapeHtml(c.code)}</span>
        <span class="arc-compilation-name">${escapeHtml(c.name)}</span>
        ${c.code === primary ? '<span class="arc-compilation-primary">PRIMARY</span>' : ''}
      </div>`).join('');
    bodyHtml += `
      <div class="arc-compilation-index">
        <div class="arc-compilation-header">COMPILATION INDEX</div>
        ${depts}
      </div>`;
  }

  const docBody = document.getElementById('doc-body');
  docBody.innerHTML = bodyHtml;
  docBody.scrollTop = 0;

  document.querySelector('.arc-seal-code').textContent = doc.footer.sealCode;
  const imprintEl = document.querySelector('.arc-human-imprint');
  const hasImprint = doc.footer.humanImprint && doc.footer.humanImprint.toLowerCase().includes('confirmed');
  imprintEl.textContent = hasImprint ? 'HUMAN IMPRINT: CONFIRMED' : 'HUMAN IMPRINT: DIGITAL COPY';
  imprintEl.className = `arc-human-imprint${hasImprint ? ' confirmed' : ''}`;

  const items = document.querySelectorAll('.arc-statusbar-item');
  if (items[0]) items[0].innerHTML = `<span>DOCUMENTS</span> \u00a0${navIndex.length || '--'}`;
  if (items[1]) items[1].innerHTML = `<span>ERA</span> \u00a0${doc.filingCode.eraLabel || '--'}`;
  if (items[2]) items[2].innerHTML = `<span>VERIFICATION</span> \u00a0${v || '--'}`;
}

// =============================================================================
// DOCUMENT LOADING -- lazy fetch on nav click
// =============================================================================

function setActiveNav(ref) {
  document.querySelectorAll('.arc-nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.ref === ref);
  });
}

async function loadNavDocument(doc) {
  if (doc._loaded) {
    renderDocument(doc);
    setActiveNav(doc.filingCode.raw);
    loadAudioPanel(doc.audioPath);
    return;
  }
  try {
    const raw = await readFile(doc.filePath);
    const parsed = parseDocument(raw);
    parsed.raw = raw;
    parsed.filePath = doc.filePath;
    parsed.audioPath = doc.audioPath;
    parsed._loaded = true;
    Object.assign(doc, parsed);
    renderDocument(doc);
    setActiveNav(doc.filingCode.raw);
    loadAudioPanel(doc.audioPath);
  } catch (err) {
    console.error('Failed to load document:', doc.filePath, err);
    document.getElementById('doc-body').innerHTML =
      `<div class="arc-note" style="color: var(--status-restricted); opacity: 1;">
        LODESTONE ERROR: Could not load ${escapeHtml(doc.filingCode.raw)}<br>${escapeHtml(String(err))}
      </div>`;
  }
}

// =============================================================================
// NAV BUILD -- loads index.json, builds navigation from manifest
// =============================================================================

async function initArchive() {
  const scroll = document.getElementById('nav-scroll');
  const filtersEl = document.getElementById('nav-filters');

  scroll.innerHTML = '<div class="arc-nav-pending">LODESTONE INDEXING\u2026</div>';
  if (filtersEl) filtersEl.innerHTML = '';
  navIndex = [];
  navDocMap.clear();
  activeEraFilters.clear();
  activeVerificationFilters.clear();

  let manifest;
  try {
    const res = await fetch('index.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    manifest = await res.json();
  } catch (err) {
    scroll.innerHTML =
      `<div class="arc-nav-pending" style="color:var(--status-restricted)">
        INDEX ERROR<br>${escapeHtml(String(err))}
      </div>`;
    return;
  }

  const docs = manifest.documents || [];

  for (const entry of docs) {
    if (!entry.ref || !entry.file) continue;
    const fc = parseFilingCode(entry.ref);
    if (!fc.valid) continue;
    const doc = {
      filingCode: fc,
      filePath: entry.file,
      header: {
        ref:            entry.ref,
        title:          entry.title        || entry.ref,
        verification:   entry.verification || 'UNVERIFIED',
        issuingAuth:    entry.issuingAuth  || '',
        fileDate:       '',
        earthRef:       '',
        classification: '',
        sealStatus:     ''
      },
      sections: {},
      footer: { filedBy: '', sealCode: '', humanImprint: '' },
      compilation: null,
      audioPath: entry.audio || null,
      _loaded: false
    };
    navIndex.push(doc);
    navDocMap.set(fc.raw, doc);
  }

  navIndex.sort((a, b) => {
    if (a.filingCode.era !== b.filingCode.era) return a.filingCode.era - b.filingCode.era;
    return a.filingCode.position - b.filingCode.position;
  });

  document.getElementById('nav-doc-count').textContent =
    `${navIndex.length} document${navIndex.length !== 1 ? 's' : ''}`;

  if (navIndex.length === 0) {
    scroll.innerHTML = '<div class="arc-nav-pending">Archive pending. No documents indexed.</div>';
    return;
  }

  const eraMap = new Map();
  for (const doc of navIndex) {
    const key = doc.filingCode.eraLabel;
    if (!eraMap.has(key)) eraMap.set(key, { label: key, era: doc.filingCode.era, docs: [] });
    eraMap.get(key).docs.push(doc);
  }

  const sortedEras = [...eraMap.values()].sort((a, b) => a.era - b.era);

  scroll.innerHTML = sortedEras.map(era => {
    const n = era.era.toString().padStart(2, '0');
    const items = era.docs.map(doc => {
      const vClass = verificationClass(doc.header.verification || 'UNVERIFIED');
      const contributors = doc.filingCode.prefix || '';
      return `<div class="arc-nav-item"
          data-ref="${escapeHtml(doc.filingCode.raw)}"
          data-era="${escapeHtml(doc.filingCode.eraLabel)}"
          data-verification="${escapeHtml(doc.header.verification || 'UNVERIFIED')}"
          data-title="${escapeHtml(doc.header.title)}"
          data-contributors="${escapeHtml(contributors)}">
          <span class="status-dot ${vClass} arc-nav-item-dot"></span>
          <div class="arc-nav-item-body">
            <div class="arc-nav-item-title">${escapeHtml(doc.header.title || doc.filingCode.raw)}</div>
            <div class="arc-nav-item-code">${escapeHtml(doc.filingCode.raw)}</div>
          </div>
        </div>`;
    }).join('');

    return `<div class="arc-nav-section" data-era="${escapeHtml(era.label)}">
        <div class="arc-nav-era">
          <span class="arc-nav-era-label">E${n} &mdash; ERA ${n}</span>
          <span class="arc-nav-era-count">${era.docs.length}</span>
        </div>
        ${items}
      </div>`;
  }).join('');

  document.querySelectorAll('.arc-nav-item[data-ref]').forEach(el => {
    el.addEventListener('click', () => {
      const doc = navDocMap.get(el.dataset.ref);
      if (doc) loadNavDocument(doc);
    });
  });

  buildTagFilters(navIndex);

  if (navIndex.length > 0) {
    loadNavDocument(navIndex[0]);
  }
}

// =============================================================================
// SEARCH AND FILTERS
// =============================================================================

window.filterNav = function() {
  const query = document.getElementById('nav-search').value.toLowerCase().trim();

  document.querySelectorAll('.arc-nav-item[data-ref]').forEach(el => {
    const title = (el.dataset.title || '').toLowerCase();
    const ref = (el.dataset.ref || '').toLowerCase();
    const era = el.dataset.era || '';
    const verification = el.dataset.verification || '';
    const contributors = (el.dataset.contributors || '').toLowerCase();

    const matchesSearch = !query || title.includes(query) || ref.includes(query) || contributors.includes(query);
    const matchesEra = activeEraFilters.size === 0 || activeEraFilters.has(era);
    const matchesVerification = activeVerificationFilters.size === 0 || activeVerificationFilters.has(verification);

    el.style.display = (matchesSearch && matchesEra && matchesVerification) ? '' : 'none';
  });

  document.querySelectorAll('.arc-nav-section').forEach(section => {
    const anyVisible = [...section.querySelectorAll('.arc-nav-item')].some(
      el => el.style.display !== 'none'
    );
    section.style.display = anyVisible ? '' : 'none';
  });
};

window.toggleFilter = function(type, value) {
  const set = type === 'era' ? activeEraFilters : activeVerificationFilters;
  if (set.has(value)) { set.delete(value); } else { set.add(value); }
  document.querySelectorAll(`.arc-nav-filter-tag[data-filter-type="${type}"]`).forEach(btn => {
    if (btn.dataset.filterValue === value) btn.classList.toggle('active', set.has(value));
  });
  window.filterNav();
};

function buildTagFilters(docs) {
  const filtersEl = document.getElementById('nav-filters');
  if (!filtersEl) return;

  const eras = [...new Set(docs.map(d => d.filingCode.eraLabel))].sort();
  const verifications = [...new Set(
    docs.map(d => d.header.verification || 'UNVERIFIED').filter(Boolean)
  )].sort();

  if (eras.length <= 1 && verifications.length <= 1) {
    filtersEl.innerHTML = '';
    return;
  }

  let html = '';
  if (eras.length > 1) {
    html += `<div class="arc-nav-filter-row">${eras.map(era =>
      `<button class="arc-nav-filter-tag" data-filter-type="era" data-filter-value="${escapeHtml(era)}"
        onclick="toggleFilter('era','${escapeHtml(era)}')">${escapeHtml(era)}</button>`
    ).join('')}</div>`;
  }
  if (verifications.length > 1) {
    html += `<div class="arc-nav-filter-row">${verifications.map(v =>
      `<button class="arc-nav-filter-tag" data-filter-type="verification" data-filter-value="${escapeHtml(v)}"
        onclick="toggleFilter('verification','${escapeHtml(v)}')">${escapeHtml(v)}</button>`
    ).join('')}</div>`;
  }
  filtersEl.innerHTML = html;
}

// =============================================================================
// INIT
// =============================================================================

document.addEventListener('DOMContentLoaded', initArchive);

// =============================================================================
// AUDIO PANEL -- waveform visualizer fed from document audio file
// =============================================================================

let _audioCtx      = null;
let _analyser      = null;
let _source        = null;
let _audioEl       = null;
let _rafId         = null;
let _currentPath   = null;

function loadAudioPanel(audioPath) {
  const panel = document.getElementById('audio-panel');

  if (!audioPath) {
    closeAudioPanel();
    return;
  }

  // Same file already loaded — don't restart
  if (audioPath === _currentPath) {
    panel.classList.add('open');
    return;
  }

  _currentPath = audioPath;
  stopAudio();
  panel.classList.add('open');

  _audioEl = new Audio(audioPath);
  _audioEl.preload = 'auto';

  _audioEl.addEventListener('timeupdate', updateProgress);
  _audioEl.addEventListener('ended', () => {
    document.getElementById('audio-play-btn').textContent = 'PLAY';
    document.getElementById('audio-play-btn').classList.remove('playing');
    document.getElementById('audio-progress-bar').style.width = '0%';
    document.getElementById('audio-time').textContent = '0:00';
  });

  resizeCanvas();
}

window.closeAudioPanel = function() {
  stopAudio();
  _currentPath = null;
  document.getElementById('audio-panel').classList.remove('open');
};

window.toggleAudio = function() {
  if (!_audioEl) return;

  if (_audioEl.paused) {
    // Build audio context on first play (browser requires user gesture)
    if (!_audioCtx) {
      _audioCtx  = new (window.AudioContext || window.webkitAudioContext)();
      _analyser  = _audioCtx.createAnalyser();
      _analyser.fftSize = 256;
      _source    = _audioCtx.createMediaElementSource(_audioEl);
      _source.connect(_analyser);
      _analyser.connect(_audioCtx.destination);
    }
    if (_audioCtx.state === 'suspended') _audioCtx.resume();
    _audioEl.play();
    document.getElementById('audio-play-btn').textContent = 'PAUSE';
    document.getElementById('audio-play-btn').classList.add('playing');
    drawWaveform();
  } else {
    _audioEl.pause();
    document.getElementById('audio-play-btn').textContent = 'PLAY';
    document.getElementById('audio-play-btn').classList.remove('playing');
    cancelAnimationFrame(_rafId);
  }
};

function stopAudio() {
  if (_audioEl) {
    _audioEl.pause();
    _audioEl.src = '';
    _audioEl = null;
  }
  if (_audioCtx) {
    _audioCtx.close();
    _audioCtx  = null;
    _analyser  = null;
    _source    = null;
  }
  cancelAnimationFrame(_rafId);
  const btn = document.getElementById('audio-play-btn');
  if (btn) { btn.textContent = 'PLAY'; btn.classList.remove('playing'); }
  const bar = document.getElementById('audio-progress-bar');
  if (bar) bar.style.width = '0%';
  const time = document.getElementById('audio-time');
  if (time) time.textContent = '0:00';
}

function updateProgress() {
  if (!_audioEl || !_audioEl.duration) return;
  const pct = (_audioEl.currentTime / _audioEl.duration) * 100;
  document.getElementById('audio-progress-bar').style.width = pct + '%';
  const s = Math.floor(_audioEl.currentTime);
  const m = Math.floor(s / 60);
  document.getElementById('audio-time').textContent = `${m}:${String(s % 60).padStart(2, '0')}`;
}

// Click on progress bar to seek
document.addEventListener('DOMContentLoaded', () => {
  const wrap = document.querySelector('.arc-audio-progress-wrap');
  if (wrap) {
    wrap.addEventListener('click', e => {
      if (!_audioEl || !_audioEl.duration) return;
      const rect = wrap.getBoundingClientRect();
      const pct  = (e.clientX - rect.left) / rect.width;
      _audioEl.currentTime = pct * _audioEl.duration;
    });
  }
});

function drawWaveform() {
  if (!_analyser) return;
  const canvas = document.getElementById('audio-canvas');
  if (!canvas) return;
  const ctx    = canvas.getContext('2d');
  const W      = canvas.width;
  const H      = canvas.height;
  const data   = new Uint8Array(_analyser.frequencyBinCount);

  function frame() {
    _rafId = requestAnimationFrame(frame);
    _analyser.getByteFrequencyData(data);

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0a0c0f';
    ctx.fillRect(0, 0, W, H);

    const barCount = data.length;
    const barW     = W / barCount;
    const accent   = '#3a5a7a';
    const accentHi = '#5a9fc5';

    for (let i = 0; i < barCount; i++) {
      const v   = data[i] / 255;
      const h   = v * H;
      const x   = i * barW;
      ctx.fillStyle = v > 0.6 ? accentHi : accent;
      ctx.fillRect(x, H - h, barW - 1, h);
    }
  }
  frame();
}

function resizeCanvas() {
  const canvas = document.getElementById('audio-canvas');
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  canvas.width  = rect.width  || 220;
  canvas.height = rect.height || 160;
}

window.addEventListener('resize', resizeCanvas);

// Drag-to-move the audio panel
(function() {
  const handle = document.getElementById('audio-drag-handle');
  const panel  = document.getElementById('audio-panel');
  if (!handle || !panel) return;

  let dragging = false, startX, startY, startLeft, startTop;

  handle.addEventListener('mousedown', e => {
    if (e.target.closest('.arc-audio-close')) return;
    dragging = true;
    const rect = panel.getBoundingClientRect();
    startX    = e.clientX;
    startY    = e.clientY;
    startLeft = rect.left;
    startTop  = rect.top;
    panel.style.right  = 'auto';
    panel.style.bottom = 'auto';
    panel.style.left   = startLeft + 'px';
    panel.style.top    = startTop  + 'px';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    panel.style.left = (startLeft + e.clientX - startX) + 'px';
    panel.style.top  = (startTop  + e.clientY - startY) + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.userSelect = '';
    resizeCanvas();
  });
})();
