/*
// LastTAB-return — siatka kart (grid)
// - Poziomy/Pionowy/Auto layout, sort index/time, filtr
// - Ikonki bez 3rd-party, cache (chrome://favicon, /favicon.ico), fallback literowy
// - Selekcja (☐/☑) trwała do Odśwież (session)
// - PPM:
//   • szybkie kliknięcie na kaflu = toggle zaznaczenia (☐ ↔ ☑),
//   • przytrzymanie + ruch (>6 px) = DnD (blok zaznaczonych), cel = kafel (bez linii wstawiania),
//   • poza kaflami: blokujemy menu; przytrzymanie + ruch = zaznaczanie obszarem (marquee) – ramka 3px, bez wypełnienia, w całym <main>
//   • Shift+PPM: przepuszcza natywne menu w siatce
// - Twarda granica pinned; pineska 📌 na początku tytułu
// - Grupa przycisków sterowana opcją Pokaż ☐ ↻ 🗑
*/

const DEFAULTS = {
  orientation: 'auto',
  gridCount: 4,
  sort: 'index-asc',
  hidePinned: true,
  showClose: true,
  showMeta: true,
  tileWidth: 200,
  filterText: '',
  tileHeight: 16,
  tilePadding: 5,
  depth: 10,
  ignorePinned: false,
  autoPinSwitcher: true,
  iconSize: 16,
  fullTitle: false,
  accentColor: 'blue'
};

const LIMITS = {
  countMin: 1, countMax: 300,
  tileWMin: 16, tileWMax: 2000,
  tileHMin: 16, tileHMax: 200,
  padMin: 0, padMax: 25,
  depthMin: 0, depthMax: 50
};

// Parametry interakcji PPM / marquee / scroll
const DND_HYSTERESIS_PX = 6;
const MARQUEE_MIN_PX = 4;
const AUTOSCROLL_EDGE_PX = 60;       // szerokość strefy krawędzi (px) dla DnD/ŚPM
const AUTOSCROLL_MAX_SPEED_PPS = 1000; // maks. prędkość przesuwania (px/sekundę)
const INSERT_EDGE_PX = 14;         // odległość od lewej/prawej krawędzi kafla, która aktywuje „między”
const SINGLE_CLEAR_MOVE_PX = 28;   // próg ruchu (px) po którym czyścimy inne zaznaczenia przy pojedynczym DnD

// Autoscroll (ŚPM) — konfiguracja
const AS_HOLD_TOGGLE_MS = 150;   // przytrzymanie bez ruchu -> tryb toggle
const AS_CLICK_TOL_PX    = 20;    // tolerancja ruchu dla „szybkiego kliknięcia”
const AUTOSCROLL_DEAD_PCT = 0.20; // 20% strefy: martwa
const AUTOSCROLL_SAT_PCT  = 0.90; // 90% strefy: pełna prędkość
const AS_SNAP_RATIO      = 1.8;  // ile razy jedna oś > druga, by „snapnąć” do osi
const AS_SNAP_DAMP       = 0.25; // tłumienie słabszej osi przy snapie

// Przywracanie — konfiguracja
const RESTORE_MENU_MAX = 20;     // max pozycji w menu historii
const SWITCHER_URL = chrome.runtime.getURL('switcher.html');

// Kolory grup (Chromium) → HEX
const GROUP_COLORS = {
  grey:   '#5F6368',
  blue:   '#1A73E8',
  red:    '#D93025',
  yellow: '#F9AB00',
  green:  '#1E8E3E',
  pink:   '#E52592',
  purple: '#9334E6',
  cyan:   '#007B83',
  orange: '#E8710A'
};
const GROUP_COLORS_PL = {
  grey: 'Szary', blue: 'Niebieski', red: 'Czerwony', yellow: 'Żółty',
  green: 'Zielony', pink: 'Różowy', purple: 'Fioletowy', cyan: 'Cyjan', orange: 'Pomarańczowy'
};
const GROUP_FRAME_PAD = 4;   // odstęp ramki od skrajnych kafli (px)
const GROUP_CHIP_INSET = 12; // odsunięcie chipa od lewej/prawej krawędzi kafla (px)
// Map kolorów grup (groupId -> HEX) do kolorowania careta — aktualizowana w drawGroupFrames
const groupColorById = new Map();

const els = {
  depth: document.getElementById('depth'),
  ignorePinnedExt: document.getElementById('ignorePinnedExt'),
  autoPin: document.getElementById('autoPin'),
  status: document.getElementById('status'),
  orientation: document.getElementById('orientation'),
  labelCount: document.getElementById('labelCount'),
  count: document.getElementById('count'),
  tileW: document.getElementById('tileW'),
  tileH: document.getElementById('tileH'),
  tilePad: document.getElementById('tilePad'),
  iconSize: document.getElementById('iconSize'),
  sort: document.getElementById('sort'),
  showMeta: document.getElementById('showMeta'),
  fullTitle: document.getElementById('fullTitle'),
  filter: document.getElementById('filter'),
  hidePinned: document.getElementById('hidePinned'),
  showClose: document.getElementById('showClose'),
  refresh: document.getElementById('refresh'),
  restoreMenuBtn: document.getElementById('restoreMenuBtn'),
  restoreMenu: document.getElementById('restoreMenu'),
  deleteSelectedBtn: document.getElementById('deleteSelectedBtn'),
  
  btnGroupNew: document.getElementById('btnGroupNew'),
  btnGroupMove: document.getElementById('btnGroupMove'),
  menuGroupMove: document.getElementById('menuGroupMove'),
  btnGroupProps: document.getElementById('btnGroupProps'),
  btnGroupList: document.getElementById('btnGroupList'),
  menuGroupList: document.getElementById('menuGroupList'),
  
  groupEditDialog: document.getElementById('groupEditDialog'),
  gedTitle: document.getElementById('gedTitle'),
  gedColors: document.getElementById('gedColors'),
  gedCancel: document.getElementById('gedCancel'),
  gedSave: document.getElementById('gedSave'),
  gedActions: document.getElementById('gedActions'),
  actToggle: document.getElementById('actToggle'),
  actHide: document.getElementById('actHide'),
  actUngroup: document.getElementById('actUngroup'),
  actDelete: document.getElementById('actDelete'),

  btnAccentColor: document.getElementById('btnAccentColor'),
  accentDot: document.getElementById('accentDot'),
  menuAccentColor: document.getElementById('menuAccentColor'),

  grid: document.getElementById('grid'),
  info: document.getElementById('info')
};

let state = { ...DEFAULTS };
let lastWinId = null;
let listenersAttached = false;

// Etap 3 (wzmocnienie MRU z kontekstu siatki – nieusypialny):
// lokalne harmonogramy commitów ACTIVE_COMMIT (per okno)
const MRU_COMMIT_DELAY_MS = 300;
let mruListenersAttached = false;
const mruCommitTimers = new Map(); // key=windowId -> timeout

function scheduleActiveCommitFor(winId, tabId, why = 'switcher') {
  try {
    const key = String(winId);
    const t = mruCommitTimers.get(key);
    if (t) clearTimeout(t);
    const timer = setTimeout(() => {
      try {
        chrome.runtime.sendMessage({
          type: 'ACTIVE_COMMIT',
          windowId: winId,
          tabId,
          from: 'switcher',
          why
        });
      } catch {}
    }, MRU_COMMIT_DELAY_MS);
    mruCommitTimers.set(key, timer);
  } catch {}
}
function attachMRUCommitListeners() {
  if (mruListenersAttached) return;
  mruListenersAttached = true;

  chrome.tabs.onActivated.addListener((info) => {
    if (!info || typeof info.windowId !== 'number' || typeof info.tabId !== 'number') return;
    scheduleActiveCommitFor(info.windowId, info.tabId, 'tabs.onActivated');
  });

  // Pierwszy commit po otwarciu siatki (dla bieżącej aktywnej)
  try {
    chrome.windows.getLastFocused({ populate: true }, (win) => {
      if (chrome.runtime.lastError || !win || !win.tabs) return;
      const t = win.tabs.find(t => t.active);
      if (t) scheduleActiveCommitFor(win.id, t.id, 'init');
    });
  } catch {}
}

// Selekcja — session
let selectedIds = new Set();
async function loadSelection() {
  try {
    const { selectedTabIds = [] } = await chrome.storage.session.get('selectedTabIds');
    selectedIds = new Set((selectedTabIds || []).map(Number));
  } catch {}
}
async function saveSelection() {
  try { await chrome.storage.session.set({ selectedTabIds: [...selectedIds] }); } catch {}
}
function clearSelection() {
  selectedIds.clear();
  saveSelection();
  if (selectedGroupIds && selectedGroupIds.size) {
    selectedGroupIds.clear();
    saveGroupSelection();
    try {
      document.querySelectorAll('.group-chip').forEach(ch => {
        ch.classList.remove('selected');
        const b = ch.querySelector('.btn-select');
        if (b) { b.textContent = '☐'; b.setAttribute('aria-pressed','false'); }
      });
      document.querySelectorAll('.group-frame.selected').forEach(fr => fr.classList.remove('selected'));
      document.querySelectorAll('.group-overlayfill').forEach(el => el.remove());
    } catch {}
  }
}

// Selekcja grup — session
let selectedGroupIds = new Set();
async function loadGroupSelection() {
  try {
    const { selectedGroupIds: arr = [] } = await chrome.storage.session.get('selectedGroupIds');
    selectedGroupIds = new Set((arr || []).map(Number));
  } catch {}
}
async function saveGroupSelection() {
  try { await chrome.storage.session.set({ selectedGroupIds: [...selectedGroupIds] }); } catch {}
}

function setGroupSelectionVisualById(gid, on) {
  // 1. Oznacz kafle wewnątrz grupy (KLUCZOWE DLA CSS)
  const tiles = els.grid.querySelectorAll(`.tile[data-group-id="${gid}"]`);
  tiles.forEach(t => t.classList.toggle('in-selected-group', !!on));

  const chips = els.grid.querySelectorAll(`.group-chip[data-group-id="${gid}"]`);
  chips.forEach(chip => {
    chip.classList.toggle('selected', !!on);
    const btn = chip.querySelector('.btn-select');
    if (btn) {
      btn.textContent = on ? '☑' : '☐';
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  });

  const frames = els.grid.querySelectorAll(`.group-frame[data-group-id="${gid}"]`);
  frames.forEach(fr => fr.classList.toggle('selected', !!on));

  // Overlay fill (niebieska poświata) – dodaj/usuń bez pełnego render()
  const overlay = els.grid.querySelector('.group-frames');
  try {
    // usuń stare fill-e tej grupy
    overlay?.querySelectorAll(`.group-overlayfill[data-group-id="${gid}"]`).forEach(el => el.remove());
  } catch {}

  if (on && overlay) {
    frames.forEach(fr => {
      const l = parseFloat(fr.style.left) || 0;
      const t = parseFloat(fr.style.top) || 0;
      const w = parseFloat(fr.style.width) || fr.offsetWidth || 0;
      const h = parseFloat(fr.style.height) || fr.offsetHeight || 0;
      const of = document.createElement('div');
      of.className = 'group-overlayfill';
      of.setAttribute('data-group-id', String(gid));
      of.style.left = l + 'px';
      of.style.top = t + 'px';
      of.style.width = w + 'px';
      of.style.height = h + 'px';
      // wstaw pod ramkę/chipa (przed frame)
      overlay.insertBefore(of, fr);
    });
  }
}

function deselectTilesInsideGroup(gid) {
  const tiles = els.grid.querySelectorAll(`.tile[data-group-id="${gid}"]`);
  let changed = false;
  tiles.forEach(t => {
    const id = Number(t.dataset.id);
    if (selectedIds.has(id)) {
      selectedIds.delete(id);
      setTileSelectionVisualById(id, false);
      changed = true;
    }
  });
  if (changed) saveSelection();
}

function toggleGroupSelectionById(gid, nextState) {
  const on = (typeof nextState === 'boolean') ? nextState : !selectedGroupIds.has(gid);
  if (on) selectedGroupIds.add(gid); else selectedGroupIds.delete(gid);
  saveGroupSelection();
  setGroupSelectionVisualById(gid, on);
  if (on) deselectTilesInsideGroup(gid);
  renderInfoOnly();
  return on;
}

/* === Nowy stan grup: collapsed/hidden (session) + helpery === */
let collapsedGroupIds = new Set();
async function loadCollapsedGroups() {
  try {
    const { collapsedGroupIds: arr = [] } = await chrome.storage.session.get('collapsedGroupIds');
    collapsedGroupIds = new Set((arr || []).map(Number));
  } catch {}
}
async function saveCollapsedGroups() {
  try { await chrome.storage.session.set({ collapsedGroupIds: [...collapsedGroupIds] }); } catch {}
}

let hiddenGroupIds = new Set();
async function loadHiddenGroups() {
  try {
    const { hiddenGroupIds: arr = [] } = await chrome.storage.session.get('hiddenGroupIds');
    hiddenGroupIds = new Set((arr || []).map(Number));
  } catch {}
}
async function saveHiddenGroups() {
  try { await chrome.storage.session.set({ hiddenGroupIds: [...hiddenGroupIds] }); } catch {}
}

// Tabs danej grupy (bez pinned) w bieżącym oknie — do ungroup/delete
async function getGroupTabIdsInCurrentWindow(gid) {
  try {
    const tabs = await chrome.tabs.query({ windowId: lastWinId });
    return tabs.filter(t => t.groupId === gid && !t.pinned).map(t => t.id);
  } catch { return []; }
}

// Toggle collapse (lokalnie + sync z przeglądarką jeśli możliwe)
function toggleGroupCollapsedById(gid, nextState) {
  const on = (typeof nextState === 'boolean') ? nextState : !collapsedGroupIds.has(gid);
  if (on) collapsedGroupIds.add(gid); else collapsedGroupIds.delete(gid);
  saveCollapsedGroups();
  try { chrome.tabGroups.update(gid, { collapsed: on }); } catch {}
  if (on) {
    try { deselectTilesInsideGroup(gid); } catch {}
  }
  render();
}

// Ukryj w siatce (i zsynkuj jako collapsed=true w przeglądarce)
async function hideGroupById(gid) {
  // Ukryj = Zwiń w przeglądarce + Ukryj w siatce
  try { await chrome.tabGroups.update(gid, { collapsed: true }); } catch {}
  hiddenGroupIds.add(gid);
  await saveHiddenGroups();
  render();
}

// (na wszelki wypadek) odkryj grupę — jeśli użyjemy menu ukrytych
async function showGroupById(gid) {
  if (hiddenGroupIds.has(gid)) {
    hiddenGroupIds.delete(gid);
    await saveHiddenGroups();
  }
  render();
}

async function ungroupGroupById(gid) {
  try {
    const ids = await getGroupTabIdsInCurrentWindow(gid);
    if (ids.length) await chrome.tabs.ungroup(ids);
  } catch {}
  render();
}

async function deleteGroupById(gid) {
  try {
    const ids = await getGroupTabIdsInCurrentWindow(gid);
    if (ids.length) await chrome.tabs.remove(ids);
  } catch {}
  render();
}
/* === /Nowy stan grup === */

// Ustawienia CSS
function clamp(v, lo, hi) { v = Number(v); if (!Number.isFinite(v)) return lo; return Math.max(lo, Math.min(hi, v)); }
function saveSettings(partial, showTick = true) {
  state = { ...state, ...partial };
  chrome.storage.sync.set(partial, () => {
    if (showTick && els.status) { els.status.textContent = 'Zapisano'; setTimeout(() => { els.status.textContent = ''; }, 900); }
  });
}
function applyCSSVars() {
  const tw = clamp(els.tileW?.value, LIMITS.tileWMin, LIMITS.tileWMax);
  const th = clamp(els.tileH?.value, LIMITS.tileHMin, LIMITS.tileHMax);
  const tp = clamp(els.tilePad?.value, LIMITS.padMin, LIMITS.padMax);
  document.documentElement.style.setProperty('--tile-min-w', `${tw}px`);
  document.documentElement.style.setProperty('--tile-h', `${th}px`);
  document.documentElement.style.setProperty('--tile-pad', `${tp}px`);
}
function applyAccentCSS(hexColor) {
    if (!hexColor) return;
    // Ustawiamy tylko kolor główny. CSS color-mix zrobi resztę.
    document.documentElement.style.setProperty('--marquee-stroke', hexColor);
}
function applyFavSize(px) { const s = clamp(Number(px) || 16, 16, 128); document.documentElement.style.setProperty('--fav-size', `${s}px`); }
function applyCSSVarsAll() { applyCSSVars(); applyFavSize(els.iconSize?.value); }

function loadSettings(cb) {
  chrome.storage.sync.get(DEFAULTS, async (res) => {
    state = { ...DEFAULTS, ...res };
    if (els.depth) els.depth.value = clamp(state.depth, LIMITS.depthMin, LIMITS.depthMax);
    if (els.ignorePinnedExt) els.ignorePinnedExt.checked = !!state.ignorePinned;
    if (els.autoPin) els.autoPin.checked = !!state.autoPinSwitcher;
    if (els.orientation) els.orientation.value = state.orientation;
    if (els.count) els.count.value = clamp(state.gridCount, LIMITS.countMin, LIMITS.countMax);
    if (els.tileW) els.tileW.value = clamp(state.tileWidth, LIMITS.tileWMin, LIMITS.tileWMax);
    if (els.tileH) els.tileH.value = clamp(state.tileHeight, LIMITS.tileHMin, LIMITS.tileHMax);
    if (els.tilePad) els.tilePad.value = clamp(state.tilePadding, LIMITS.padMin, LIMITS.padMax);
    if (els.iconSize) els.iconSize.value = clamp(state.iconSize, 16, 128);
    const validSort = new Set(['index-asc','index-desc','time-asc','time-desc']);
    if (!validSort.has(state.sort)) { state.sort = 'index-asc'; chrome.storage.sync.set({ sort: state.sort }); }
    if (els.sort) els.sort.value = state.sort;
    if (els.showMeta) els.showMeta.checked = !!state.showMeta;
    if (els.fullTitle) els.fullTitle.checked = !!state.fullTitle;
    if (els.filter) els.filter.value = state.filterText || '';
    if (els.hidePinned) els.hidePinned.checked = !!state.hidePinned;
    if (els.showClose) els.showClose.checked = !!state.showClose;
    if (state.accentColor) {
        const c = state.accentColor;
        const hex = GROUP_COLORS[c] || GROUP_COLORS.blue;
        if (els.accentDot) els.accentDot.style.backgroundColor = hex;
        applyAccentCSS(hex);
    }
    updateCountLabel(); toggleCountAvailability();
    applyCSSVarsAll();
    document.body?.classList.toggle('full-title', !!state.fullTitle);
    await loadSelection();
    await loadGroupSelection();
    await loadCollapsedGroups();
    await loadHiddenGroups();
    cb && cb();
  });
}
/* Info/formatery */
function getHost(url) { try { const h = new URL(url).hostname; return h.replace(/^www\./i, ''); } catch { return ''; } }
function formatAgo(lastAccessed) {
  if (!lastAccessed) return '—';
  const s = Math.floor(Math.max(0, Date.now() - lastAccessed) / 1000);
  if (s < 5) return 'teraz';
  if (s < 60) return `${s} sek temu`;
  const m = Math.floor(s / 60); if (m < 60) return `${m} min temu`;
  const h = Math.floor(m / 60); if (h < 24) return `${h} godz temu`;
  const d = Math.floor(h / 24); if (d === 1) return '1 dzień temu';
  if (d < 30) return `${d} dni temu`;
  const mo = Math.floor(d / 30); if (mo < 12) return `${mo} mies temu`;
  const y = Math.floor(d / 365); return y === 1 ? '1 rok temu' : `${y} lat temu`;
}
function formatInfo(tabs) {
  const pinned = tabs.filter(t => t.pinned).length;
  const normN = tabs.length - pinned;
  const parts = [];
  parts.push(`Okno: ${lastWinId ?? '—'}`);
  parts.push(`Karty: ${tabs.length} (zwykłe ${normN}${pinned ? `, przypięte ${pinned}` : ''})`);
  parts.push(`Układ: ${els.orientation?.value}`);
  if (els.orientation?.value !== 'auto') {
    const what = els.orientation?.value === 'vertical' ? 'kolumn' : 'wierszy';
    parts.push(`Liczba ${what}: ${els.count?.value}`);
  }
  parts.push(`Sort: ${els.sort?.value}`);
  // Policz wszystkie zaznaczone (bezpośrednio + przez grupę)
  let totalSelected = 0;
  const selTileIds = new Set(selectedIds || []);
  
  if (selectedGroupIds && selectedGroupIds.size) {
      for (const t of tabs) {
          if (t.groupId >= 0 && selectedGroupIds.has(t.groupId) && !t.pinned) {
              selTileIds.add(t.id);
          }
      }
  }
  totalSelected = selTileIds.size;

  if (totalSelected) parts.push(`Zaznaczone: ${totalSelected}`);

   
  // Aktualizuj stan przycisku Usuń (z licznikiem)
  const selTiles = selectedIds ? selectedIds.size : 0;
  const selGroups = selectedGroupIds ? selectedGroupIds.size : 0;
  // const total = selTiles + selGroups; // Lub użyj totalSelected zliczającego faktyczne karty
  const total = totalSelected; // Użyjmy zmiennej wyliczonej wyżej w Twoim kodzie

  if (els.deleteSelectedBtn) {
      if (total > 0) {
          els.deleteSelectedBtn.textContent = `Usuń ${total} 🗑`;
          els.deleteSelectedBtn.disabled = false;
          els.deleteSelectedBtn.style.opacity = '1';
      } else {
          els.deleteSelectedBtn.textContent = `Usuń 🗑`;
          els.deleteSelectedBtn.disabled = true;
          els.deleteSelectedBtn.style.opacity = '0.6';
      }
  }

  // Aktualizuj przyciski grupowe
  const hasAny = selTiles > 0 || selGroups > 0;
  const isSingleGroup = selGroups === 1 && selTiles === 0;

  if (els.btnGroupNew) {
      els.btnGroupNew.disabled = !hasAny;
      els.btnGroupNew.style.opacity = hasAny ? '1' : '0.6';
  }
  if (els.btnGroupMove) {
      els.btnGroupMove.disabled = !hasAny;
      els.btnGroupMove.style.opacity = hasAny ? '1' : '0.6';
  }
  if (els.btnGroupProps) {
      els.btnGroupProps.disabled = !isSingleGroup;
      els.btnGroupProps.style.opacity = isSingleGroup ? '1' : '0.6';
  }
  return parts.join(' • ');
}
function renderInfoOnly(allTabs) {
  if (!els.info) return;
  if (allTabs) els.info.textContent = formatInfo(allTabs);
  else chrome.windows.getLastFocused({ populate: true }, (win) => { if (!win?.tabs) return; els.info.textContent = formatInfo(win.tabs); });
}
function updateCountLabel() {
  const o = els.orientation?.value;
  let label = 'Wiersze'; if (o === 'vertical') label = 'Kolumny'; if (o === 'auto') label = 'Automatycznie';
  const lab = document.querySelector('#labelCount .lab'); if (lab) { lab.textContent = label; return; }
  const node = els.labelCount?.firstChild; if (node && node.nodeType === Node.TEXT_NODE) node.nodeValue = label + ': ';
}
function toggleCountAvailability() { const isAuto = els.orientation?.value === 'auto'; if (els.count) els.count.disabled = isAuto; }
function debounce(fn, ms = 120) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function throttle(fn, ms) { let last = 0, timer = null; return (...a) => { const now = Date.now(); const left = ms - (now - last); if (left <= 0) { last = now; fn(...a); } else { clearTimeout(timer); timer = setTimeout(() => { last = Date.now(); fn(...a); }, left); } }; }
function norm(s) { return (s || '').toString().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }
function applyFilter(tabs) { const q = norm(els.filter?.value?.trim()); if (!q) return tabs; return tabs.filter(t => norm(t.title).includes(q) || norm(t.url).includes(q)); }

/* Favicony (lokalne źródła) + cache */
function desiredFaviconCssPx() { const raw = getComputedStyle(document.documentElement).getPropertyValue('--fav-size').trim(); const px = Math.round(parseFloat(raw) || 16); return clamp(px, 16, 128); }
function isHttpUrl(url) { try { const u = new URL(url); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; } }
function originOf(url) { try { return new URL(url).origin; } catch { return ''; } }
function colorFromString(str) { let h = 0; for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0; h = h % 360; return `hsl(${h} 55% 55%)`; }
function makeLetterFavicon(tab) { const host = getHost(tab.url || '') || ''; const letter = host ? host[0].toUpperCase() : '•'; const el = document.createElement('div'); el.className = 'fav is-letter'; el.textContent = letter; el.style.background = colorFromString(host || 'fallback'); return el; }
const faviconCache = new Map(); const faviconPending = new Map(); const faviconSinks = new Map();
function faviconKey(tab) { const s = desiredFaviconCssPx(); const o = isHttpUrl(tab.url || '') ? originOf(tab.url || '') : (tab.url || ''); return `${s}|${o}`; }
function faviconSources(tab) {
  const s = desiredFaviconCssPx(); const url = tab.url || ''; const origin = originOf(url);
  const list = []; if (tab.favIconUrl) list.push(tab.favIconUrl); if (isHttpUrl(url) && origin) list.push(`${origin}/favicon.ico`);
  list.push(`chrome://favicon2/?size=${s}&page_url=${encodeURIComponent(url)}`); list.push(`chrome://favicon/size/${s}@1x/${url}`);
  const seen = new Set(); return list.filter(u => (u && !seen.has(u) && seen.add(u)));
}
function createImgNode(src) { const img = document.createElement('img'); img.className = 'fav'; img.alt = ''; img.decoding = 'async'; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer'; img.src = src; return img; }
function loadOnce(url) { return new Promise((resolve, reject) => { const img = new Image(); img.referrerPolicy = 'no-referrer'; img.onload = () => resolve(url); img.onerror = () => reject(new Error('load fail')); img.src = url; }); }
async function resolveFavicon(tab) { const list = faviconSources(tab); for (const u of list) { try { const src = await loadOnce(u); return { kind: 'img', src }; } catch {} } return { kind: 'letter' }; }
function attachFavicon(tab, wrap) {
  const key = faviconKey(tab); wrap.dataset.key = key;
  let sinks = faviconSinks.get(key); if (!sinks) { sinks = new Set(); faviconSinks.set(key, sinks); } sinks.add(wrap);
  const cached = faviconCache.get(key); wrap.textContent = '';
  if (cached?.kind === 'img') { wrap.appendChild(createImgNode(cached.src)); return; }
  wrap.appendChild(makeLetterFavicon(tab));
  if (!faviconPending.has(key)) {
    const p = resolveFavicon(tab); faviconPending.set(key, p);
    p.then(res => {
      faviconPending.delete(key); faviconCache.set(key, res);
      const set = faviconSinks.get(key); if (!set) return;
      for (const el of [...set]) {
        if (!el.isConnected || el.dataset.key !== key) { set.delete(el); continue; }
        el.textContent = '';
        if (res.kind === 'img') el.appendChild(createImgNode(res.src)); else el.appendChild(makeLetterFavicon(tab));
      }
    }).catch(() => faviconPending.delete(key));
  }
}
function forceFaviconRefresh() { faviconCache.clear(); faviconPending.clear(); faviconSinks.clear(); render(); }

/* Budowa kafla + przyciski */
function setTileSelectionVisualById(id, selected) {
  const tile = els.grid.querySelector(`.tile[data-id="${id}"]`);
  if (!tile) return;
  tile.classList.toggle('selected', !!selected);
  const btn = tile.querySelector('.btn-select');
  if (btn) {
    btn.textContent = selected ? '☑' : '☐';
    btn.setAttribute('aria-pressed', selected ? 'true' : 'false');
  }
}

function makeTile(tab) {
  const d = document.createElement('div');
  const fullTitle = tab.title || tab.url || '(bez tytułu)';
  d.title = fullTitle; d.setAttribute('aria-label', fullTitle);
  d.className = 'tile' + (tab.active ? ' active' : '');
  d.dataset.id = String(tab.id);
  d.dataset.pinned = String(!!tab.pinned);
  d.dataset.groupId = String(typeof tab.groupId === 'number' ? tab.groupId : -1);

  if (selectedIds.has(tab.id)) d.classList.add('selected');

  const favWrap = document.createElement('div'); favWrap.className = 'fav-wrap';
  attachFavicon(tab, favWrap);

  const wrap = document.createElement('div'); wrap.className = 'title-wrap';
  const title = document.createElement('div'); title.className = 'title';
  if (tab.pinned) { const pin = document.createElement('span'); pin.className = 'pin'; pin.textContent = '📌'; title.prepend(pin); }
  title.appendChild(document.createTextNode(tab.title || '(bez tytułu)'));
  wrap.appendChild(title);

  if (els.showMeta?.checked) { const meta = document.createElement('div'); meta.className = 'meta'; meta.textContent = `${getHost(tab.url)} • ${formatAgo(tab.lastAccessed)}`; wrap.appendChild(meta); }
  else d.classList.add('no-meta');

  const btns = document.createElement('div');
  if (els.showClose?.checked) {
    // selekcja ☐/☑
    const selBtn = document.createElement('button');
    selBtn.className = 'btn-icon btn-select';
    selBtn.title = 'Zaznacz/Odznacz kartę';
    const updateSelVisual = () => {
      const on = selectedIds.has(tab.id);
      selBtn.textContent = on ? '☑' : '☐';
      selBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      d.classList.toggle('selected', on);
    };
    selBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (selectedIds.has(tab.id)) {
          selectedIds.delete(tab.id);
      } else {
          // Jeśli kafel należy do zaznaczonej grupy -> odznacz grupę
          const gid = typeof tab.groupId === 'number' ? tab.groupId : -1;
          if (gid >= 0 && selectedGroupIds && selectedGroupIds.has(gid)) {
              selectedGroupIds.delete(gid);
              saveGroupSelection();
              setGroupSelectionVisualById(gid, false);
          }
          selectedIds.add(tab.id);
      }
      updateSelVisual(); saveSelection(); renderInfoOnly();
    });
    updateSelVisual(); btns.appendChild(selBtn);

    // reload ↻
    const reloadBtn = document.createElement('button');
    reloadBtn.className = 'btn-icon'; reloadBtn.textContent = '↻'; reloadBtn.title = 'Odśwież kartę';
    reloadBtn.addEventListener('click', (e) => { e.stopPropagation(); reloadTab(tab, false); });
    btns.appendChild(reloadBtn);

    // usuń 🗑
    const x = document.createElement('button');
    x.className = 'btn-icon'; x.textContent = '🗑'; x.title = 'Usuń kartę';
    x.addEventListener('click', (e) => { e.stopPropagation(); closeTab(tab); });
    btns.appendChild(x);
  } else {
    btns.style.display = 'none';
  }

  d.appendChild(favWrap);
  d.appendChild(wrap);
  d.appendChild(btns);

  // LPM na kaflu:
  // - jeśli kafel reprezentuje zwiniętą grupę → otwórz (uncollapse) grupę,
  // - w przeciwnym razie → aktywuj kartę jak dotychczas.
  d.addEventListener('click', (e) => {
    try {
      const gid = Number(d.dataset.groupId);
      const isCollapsedGroupTile =
        Number.isFinite(gid) && gid >= 0 &&
        collapsedGroupIds && collapsedGroupIds.has(gid);
      if (isCollapsedGroupTile) {
        e.preventDefault(); e.stopPropagation();
        toggleGroupCollapsedById(gid, false); // otwórz grupę
        return;
      }
    } catch {}
    activateTab(tab);
  });
  return d;
}

/* ---- Tab actions ---- */
async function activateTab(tab) {
  try {
    await chrome.tabs.update(tab.id, { active: true });
    if (typeof tab.windowId === 'number') {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
  } catch (err) {
    console.warn('activateTab failed', err);
  }
}
function reloadTab(tab, bypassCache = false) {
  try {
    chrome.tabs.reload(tab.id, { bypassCache: !!bypassCache }, () => {
      if (chrome.runtime.lastError) console.warn('reloadTab', chrome.runtime.lastError);
    });
  } catch (err) {
    console.warn('reloadTab failed', err);
  }
}
function closeTab(tab) {
  try {
    chrome.tabs.remove(tab.id, () => {
      if (chrome.runtime.lastError) console.warn('closeTab', chrome.runtime.lastError);
      selectedIds.delete(tab.id);
      saveSelection();
      renderInfoOnly();
    });
  } catch (err) {
    console.warn('closeTab failed', err);
  }
}

/* Layout */
function setGridLayout(itemsCount) {
  const o = els.orientation?.value;
  const tw = clamp(els.tileW?.value, LIMITS.tileWMin, LIMITS.tileWMax);
  const rowsOrCols = clamp(els.count?.value, LIMITS.countMin, LIMITS.countMax);
  const mainEl = document.querySelector('main');
  
  els.grid.classList.remove('columns');
  els.grid.style.columnCount = '';
  els.grid.style.gridTemplateRows = '';
  els.grid.style.gridTemplateColumns = '';
  els.grid.style.gridAutoFlow = '';

  if (mainEl) {
      mainEl.style.overflowY = '';
      mainEl.style.overflowX = '';
  }

  if (o === 'horizontal') {
    const rows = rowsOrCols;
    const cols = Math.max(1, Math.ceil((itemsCount || 1) / rows));
    document.documentElement.style.setProperty('--grid-mode', 'grid');
    document.documentElement.style.setProperty('--tile-min-w', `${tw}px`);
    els.grid.style.gridAutoFlow = 'row';
    els.grid.style.gridTemplateRows = `repeat(${rows}, minmax(var(--tile-h), auto))`;
    els.grid.style.gridTemplateColumns = `repeat(${cols}, ${tw}px)`;
	if (mainEl) mainEl.style.overflowX = 'scroll';
  } else if (o === 'vertical') {
    document.documentElement.style.setProperty('--grid-mode', 'block');
    document.documentElement.style.setProperty('--tile-min-w', `0px`);
    els.grid.classList.add('columns');
	if (mainEl) mainEl.style.overflowY = 'scroll';
    els.grid.style.columnCount = String(rowsOrCols);
  } else {
    document.documentElement.style.setProperty('--grid-mode', 'grid');
    document.documentElement.style.setProperty('--tile-min-w', `min(100%, ${tw}px)`);
    els.grid.style.gridAutoFlow = 'row';
    els.grid.style.gridTemplateColumns = `repeat(auto-fit, minmax(min(100%, ${tw}px), 1fr))`;
	if (mainEl) mainEl.style.overflowY = 'scroll';
  }
}

/* Nakładki grup – pomocnicze + drawGroupFrames */
function ensureGroupUnderlay() {
  let el = els.grid.querySelector('.group-underlay');
  if (!el) {
    el = document.createElement('div');
    el.className = 'group-underlay';
    els.grid.appendChild(el);
  }
  return el;
}
function ensureGroupOverlay() {
  let el = els.grid.querySelector('.group-frames');
  if (!el) {
    el = document.createElement('div');
    el.className = 'group-frames';
    els.grid.appendChild(el);
  }
  return el;
}
function groupColorHex(name) { return GROUP_COLORS[name] || GROUP_COLORS.grey; }
function getHorizontalGapPx() {
  const cs = getComputedStyle(els.grid);
  let px = 0;
  const cg = cs.getPropertyValue('column-gap').trim();
  if (cg) {
    const n = parseFloat(cg); if (Number.isFinite(n)) px = n;
  } else {
    const gap = cs.getPropertyValue('gap').trim();
    if (gap) {
      const parts = gap.split(/\s+/);
      const v = parts.length > 1 ? parts[1] : parts[0];
      const n = parseFloat(v); if (Number.isFinite(n)) px = n;
    }
  }
  return px || 0;
}
async function drawGroupFrames(visibleTabs) {
  try {
    const ids = Array.from(new Set(
      (visibleTabs || [])
        .map(t => t.groupId)
        .filter(gid => typeof gid === 'number' && gid >= 0)
    ));
    const underlay = ensureGroupUnderlay();
    const overlay = ensureGroupOverlay();
    underlay.textContent = '';
    overlay.textContent = '';
    if (!ids.length) return;

    const gridRect = els.grid.getBoundingClientRect();
    const tiles = Array.from(els.grid.querySelectorAll('.tile'));
    const isColumns = els.grid.classList.contains('columns');
    const gapX = getHorizontalGapPx();
    const ROW_TOL = 8;
    const SEG_GAP_TOL = gapX * 1.4;

    let meta = new Map();
    try {
      const allGroups = await chrome.tabGroups.query({ windowId: lastWinId });
      meta = new Map((allGroups || []).map(g => [g.id, g]));
    } catch {}
    try { groupColorById.clear(); } catch {}

    for (const gid of ids) {
      const rects = [];
      for (const tile of tiles) {
        if (Number(tile.dataset.groupId) !== gid) continue;
        const r = tile.getBoundingClientRect();
        rects.push({
          el: tile,
          l: r.left - gridRect.left,
          t: r.top  - gridRect.top,
          r: r.right - gridRect.left,
          b: r.bottom - gridRect.top,
          w: r.width,
          h: r.height
        });
      }
      if (!rects.length) continue;

      if (isColumns) {
        const L = Math.min(...rects.map(x=>x.l));
        const T = Math.min(...rects.map(x=>x.t));
        const R = Math.max(...rects.map(x=>x.r));
        const B = Math.max(...rects.map(x=>x.b));
        const l = Math.max(0, Math.floor(L) - GROUP_FRAME_PAD);
        const t = Math.max(0, Math.floor(T) - GROUP_FRAME_PAD);
        const w = Math.max(0, Math.ceil(R) + GROUP_FRAME_PAD - l);
        const h = Math.max(0, Math.ceil(B) + GROUP_FRAME_PAD - t);

        const g = meta.get(gid);
        const color = groupColorHex(g?.color);
        try { groupColorById.set(gid, color); } catch {}

        const fill = document.createElement('div');
        fill.className = 'group-underfill';
        fill.style.left = l + 'px';
        fill.style.top = t + 'px';
        fill.style.width = w + 'px';
        fill.style.height = h + 'px';
        fill.style.color = color;
        underlay.appendChild(fill);

        if (selectedGroupIds && selectedGroupIds.has(gid)) {
          const of = document.createElement('div');
          of.className = 'group-overlayfill';
          of.setAttribute('data-group-id', String(gid));
          of.style.left = l + 'px';
          of.style.top = t + 'px';
          of.style.width = w + 'px';
          of.style.height = h + 'px';
          overlay.appendChild(of);
        }

        const frame = document.createElement('div');
        frame.className = 'group-frame';
        frame.style.left = l + 'px';
        frame.style.top = t + 'px';
        frame.style.width = w + 'px';
        frame.style.height = h + 'px';
        frame.style.color = color;
        frame.setAttribute('data-group-id', String(gid));
        if (selectedGroupIds && selectedGroupIds.has(gid)) frame.classList.add('selected');

        const first = rects.slice().sort((a,b)=>a.t-b.t || a.l-b.l)[0];
        const title = (g?.title && g.title.trim()) ? g.title : '(grupa)';
        const showActions = !!els.showClose?.checked;
        const isCollapsed = !!(collapsedGroupIds && collapsedGroupIds.has(gid));

        const chip = document.createElement('div');
        chip.className = 'group-chip';
        chip.setAttribute('data-group-id', String(gid));
        chip.innerHTML =
          `<span class="ico" aria-hidden="true">📁</span><span class="name">${title}</span>` +
          `<span class="actions" ${showActions ? '' : 'style="display:none"'}>` +
            `<button class="btn-icon btn-select" title="Zaznacz/Odznacz grupę">☐</button>` +
            `<button class="btn-icon btn-arrow" title="Zwiń/Rozwiń grupę">${isCollapsed ? '▸' : '▾'}</button>` +
            `<button class="btn-icon" title="Ukryj grupę">👁</button>` +
            `<button class="btn-icon" title="Rozgrupuj (pozostaw karty)">⇱</button>` +
            `<button class="btn-icon" title="Usuń grupę i karty">🗑</button>` +
          `</span>`;
        chip.style.color = color;
        chip.classList.toggle('selected', !!(selectedGroupIds && selectedGroupIds.has(gid)));
        const btnSel = chip.querySelector('.btn-select');
        if (btnSel) {
          const on = !!(selectedGroupIds && selectedGroupIds.has(gid));
          btnSel.textContent = on ? '☑' : '☐';
          btnSel.setAttribute('aria-pressed', on ? 'true' : 'false');
        }

        try {
          const inset = typeof GROUP_CHIP_INSET === 'number' ? GROUP_CHIP_INSET : 12;
          const relLeft = Math.max(0, Math.floor(first.l) - l) + inset;
          const tileW = Math.round(first.w || 0);
          const chipW = Math.max(0, tileW - 2*inset);
          chip.style.left = relLeft + 'px';
          chip.style.width = chipW + 'px';
        } catch {}

        frame.appendChild(chip);
        overlay.appendChild(frame);
        continue;
      }

      // Poziomy/auto: segmenty per wiersz
      rects.sort((a,b)=>a.t-b.t || a.l-b.l);
      const rows = [];
      for (const rc of rects) {
        let bucket = rows.find(row => Math.abs(row.t - rc.t) <= ROW_TOL);
        if (!bucket) { bucket = { t: rc.t, rects: [] }; rows.push(bucket); }
        bucket.t = Math.min(bucket.t, rc.t);
        bucket.rects.push(rc);
      }

      let chipCandidate = null;
      const g = meta.get(gid);
      const color = groupColorHex(g?.color);
      try { groupColorById.set(gid, color); } catch {}

      for (const row of rows) {
        row.rects.sort((a,b)=>a.l-b.l);
        const segments = [];
        let cur = null;
        for (const rc of row.rects) {
          if (!cur) { cur = { l: rc.l, t: rc.t, r: rc.r, b: rc.b, firstW: rc.w }; segments.push(cur); }
          else {
            const gap = rc.l - cur.r;
            if (gap > SEG_GAP_TOL) { cur = { l: rc.l, t: rc.t, r: rc.r, b: rc.b, firstW: rc.w }; segments.push(cur); }
            else { cur.r = Math.max(cur.r, rc.r); cur.b = Math.max(cur.b, rc.b); cur.t = Math.min(cur.t, rc.t); }
          }
        }

        for (const seg of segments) {
          const l = Math.max(0, Math.floor(seg.l) - GROUP_FRAME_PAD);
          const t = Math.max(0, Math.floor(seg.t) - GROUP_FRAME_PAD);
          const w = Math.max(0, Math.ceil(seg.r) + GROUP_FRAME_PAD - l);
          const h = Math.max(0, Math.ceil(seg.b) + GROUP_FRAME_PAD - t);

          const fill = document.createElement('div');
          fill.className = 'group-underfill';
          fill.style.left = l + 'px';
          fill.style.top = t + 'px';
          fill.style.width = w + 'px';
          fill.style.height = h + 'px';
          fill.style.color = color;
          underlay.appendChild(fill);

          if (selectedGroupIds && selectedGroupIds.has(gid)) {
            const of = document.createElement('div');
            of.className = 'group-overlayfill';
            of.setAttribute('data-group-id', String(gid));
            of.style.left = l + 'px';
            of.style.top = t + 'px';
            of.style.width = w + 'px';
            of.style.height = h + 'px';
            overlay.appendChild(of);
          }

          const frame = document.createElement('div');
          frame.className = 'group-frame';
          frame.style.left = l + 'px';
          frame.style.top = t + 'px';
          frame.style.width = w + 'px';
          frame.style.height = h + 'px';
          frame.style.color = color;
          frame.setAttribute('data-group-id', String(gid));
          if (selectedGroupIds && selectedGroupIds.has(gid)) frame.classList.add('selected');

          if (!chipCandidate ||
              seg.t < chipCandidate.t ||
              (Math.abs(seg.t - chipCandidate.t) <= ROW_TOL && seg.l < chipCandidate.l)) {
            const title = (g?.title && g.title.trim()) ? g.title : '(grupa)';
            chipCandidate = { l, t, color, title, tileW: Math.round(seg.firstW || w) };
          }

          overlay.appendChild(frame);
        }
      }

      if (chipCandidate) {
        const chip = document.createElement('div');
        chip.className = 'group-chip';
        chip.setAttribute('data-group-id', String(gid));
        const showActions = !!els.showClose?.checked;
        const isCollapsed = !!(collapsedGroupIds && collapsedGroupIds.has(gid));
        chip.innerHTML =
          `<span class="ico" aria-hidden="true">📁</span><span class="name">${chipCandidate.title}</span>` +
          `<span class="actions" ${showActions ? '' : 'style="display:none"'}>` +
            `<button class="btn-icon btn-select" title="Zaznacz/Odznacz grupę">☐</button>` +
            `<button class="btn-icon btn-arrow" title="Zwiń/Rozwiń grupę">${isCollapsed ? '▸' : '▾'}</button>` +
            `<button class="btn-icon" title="Ukryj grupę">👁</button>` +
            `<button class="btn-icon" title="Rozgrupuj (pozostaw karty)">⇱</button>` +
            `<button class="btn-icon" title="Usuń grupę i karty">🗑</button>` +
          `</span>`;
        chip.style.color = chipCandidate.color;
        chip.classList.toggle('selected', !!(selectedGroupIds && selectedGroupIds.has(gid)));
        const btnSel = chip.querySelector('.btn-select');
        if (btnSel) {
          const on = !!(selectedGroupIds && selectedGroupIds.has(gid));
          btnSel.textContent = on ? '☑' : '☐';
          btnSel.setAttribute('aria-pressed', on ? 'true' : 'false');
        }
        const targetW = Math.max(0, (chipCandidate.tileW || 0) - 2*GROUP_CHIP_INSET);
        chip.style.left = (chipCandidate.l + GROUP_CHIP_INSET) + 'px';
        chip.style.top  = (chipCandidate.t - 10) + 'px';
        if (targetW > 0) chip.style.width = targetW + 'px';
        overlay.appendChild(chip);
      }
    }
  } catch (e) {
    // brak grup lub brak uprawnień – ignoruj
  }
}
/* Render */
function render() {
  chrome.windows.getLastFocused({ populate: true }, (win) => {
    if (chrome.runtime.lastError) return;
    if (!win || !win.tabs) return;
    lastWinId = win.id;

    let tabs = win.tabs.slice();
    if (els.hidePinned?.checked) tabs = tabs.filter(t => !t.pinned);
    switch (els.sort?.value) {
      case 'index-asc':  tabs.sort((a,b)=>a.index-b.index); break;
      case 'index-desc': tabs.sort((a,b)=>b.index-a.index); break;
      case 'time-asc':   tabs.sort((a,b)=>(a.lastAccessed||0)-(b.lastAccessed||0)); break;
      case 'time-desc':  tabs.sort((a,b) => (b.lastAccessed||0)-(a.lastAccessed||0)); break;
      default:           tabs.sort((a,b)=>a.index-b.index);
    }
    tabs = applyFilter(tabs);

    // 1. Odsiej CAŁKOWICIE ukryte grupy (znikanie z siatki)
    if (hiddenGroupIds && hiddenGroupIds.size) {
        tabs = tabs.filter(t => {
            const gid = (typeof t.groupId === 'number') ? t.groupId : -1;
            // Jeśli grupa jest ukryta -> nie pokazuj żadnej jej karty
            return !(gid >= 0 && hiddenGroupIds.has(gid));
        });
    }

    // 2. Collapsed: policz „ukryte” i przepuść tylko pierwszy kafel tej grupy
    let collapsedHiddenCount = new Map();
    if (collapsedGroupIds && collapsedGroupIds.size) {
      const groupCounts = new Map();
      for (const t of tabs) {
        const gid = (typeof t.groupId === 'number') ? t.groupId : -1;
        if (gid >= 0 && collapsedGroupIds.has(gid)) {
          groupCounts.set(gid, 1 + (groupCounts.get(gid) || 0));
        }
      }
      for (const [gid, cnt] of groupCounts) {
        collapsedHiddenCount.set(gid, Math.max(0, (cnt || 0) - 1)); // ukryte = wszystkie poza pierwszym
      }

      const seenCollapsed = new Set();
      const filteredTabs = [];
      for (const t of tabs) {
        const gid = (typeof t.groupId === 'number') ? t.groupId : -1;
        if (gid >= 0 && collapsedGroupIds.has(gid)) {
          if (seenCollapsed.has(gid)) continue;
          seenCollapsed.add(gid);
          filteredTabs.push(t);
        } else {
          filteredTabs.push(t);
        }
      }
      tabs = filteredTabs;
    }

    els.grid.textContent = '';
    setGridLayout(tabs.length);
    for (const t of tabs) {
      const node = makeTile(t);

      // Wirtualny kafel zwiniętej grupy: 📁 + „N kart”, bez meta i bez przycisków
      try {
        const gid = (typeof t.groupId === 'number') ? t.groupId : -1;
        if (gid >= 0 && collapsedGroupIds && collapsedGroupIds.has(gid)) {
          node.classList.add('collapsed-group');

          // Odczep favWrap od favicon-pipeline i wstaw 📁
          const favWrap = node.querySelector('.fav-wrap');
          if (favWrap) {
            const key = favWrap.dataset.key;
            if (key && faviconSinks && faviconSinks.get) {
              const sinks = faviconSinks.get(key);
              if (sinks && sinks.delete) sinks.delete(favWrap);
            }
            try { delete favWrap.dataset.key; } catch {}
            favWrap.textContent = '';
            const folder = document.createElement('div');
            folder.className = 'fav is-letter';
            folder.textContent = '📁';
            folder.style.background = 'transparent';
            favWrap.appendChild(folder);
          }

          // Tytuł „N kart” + brak 2. linii (meta)
          node.classList.add('no-meta');
          const hiddenN = (collapsedHiddenCount && collapsedHiddenCount.get) ? (collapsedHiddenCount.get(gid) || 0) : 0;
          const totalN = hiddenN + 1;
          const titleEl = node.querySelector('.title');
          if (titleEl) {
            titleEl.textContent = `${totalN} kart`;
            node.title = `${totalN} kart`;
            node.setAttribute('aria-label', `${totalN} kart`);
          }

          // Bez przycisków na kaflu (☐/↻/🗑 ukryj)
          const btns = node.lastElementChild;
          if (btns && btns.style) btns.style.display = 'none';
        }
      } catch {}

      els.grid.appendChild(node);

      // seed: szybki stan z tabs.audible/muted (CS dośle precyzyjniejszy 'video')
      const baseKind = t.audible ? ((t.mutedInfo && t.mutedInfo.muted) ? 'muted' : 'audio') : 'none';
      mediaState.set(t.id, { playing: baseKind !== 'none', kind: baseKind, tabMuted: !!(t.mutedInfo && t.mutedInfo.muted) });
      applyMediaToTile(t.id);
    }

    // Jeśli grupa jest zamknięta, sprawdź czy którykolwiek jej (ukryty) element gra
    // i jeśli tak, zapal 'media-active' na widocznym kaflu-liderze.
    if (collapsedGroupIds && collapsedGroupIds.size) {
        const playingGroups = new Set();
        // Musimy sprawdzić WSZYSTKIE karty w oknie, nie tylko te widoczne w tabs (filtrowane)
        // Ale w 'render' zmienna 'tabs' jest już przefiltrowana...
        // Użyjmy 'win.tabs' (oryginalnej listy z renderu).
        if (win && win.tabs) {
            for (const t of win.tabs) {
                if (t.groupId >= 0 && collapsedGroupIds.has(t.groupId)) {
                    const mst = mediaState.get(t.id);
                    if (mst && mst.playing) playingGroups.add(t.groupId);
                }
            }
        }
        for (const gid of playingGroups) {
            const leader = els.grid.querySelector(`.tile[data-group-id="${gid}"]`);
            if (leader) leader.classList.add('media-active');
        }
    }

    // ramki grup nad kaflami (bez blokowania interakcji)
    drawGroupFrames(tabs);

    renderInfoOnly(win.tabs);
  });
}
function attachLiveListeners() {
  if (listenersAttached) return;
  listenersAttached = true;

  const rerender = throttle(() => render(), 80);

  // Systemowe zmiany kart/okien → szybki rerender
  chrome.tabs.onCreated.addListener(rerender);
  chrome.tabs.onRemoved.addListener((_tabId, _info) => { mediaState.delete(_tabId); rerender(); });
  chrome.tabs.onUpdated.addListener((_tabId, _change, _tab) => rerender());
  chrome.tabs.onMoved.addListener((_tabId, _moveInfo) => rerender());
  chrome.tabs.onAttached.addListener((_tabId, _info) => rerender());
  chrome.tabs.onDetached.addListener((_tabId, _info) => rerender());
  chrome.tabs.onActivated.addListener((_info) => rerender());
  chrome.windows.onFocusChanged.addListener(rerender);
  window.addEventListener('resize', rerender);

  const mainEl = document.querySelector('main');

  // Globalna blokada PPM (Shift przepuszcza; pole #filter przepuszcza)
  document.addEventListener('contextmenu', (e) => {
    if (e.shiftKey) return;
    const t = e.target;
    const isFilter = t && (t.id === 'filter' || (t.closest && t.closest('#filter')));
    if (isFilter) return;
    e.preventDefault();
    e.stopPropagation();
    if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
  }, true);

  // PPM: DnD + Marquee
  enablePPMDragAndMarquee(mainEl);

  // LPM w „☐” na chipie: toggle zaznaczenia grupy
  document.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest && e.target.closest('.group-chip .btn-select');
    if (!btn) return;
    e.preventDefault(); e.stopPropagation();
    const chip = btn.closest('.group-chip');
    const gid = Number(chip.getAttribute('data-group-id'));
    if (!Number.isFinite(gid)) return;
    const next = !selectedGroupIds.has(gid);
    toggleGroupSelectionById(gid, next);
  }, true);

  // ▾/▸ — zwiń/rozwiń grupę (klik w strzałkę LUB w tło chipa)
  document.addEventListener('click', (e) => {
    // Jeśli kliknięto w któryś z przycisków:
    const anyBtn = e.target && e.target.closest && e.target.closest('.group-chip .btn-icon');
    const isArrow = anyBtn && anyBtn.classList && anyBtn.classList.contains('btn-arrow');
    const isSelect = anyBtn && anyBtn.classList && anyBtn.classList.contains('btn-select');

    // Klik w ☑ — zostaw dedykowanemu handlerowi selekcji
    if (isSelect) return;

    // Znajdź chipa
    const chip = e.target && e.target.closest && e.target.closest('.group-chip');
    if (!chip) return;

    // Klik w inne przyciski (👁/⇱/🗑) — zostaw ich handlerom
    if (anyBtn && !isArrow) return;

    e.preventDefault(); e.stopPropagation();
    const gid = Number(chip.getAttribute('data-group-id'));
    if (!Number.isFinite(gid)) return;
    toggleGroupCollapsedById(gid);
  }, true);

  // 👁 / ⇱ / 🗑 — akcje chipa (na podstawie tytułu lub symbolu)
  document.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest && e.target.closest('.group-chip .btn-icon');
    if (!btn) return;
    if (btn.classList.contains('btn-select') || btn.classList.contains('btn-arrow')) return; // już obsłużone
    e.preventDefault(); e.stopPropagation();

    const chip = btn.closest('.group-chip');
    const gid = Number(chip.getAttribute('data-group-id'));
    if (!Number.isFinite(gid)) return;

    const sym = (btn.textContent || '').trim();
    const title = (btn.getAttribute('title') || '').trim();

    if (sym === '👁' || /Ukryj grupę/i.test(title)) {
      hideGroupById(gid);
    } else if (sym === '⇱' || /Rozgrupuj/i.test(title)) {
      ungroupGroupById(gid);
    } else if (sym === '🗑' || /Usuń grupę/i.test(title)) {
      deleteGroupById(gid);
    }
  }, true);

  // Tab Groups: sync collapsed z przeglądarką + „odkryj” po uncollapse
  try {
    chrome.tabGroups.onUpdated.addListener((group) => {
      if (!group || typeof group.id !== 'number') return;
      const gid = group.id;
      if (group.collapsed) {
        collapsedGroupIds.add(gid);
        try { deselectTilesInsideGroup(gid); } catch {}
      } else {
        collapsedGroupIds.delete(gid);
      }
      saveCollapsedGroups();
      // włączenie (uncollapse) w przeglądarce → zdejmij z lokalnie ukrytych
      if (group.collapsed === false && hiddenGroupIds && hiddenGroupIds.has(gid)) {
        hiddenGroupIds.delete(gid);
        saveHiddenGroups();
      }
      render();
    });

    // Sync startowy (jeśli znamy okno)
    if (typeof lastWinId === 'number') {
      chrome.tabGroups.query({ windowId: lastWinId }, (groups) => {
        if (!groups) return;
        let dirtyColl = false, dirtyHid = false;
        const present = new Set(groups.map(g => g.id));

        for (const g of groups) {
          if (g.collapsed) {
            if (!collapsedGroupIds.has(g.id)) { collapsedGroupIds.add(g.id); dirtyColl = true; }
          } else {
            if (collapsedGroupIds.delete(g.id)) dirtyColl = true;
            if (hiddenGroupIds && hiddenGroupIds.delete && hiddenGroupIds.delete(g.id)) dirtyHid = true;
          }
        }
        // prune nieistniejących
        for (const gid of [...collapsedGroupIds]) {
          if (!present.has(gid)) { collapsedGroupIds.delete(gid); dirtyColl = true; }
        }
        for (const gid of [...(hiddenGroupIds || [])]) {
          if (!present.has(gid)) { hiddenGroupIds.delete(gid); dirtyHid = true; }
        }
        if (dirtyColl) saveCollapsedGroups();
        if (dirtyHid) saveHiddenGroups();
        if (dirtyColl || dirtyHid) render();
      });
    }
  } catch {}
}
/* Auto-scroll (dla DnD i Marquee) */
const scroller = document.querySelector('main');
let rafScroll = 0, lastPointer = { x: 0, y: 0 }, scrolling = false, autoScrollPrevTs = 0;

function autoScrollLoop() {
  if (!scrolling) return;
  const now = performance.now();
  const dt = Math.min(0.05, Math.max(0, (now - autoScrollPrevTs) / 1000)); // max 50 ms
  autoScrollPrevTs = now;

  const rect = scroller.getBoundingClientRect();

  // oś Y (procent w strefie)
  let vy = 0;
  const distTop = lastPointer.y - rect.top;
  const distBot = rect.bottom - lastPointer.y;
  const nearY = Math.min(distTop, distBot);
  if (nearY < AUTOSCROLL_EDGE_PX) {
    const pen = AUTOSCROLL_EDGE_PX - nearY;
    let p = pen / AUTOSCROLL_EDGE_PX;
    if (p < AUTOSCROLL_DEAD_PCT) p = 0;
    else p = Math.min(1, (p - AUTOSCROLL_DEAD_PCT) / (AUTOSCROLL_SAT_PCT - AUTOSCROLL_DEAD_PCT));
    const dirY = distTop < distBot ? -1 : 1;
    vy = dirY * (AUTOSCROLL_MAX_SPEED_PPS * p);
  }

  // oś X (procent w strefie)
  let vx = 0;
  const distLeft = lastPointer.x - rect.left;
  const distRight = rect.right - lastPointer.x;
  const nearX = Math.min(distLeft, distRight);
  if (nearX < AUTOSCROLL_EDGE_PX) {
    const pen = AUTOSCROLL_EDGE_PX - nearX;
    let p = pen / AUTOSCROLL_EDGE_PX;
    if (p < AUTOSCROLL_DEAD_PCT) p = 0;
    else p = Math.min(1, (p - AUTOSCROLL_DEAD_PCT) / (AUTOSCROLL_SAT_PCT - AUTOSCROLL_DEAD_PCT));
    const dirX = distLeft < distRight ? -1 : 1;
    vx = dirX * (AUTOSCROLL_MAX_SPEED_PPS * p);
  }

  if (vy) scroller.scrollTop  += vy * dt;
  if (vx) scroller.scrollLeft += vx * dt;

  rafScroll = requestAnimationFrame(autoScrollLoop);
}
function startAutoScroll() {
  if (!scrolling) {
    scrolling = true;
    autoScrollPrevTs = performance.now();
    rafScroll = requestAnimationFrame(autoScrollLoop);
  }
}
function stopAutoScroll() {
  scrolling = false;
  if (rafScroll) cancelAnimationFrame(rafScroll);
  rafScroll = 0;
}
/* DnD + Marquee */
function enablePPMDragAndMarquee(mainEl) {
  let drag = null;    // DnD
  let marquee = null; // Marquee
  let baseSelected = null; // snapshot selekcji na start marquee (podgląd live)

  function createGhost(_text, count, colorHex) {
    const g = document.createElement('div');
    g.className = 'drag-ghost';
    g.setAttribute('aria-hidden', 'true');

    const cs = getComputedStyle(document.documentElement);
    const parsePx = (v, def = 0) => {
      const n = parseFloat(String(v || '').toString().replace('px',''));
      return Number.isFinite(n) ? n : def;
    };
    const fav = parsePx(cs.getPropertyValue('--fav-size'), 16);
    const tileH = parsePx(cs.getPropertyValue('--tile-h'), 16);
    const contentSide = Math.max(fav, tileH);

    g.style.width = `${Math.round(contentSide)}px`;
    g.style.height = `${Math.round(contentSide)}px`;
    g.style.padding = `var(--tile-pad)`;

    if (colorHex) {
      g.style.borderColor = colorHex;
      g.style.color = colorHex;
    }

    const cnt = document.createElement('span');
    cnt.className = 'cnt';
    cnt.textContent = String(count || 1);
    cnt.style.fontSize = `${Math.max(10, Math.round(contentSide * 0.5))}px`;
    cnt.style.lineHeight = '1';
    g.textContent = '';
    g.appendChild(cnt);

    document.body.appendChild(g);
    return g;
  }
  function setGhostPos(g, x, y) { g.style.transform = `translate(${x+12}px, ${y+12}px)`; }

  // Overlay i caret „wstawiania między”
  let dndOverlayEl = null, insertCaretEl = null, lastCaret = null;
  function ensureDndOverlay() {
    if (!dndOverlayEl || !dndOverlayEl.isConnected) {
      dndOverlayEl = document.createElement('div');
      dndOverlayEl.className = 'dnd-overlay';
      els.grid.appendChild(dndOverlayEl);
    }
    if (!insertCaretEl || !insertCaretEl.isConnected) {
      insertCaretEl = document.createElement('div');
      insertCaretEl.className = 'insert-caret';
      dndOverlayEl.appendChild(insertCaretEl);
    }
  }
  function showInsertCaretForTile(tile, side) {
    ensureDndOverlay();
    const grid = els.grid;
    const isColumns = grid.classList.contains('columns');
    const cs = getComputedStyle(grid);

    // Pozycje względem siatki (nie viewportu)
    const tLeft = tile.offsetLeft;
    const tTop  = tile.offsetTop;
    const tW    = tile.offsetWidth;
    const tH    = tile.offsetHeight;

    const clampX = (x) => {
      const max = Math.max(0, grid.scrollWidth - 4);
      return Math.max(0, Math.min(max, Math.round(x)));
    };
    const clampY = (y) => {
      const max = Math.max(0, grid.scrollHeight - 4);
      return Math.max(0, Math.min(max, Math.round(y)));
    };

    if (isColumns) {
      let vGapPx = 0;
      const rowGap = cs.getPropertyValue('row-gap').trim();
      if (rowGap) {
        const n = parseFloat(rowGap); if (Number.isFinite(n)) vGapPx = n;
      } else {
        const gap = cs.getPropertyValue('gap').trim();
        if (gap) {
          const parts = gap.split(/\s+/);
          const v = parts[0];
          const n = parseFloat(v); if (Number.isFinite(n)) vGapPx = n;
        }
      }
      const y = (side === 'before' ? (tTop - vGapPx / 2) : (tTop + tH + vGapPx / 2)) - 2;
      insertCaretEl.style.left = tLeft + 'px';
      insertCaretEl.style.top = clampY(y) + 'px';
      insertCaretEl.style.width = tW + 'px';
      insertCaretEl.style.height = '4px';
      insertCaretEl.style.transform = 'none';
    } else {
      let hGapPx = 0;
      const colGap = cs.getPropertyValue('column-gap').trim();
      if (colGap) {
        const n = parseFloat(colGap); if (Number.isFinite(n)) hGapPx = n;
      } else {
        const gap = cs.getPropertyValue('gap').trim();
        if (gap) {
          const parts = gap.split(/\s+/);
          const v = parts.length > 1 ? parts[1] : parts[0];
          const n = parseFloat(v); if (Number.isFinite(n)) hGapPx = n;
        }
      }
      const x = (side === 'before' ? (tLeft - hGapPx / 2) : (tLeft + tW + hGapPx / 2)) - 2;
      insertCaretEl.style.left = clampX(x) + 'px';
      insertCaretEl.style.top = tTop + 'px';
      insertCaretEl.style.width = '4px';
      insertCaretEl.style.height = tH + 'px';
      insertCaretEl.style.transform = 'none';
    }

    lastCaret = { tileId: Number(tile.dataset.id), side };
  }
  function hideInsertCaret() {
    if (insertCaretEl) {
      insertCaretEl.style.transform = 'translate(-9999px,-9999px)';
      insertCaretEl.style.background = '';
    }
    lastCaret = null;
  }

  function clearDragVisual() {
    document.querySelectorAll('.tile.drag-target').forEach(el => el.classList.remove('drag-target'));
  }

  /* Sloty i metryki */
  function __parsePx(val, fallback = 0) {
    const n = parseFloat(String(val || '').toString().replace('px',''));
    return Number.isFinite(n) ? n : fallback;
  }
  function getGridGaps(grid) {
    const cs = getComputedStyle(grid);
    let hGapPx = 0, vGapPx = 0;
    const colGap = cs.getPropertyValue('column-gap').trim();
    if (colGap) hGapPx = __parsePx(colGap, 0);
    else {
      const gap = cs.getPropertyValue('gap').trim();
      if (gap) {
        const parts = gap.split(/\s+/);
        hGapPx = __parsePx(parts.length > 1 ? parts[1] : parts[0], 0);
      }
    }
    const rowGap = cs.getPropertyValue('row-gap').trim();
    if (rowGap) vGapPx = __parsePx(rowGap, 0);
    else {
      const gap = cs.getPropertyValue('gap').trim();
      if (gap) {
        const parts = gap.split(/\s+/);
        vGapPx = __parsePx(parts[0], 0);
      }
    }
    return { hGapPx, vGapPx };
  }
  function pointToGridSpace(clientX, clientY) {
    const grid = els.grid;
    const r = grid.getBoundingClientRect();
    const x = (clientX - r.left) + grid.scrollLeft;
    const y = (clientY - r.top)  + grid.scrollTop;
    return { x, y };
  }
  function getTileRectInGrid(tile) {
    const l = tile.offsetLeft;
    const t = tile.offsetTop;
    const w = tile.offsetWidth;
    const h = tile.offsetHeight;
    return { l, t, r: l + w, b: t + h, w, h };
  }
  function getSlotRectForTile(tile) {
    const grid = els.grid;
    const { hGapPx, vGapPx } = getGridGaps(grid);
    const tr = getTileRectInGrid(tile);
    const clampX = (x) => Math.max(0, Math.min(Math.max(0, grid.scrollWidth), x));
    const clampY = (y) => Math.max(0, Math.min(Math.max(0, grid.scrollHeight), y));
    const l = clampX(tr.l - hGapPx / 2);
    const r = clampX(tr.r + hGapPx / 2);
    const t = clampY(tr.t - vGapPx / 2);
    const b = clampY(tr.b + vGapPx / 2);
    return { l, t, r, b, w: Math.max(0, r - l), h: Math.max(0, b - t), hGapPx, vGapPx };
  }
  function classifyPointerZone(clientX, clientY, tile) {
    const p = pointToGridSpace(clientX, clientY);
    const tr = getTileRectInGrid(tile);
    const sr = getSlotRectForTile(tile);
    const insideTile =
      p.x >= tr.l && p.x <= tr.r &&
      p.y >= tr.t && p.y <= tr.b;
    return {
      zone: insideTile ? 'INSIDE' : 'OUTSIDE',
      point: p,
      tileRect: tr,
      slotRect: sr
    };
  }

  function findNearestAnchorTileAt(px, py, packSet, wantPinned) {
    const tiles = els.grid.querySelectorAll('.tile');
    let bestEl = null, bestDx = Infinity;
    for (const el of tiles) {
      const id = Number(el.dataset.id);
      if (packSet && packSet.has(id)) continue;
      const isPinned = el.dataset.pinned === 'true';
      if ((wantPinned && !isPinned) || (!wantPinned && isPinned)) continue;
      const sr = getSlotRectForTile(el);
      if (py < sr.t || py > sr.b) continue;
      let dx = 0;
      if (px < sr.l) dx = sr.l - px;
      else if (px > sr.r) dx = px - sr.r;
      else dx = 0;
      if (dx < bestDx) { bestDx = dx; bestEl = el; }
    }
    return bestEl;
  }
  function findNearestAnchorTileInColumnAt(px, py, packSet, wantPinned) {
    const tiles = els.grid.querySelectorAll('.tile');
    let bestEl = null, bestDy = Infinity;
    for (const el of tiles) {
      const id = Number(el.dataset.id);
      if (packSet && packSet.has(id)) continue;
      const isPinned = el.dataset.pinned === 'true';
      if ((wantPinned && !isPinned) || (!wantPinned && isPinned)) continue;
      const sr = getSlotRectForTile(el);
      if (px < sr.l || px > sr.r) continue;
      let dy = 0;
      if (py < sr.t) dy = sr.t - py;
      else if (py > sr.b) dy = py - sr.b;
      else dy = 0;
      if (dy < bestDy) { bestDy = dy; bestEl = el; }
    }
    return bestEl;
  }

  function getGroupEdgeIdsFromDOM(gid) {
    const tiles = els.grid.querySelectorAll('.tile');
    const ids = [];
    for (const el of tiles) {
      if (Number(el.dataset.groupId) === gid) ids.push(Number(el.dataset.id));
    }
    return { first: ids.length ? ids[0] : null, last: ids.length ? ids[ids.length - 1] : null };
  }

  function onDndKeyDownEsc(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancelDragEscRestore();
    }
  }
  function cancelDragEscRestore() {
    try { stopAutoScroll(); } catch {}
    try { document.removeEventListener('mousemove', onMouseMove, true); } catch {}
    try { if (drag?._onMoveThrottled) document.removeEventListener('mousemove', drag._onMoveThrottled, true); } catch {}
    try { document.removeEventListener('mouseup', onMouseUp, true); } catch {}
    try { document.removeEventListener('keydown', onDndKeyDownEsc, true); } catch {}

    if (drag?.selectionBackup && !drag?.ctrlAdded) {
      selectedIds = new Set(drag.selectionBackup);
      saveSelection();
      els.grid.querySelectorAll('.tile').forEach(t => {
        const id = Number(t.dataset.id);
        setTileSelectionVisualById(id, selectedIds.has(id));
      });
      renderInfoOnly();
    }

    try { if (drag?.ghost?.parentNode) drag.ghost.parentNode.removeChild(drag.ghost); } catch {}
    clearDragVisual();
    hideInsertCaret();
    drag = null;
  }

  function toggleTileSelectionById(id) {
    if (selectedIds.has(id)) selectedIds.delete(id); else selectedIds.add(id);
    saveSelection();
    setTileSelectionVisualById(id, selectedIds.has(id));
    renderInfoOnly();
  }

  async function preparePack(tile) {
    const id = Number(tile.dataset.id);
    const wasSelected = selectedIds.has(id);
    try { if (drag?.ghost?.parentNode) drag.ghost.parentNode.removeChild(drag.ghost); } catch {}

    const tabs = await chrome.tabs.query({ windowId: lastWinId });
    const byId = new Map(tabs.map(t => [t.id, t]));
    const pos = new Map(tabs.map(t => [t.id, t.index]));

    const idsSet = new Set();
    const gids = new Set();

    if (wasSelected) {
      // 1. Dodaj wszystkie zaznaczone kafle
      for (const tid of selectedIds) idsSet.add(tid);
      drag.deferClear = false;

      // 2. Dodaj kafle z zaznaczonych grup (ważne!)
      if (selectedGroupIds && selectedGroupIds.size) {
        for (const gid of selectedGroupIds) gids.add(gid);
        for (const t of tabs) {
          if (t.groupId >= 0 && gids.has(t.groupId) && !t.pinned) {
            idsSet.add(t.id);
          }
        }
      }
    } else {
      idsSet.add(id);
      drag.deferClear = true;
    }

    let ids = Array.from(idsSet).sort((a,b) => (pos.get(a)||0) - (pos.get(b)||0));

    // Walidacja Pinned (nie mieszamy przypiętych z nieprzypiętymi)
    const pinFlags = ids.map(i => !!byId.get(i)?.pinned);
    const allPinned = pinFlags.every(Boolean), allUnpinned = pinFlags.every(v => !v);
    if (!(allPinned || allUnpinned)) {
      // Reset do pojedynczego elementu w razie konfliktu
      ids = [id];
      gids.clear();
    }

    const first = byId.get(ids[0]);
    const packPinned = !!first?.pinned;
    const title = (first?.title || first?.url || 'karta').toString().slice(0,48);

    const g = createGhost(title, ids.length);
    drag.packIds = ids;
    drag.packPinned = packPinned;
    drag.ghost = g;
    // Przekazujemy gids do drag, aby logika atomów w onMouseUp wiedziała, co jest grupą
    drag.groupIds = Array.from(gids);
    
    // Jeśli mamy jakiekolwiek grupy w paczce, traktuj to jako GroupDrag (atomowy)
    if (gids.size > 0) {
       drag.isGroupDrag = true;
    }

    console.log('[DnD] START Pack:', {
      draggedTileId: id,
      packIds: ids,
      packCount: ids.length,
      explicitGroupIds: drag.groupIds,
      selectedGroupIds: Array.from(selectedGroupIds || []),
      isGroupDrag: drag.isGroupDrag
    });
  }
async function preparePackGroup(groupId) {
  try { if (drag?.ghost?.parentNode) drag.ghost.parentNode.removeChild(drag.ghost); } catch {}

  const tabs = await chrome.tabs.query({ windowId: lastWinId });
  const pos = new Map(tabs.map(t => [t.id, t.index]));
  const byId = new Map(tabs.map(t => [t.id, t]));

  // Grupy do przeniesienia: startowa + (jeśli wybrana/ctrl) pozostałe zaznaczone
  const selGroupsArr = Array.from(selectedGroupIds || []);
  const startInSelection = !!(selectedGroupIds && selectedGroupIds.has(groupId));
  const takeUnionOfGroups = !!(drag && (drag.ctrlStart || startInSelection));
  const groupIdsToDrag = takeUnionOfGroups && selGroupsArr.length ? selGroupsArr : [groupId];

  // Zaznaczone kafle spoza grup → dołącz (bez pinned)
  const selectedTileIds = new Set(selectedIds || []);
  const idsSet = new Set();

  for (const t of tabs) {
    if (t.pinned) continue;
    if (groupIdsToDrag.includes(t.groupId)) { idsSet.add(t.id); continue; }
    if (selectedTileIds.has(t.id)) { idsSet.add(t.id); }
  }

  const ids = Array.from(idsSet).sort((a,b) => (pos.get(a)||0) - (pos.get(b)||0));

  const colorHex = (groupIdsToDrag.length === 1 ? (groupColorById.get(groupId) || '') : '');
  const g = createGhost('', ids.length, colorHex);

  drag.packIds = ids;
  drag.packPinned = false;
  drag.ghost = g;
  drag.deferClear = false; // nie tykaj selekcji przy DnD grupy
  drag.groupIds = groupIdsToDrag.slice();
}

  function findTileAtPoint(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    // Jeśli trafiliśmy w chip grupy — użyj pierwszego kafla tej grupy
    const chip = el.closest && el.closest('.group-chip');
    if (chip) {
      const gid = Number(chip.getAttribute('data-group-id'));
      if (Number.isFinite(gid)) {
        const t = els.grid.querySelector(`.tile[data-group-id="${gid}"]`);
        if (t) return t;
      }
    }
    return el.closest && el.closest('.tile') || null;
  }

  function onMouseDown(e) {
    if (e.button !== 2) return; // tylko PPM
    lastPointer.x = e.clientX; lastPointer.y = e.clientY;

    // DnD grupy z chipa
    const chip = e.target.closest && e.target.closest('.group-chip');
    if (chip) {
      if (!e.shiftKey) { e.preventDefault(); e.stopPropagation(); }
      const gid = Number(chip.getAttribute('data-group-id'));
      if (!Number.isFinite(gid) || gid < 0) return;

      const refTile = els.grid.querySelector(`.tile[data-group-id="${gid}"]`);
      if (!refTile) return;

      drag = {
        startX: e.clientX, startY: e.clientY, started: false,
        ghost: null, packIds: [], packPinned: false,
        targetTile: null, startTile: refTile, dropMode: 'over',
        startId: Number(refTile.dataset.id),
        ctrlStart: !!(e.ctrlKey || e.metaKey),
        startTileSelected: false,
        selectionBackup: new Set(selectedIds),
        ctrlAdded: false,
        startGroupId: gid,
        isGroupDrag: true,
        deferClearGroup: !selectedGroupIds?.has(gid) && !(e.ctrlKey || e.metaKey)
      };
      document.addEventListener('mousemove', onMouseMove, true);
      document.addEventListener('mouseup', onMouseUp, true);
      document.addEventListener('keydown', onDndKeyDownEsc, true);
      return;
    }

    const tile = e.target.closest('.tile');
    if (tile) {
      if (!e.shiftKey) { e.preventDefault(); e.stopPropagation(); }

      const startId = Number(tile.dataset.id);
      const gidTile = Number(tile.dataset.groupId);
      const isCollapsedGroupTile = Number.isFinite(gidTile) && gidTile >= 0 && collapsedGroupIds && collapsedGroupIds.has(gidTile);

      if (isCollapsedGroupTile) {
        // Zwinięty kafel → traktuj jak chip: paczka = cała grupa
        drag = {
          startX: e.clientX, startY: e.clientY, started: false,
          ghost: null, packIds: [], packPinned: false,
          targetTile: null, startTile: tile, dropMode: 'over',
          startId: startId,
          ctrlStart: !!(e.ctrlKey || e.metaKey),
          startTileSelected: false,
          selectionBackup: new Set(selectedIds),
          ctrlAdded: false,
          startGroupId: gidTile,
          isGroupDrag: true,
          deferClearGroup: !(selectedGroupIds && selectedGroupIds.has(gidTile)) && !(e.ctrlKey || e.metaKey)
        };
      } else {
        // Zwykły kafel
        const isAlreadySelected = selectedIds.has(startId);
        const withCtrl = e.ctrlKey || e.metaKey;

        if (!isAlreadySelected && !withCtrl) {
             if (selectedGroupIds) {
                selectedGroupIds.forEach(g => setGroupSelectionVisualById(g, false));
                selectedGroupIds.clear();
             }
             if (selectedIds.size) {
                selectedIds.forEach(id => setTileSelectionVisualById(id, false));
                selectedIds.clear();
             }
             selectedIds.add(startId);
             setTileSelectionVisualById(startId, true);
             saveSelection();
             renderInfoOnly();
        }

        drag = {
          startX: e.clientX, startY: e.clientY, started: false,
          ghost: null, packIds: [], packPinned: false,
          targetTile: null, startTile: tile, dropMode: 'over',
          startId,
          ctrlStart: withCtrl,
          startTileSelected: isAlreadySelected,
          selectionBackup: new Set(selectedIds),
          ctrlAdded: false
        };
      }

      document.addEventListener('mousemove', onMouseMove, true);
      document.addEventListener('mouseup', onMouseUp, true);
      document.addEventListener('keydown', onDndKeyDownEsc, true);
    } else {
      if (e.shiftKey) return; // Shift+PPM: pozwól na natywne menu

      const mr  = scroller.getBoundingClientRect();
      const sbW = scroller.offsetWidth  - scroller.clientWidth;
      const sbH = scroller.offsetHeight - scroller.clientHeight;
      const onRightSB  = sbW > 0 && e.clientX >= (mr.right - sbW)  && e.clientX <= mr.right
                        && e.clientY >= mr.top && e.clientY <= (mr.bottom - (sbH > 0 ? sbH : 0));
      const onBottomSB = sbH > 0 && e.clientY >= (mr.bottom - sbH) && e.clientY <= mr.bottom
                        && e.clientX >= mr.left && e.clientX <= (mr.right - (sbW > 0 ? sbW : 0));
      if (onRightSB || onBottomSB) return;

      e.preventDefault(); e.stopPropagation();
      marqueeStart(e);
    }
  }

  async function onMouseMove(e) {
    lastPointer.x = e.clientX; lastPointer.y = e.clientY;
    if (marquee) { marqueeUpdate(e); return; }
    if (!drag) return;

    const dx = e.clientX - drag.startX, dy = e.clientY - drag.startY;
    const movedDist = Math.hypot(dx, dy);

    if (!drag.started && (Math.abs(dx) + Math.abs(dy) > DND_HYSTERESIS_PX)) {
      drag.started = true;

      if (drag.isGroupDrag && typeof drag.startGroupId === 'number') {
        await preparePackGroup(drag.startGroupId);
      } else {
        await preparePack(drag.startTile);
      }
      startAutoScroll();

      if (drag.ctrlStart && !drag.ctrlAdded) {
        if (drag.isGroupDrag && typeof drag.startGroupId === 'number') {
          drag.ctrlAdded = true;
          drag.deferClear = false;
          await preparePackGroup(drag.startGroupId);
        } else {
          if (!drag.startTileSelected) {
            selectedIds.add(drag.startId);
            saveSelection();
            setTileSelectionVisualById(drag.startId, true);
            renderInfoOnly();
          }
          drag.ctrlAdded = true;
          drag.deferClear = false;
          await preparePack(drag.startTile);
        }
      }
    }
    if (!drag.started) return;

    if (drag.deferClear && !drag.ctrlAdded && movedDist >= SINGLE_CLEAR_MOVE_PX) {
      if (selectedGroupIds && selectedGroupIds.size) {
        const prev = Array.from(selectedGroupIds);
        selectedGroupIds.clear();
        try { saveGroupSelection?.(); } catch {}
        try { prev.forEach(g => setGroupSelectionVisualById(g, false)); } catch {}
      }
      if (selectedIds.size) {
        const packSet = new Set(drag.packIds);
        els.grid.querySelectorAll('.tile.selected').forEach(t => {
          const tid = Number(t.dataset.id);
          if (!packSet.has(tid)) setTileSelectionVisualById(tid, false);
        });
      }
      selectedIds = new Set(drag.packIds);
      saveSelection();
      for (const tid of drag.packIds) setTileSelectionVisualById(tid, true);
      renderInfoOnly();
      drag.deferClear = false;
    }

    if (drag.isGroupDrag && drag.deferClearGroup && !drag.ctrlAdded && movedDist >= SINGLE_CLEAR_MOVE_PX) {
      const gid = Number(drag.startGroupId);
      if (selectedIds && selectedIds.size) {
        const prevTiles = Array.from(selectedIds);
        selectedIds.clear();
        saveSelection();
        try { prevTiles.forEach(tid => setTileSelectionVisualById(tid, false)); } catch {}
      }
      const prevGroups = Array.from(selectedGroupIds || []);
      selectedGroupIds = new Set([gid]);
      try { saveGroupSelection?.(); } catch {}
      try {
        prevGroups.forEach(g => { if (g !== gid) setGroupSelectionVisualById(g, false); });
        setGroupSelectionVisualById(gid, true);
      } catch {}
      renderInfoOnly();
      drag.deferClearGroup = false;
    }

    if (drag.ghost) setGhostPos(drag.ghost, e.clientX, e.clientY);

    const tileAtPoint = findTileAtPoint(e.clientX, e.clientY);
    const inPack = tileAtPoint && drag.packIds.includes(Number(tileAtPoint.dataset.id));
    clearDragVisual();

    const isColumns = els.grid.classList.contains('columns');
    let anchorTile = null;
    let zoneInfo = null;
    let side = 'after';

    if (tileAtPoint && !inPack) {
      const targetPinned = tileAtPoint.dataset.pinned === 'true';
      if ((drag.packPinned && !targetPinned) || (!drag.packPinned && targetPinned)) { drag.targetTile = null; drag.targetZone = null; return; }

      anchorTile = tileAtPoint;
      try { zoneInfo = classifyPointerZone(e.clientX, e.clientY, anchorTile); } catch { zoneInfo = null; }

      if (isColumns) {
        if (zoneInfo && zoneInfo.zone === 'OUTSIDE') {
          const brT = zoneInfo.tileRect.t - zoneInfo.slotRect.vGapPx / 2;
          const brB = zoneInfo.tileRect.b + zoneInfo.slotRect.vGapPx / 2;
          const py  = zoneInfo.point.y;
          side = (Math.abs(py - brT) <= Math.abs(py - brB)) ? 'before' : 'after';
        } else {
          const tr = zoneInfo ? zoneInfo.tileRect : getTileRectInGrid(anchorTile);
          const py = zoneInfo ? zoneInfo.point.y  : pointToGridSpace(e.clientX, e.clientY).y;
          side = (py < (tr.t + tr.b) / 2) ? 'before' : 'after';
        }
      } else {
        if (zoneInfo && zoneInfo.zone === 'OUTSIDE') {
          const brL = zoneInfo.tileRect.l - zoneInfo.slotRect.hGapPx / 2;
          const brR = zoneInfo.tileRect.r + zoneInfo.slotRect.hGapPx / 2;
          const px  = zoneInfo.point.x;
          side = (Math.abs(px - brL) <= Math.abs(px - brR)) ? 'before' : 'after';
        } else {
          const tr = zoneInfo ? zoneInfo.tileRect : getTileRectInGrid(anchorTile);
          const px = zoneInfo ? zoneInfo.point.x  : pointToGridSpace(e.clientX, e.clientY).x;
          side = (px < (tr.l + tr.r) / 2) ? 'before' : 'after';
        }
      }
    } else {
      const selfTile = drag.startTile;
      let selfZone = null;
      try { selfZone = classifyPointerZone(e.clientX, e.clientY, selfTile); } catch { selfZone = null; }

      if (!selfZone || selfZone.zone !== 'OUTSIDE') {
        drag.targetTile = null; drag.targetZone = null; hideInsertCaret(); return;
      }

      const px = selfZone.point.x, py = selfZone.point.y;
      const s = selfZone.slotRect;
      const inSelfSlot = px >= s.l && px <= s.r && py >= s.t && py <= s.b;

      if (inSelfSlot) {
        anchorTile = selfTile;
        zoneInfo = selfZone;

        if (isColumns) {
          const py2 = zoneInfo.point.y;
          const brT = zoneInfo.tileRect.t - zoneInfo.slotRect.vGapPx / 2;
          const brB = zoneInfo.tileRect.b + zoneInfo.slotRect.vGapPx / 2;
          side = (Math.abs(py2 - brT) <= Math.abs(py2 - brB)) ? 'before' : 'after';
        } else {
          const px2 = zoneInfo.point.x;
          const brL = zoneInfo.tileRect.l - zoneInfo.slotRect.hGapPx / 2;
          const brR = zoneInfo.tileRect.r + zoneInfo.slotRect.hGapPx / 2;
          side = (Math.abs(px2 - brL) <= Math.abs(px2 - brR)) ? 'before' : 'after';
        }
      } else {
        const packSet = new Set(drag.packIds);
        const nearest = isColumns
          ? findNearestAnchorTileInColumnAt(px, py, packSet, !!drag.packPinned)
          : findNearestAnchorTileAt(px, py, packSet, !!drag.packPinned);
        if (!nearest) { drag.targetTile = null; drag.targetZone = null; hideInsertCaret(); return; }

        anchorTile = nearest;
        try { zoneInfo = classifyPointerZone(e.clientX, e.clientY, anchorTile); } catch { zoneInfo = null; }

        if (isColumns) {
          if (zoneInfo && zoneInfo.zone === 'OUTSIDE') {
            const brT = zoneInfo.tileRect.t - zoneInfo.slotRect.vGapPx / 2;
            const brB = zoneInfo.tileRect.b + zoneInfo.slotRect.vGapPx / 2;
            const py2 = zoneInfo.point.y;
            side = (Math.abs(py2 - brT) <= Math.abs(py2 - brB)) ? 'before' : 'after';
          } else {
            const tr = zoneInfo ? zoneInfo.tileRect : getTileRectInGrid(anchorTile);
            const py2 = zoneInfo ? zoneInfo.point.y  : pointToGridSpace(e.clientX, e.clientY).y;
            side = (py2 < (tr.t + tr.b) / 2) ? 'before' : 'after';
          }
        } else {
          if (zoneInfo && zoneInfo.zone === 'OUTSIDE') {
            const brL = zoneInfo.tileRect.l - zoneInfo.slotRect.hGapPx / 2;
            const brR = zoneInfo.tileRect.r + zoneInfo.slotRect.hGapPx / 2;
            const px2 = zoneInfo.point.x;
            side = (Math.abs(px2 - brL) <= Math.abs(px2 - brR)) ? 'before' : 'after';
          } else {
            const tr = zoneInfo ? zoneInfo.tileRect : getTileRectInGrid(anchorTile);
            const px2 = zoneInfo ? zoneInfo.point.x  : pointToGridSpace(e.clientX, e.clientY).x;
            side = (px2 < (tr.l + tr.r) / 2) ? 'before' : 'after';
          }
        }
      }
    }

    // Kolor careta na podstawie grupy (JOIN) lub domyślny (UNGROUP)
    // Logika sfer:
    // - Skrajny kafel grupy + strefa OUTSIDE (od strony zewnętrznej) = UNGROUP (neutralny)
    // - Kafel wewnątrz grupy / INSIDE = JOIN (kolor grupy)
    // - Zamknięta grupa: OUTSIDE = KEEP (neutralny), INSIDE = JOIN (kolor)
    // Kolor careta i Ducha na podstawie grupy (JOIN)
    try {
      let caretHex = '';
      if (anchorTile) {
        const gid = Number(anchorTile.dataset.groupId);
        if (gid >= 0) {
          const isCollapsed = collapsedGroupIds && collapsedGroupIds.has(gid);
          let isJoin = false;

          if (isCollapsed) {
            // Zamknięta: OUTSIDE = wyjście, INSIDE = wejście
            if (zoneInfo && zoneInfo.zone === 'OUTSIDE') isJoin = false;
            else isJoin = true;
          } else {
            // Otwarta: krawędzie OUTSIDE = wyjście
            const anchorId = Number(anchorTile.dataset.id);
            const edges = getGroupEdgeIdsFromDOM(gid);
            const outside = !!(zoneInfo && zoneInfo.zone === 'OUTSIDE');
            const isOuterEdge = outside && ((side === 'before' && edges.first === anchorId) || (side === 'after'  && edges.last  === anchorId));
            isJoin = !isOuterEdge;
          }
          
          // Zapobiegaj "JOIN" do własnej grupy (jeśli ciągniemy tę grupę)
          const isSelfDrag = drag && drag.groupIds && drag.groupIds.includes(gid);
          if (isSelfDrag) isJoin = false;

          if (isJoin) caretHex = groupColorById.get(gid) || '';
        }
      }
      
      if (insertCaretEl) insertCaretEl.style.background = caretHex || '';

      // Aktualizacja Ducha: "+N" i kolor, jeśli JOIN
      if (drag.ghost) {
          const cntEl = drag.ghost.querySelector('.cnt');
          const baseCount = drag.packIds.length;
          if (caretHex) {
              drag.ghost.style.borderColor = caretHex;
              drag.ghost.style.color = caretHex;
              if (cntEl) cntEl.textContent = `+${baseCount}`;
          } else {
              // Reset do domyślnego stylu
              drag.ghost.style.borderColor = ''; // css default
              drag.ghost.style.color = '';       // css default
              if (cntEl) cntEl.textContent = String(baseCount);
          }
      }

    } catch {}

    showInsertCaretForTile(anchorTile, side);
    drag.targetTile = anchorTile;
    drag.targetZone = zoneInfo;
  }

  async function onMouseUp(e) {
    document.removeEventListener('mousemove', onMouseMove, true);
    try { if (drag?._onMoveThrottled) document.removeEventListener('mousemove', drag._onMoveThrottled, true); } catch {}
    document.removeEventListener('mouseup', onMouseUp, true);
    document.removeEventListener('keydown', onDndKeyDownEsc, true);
    stopAutoScroll();

    if (marquee) { marqueeEnd(e); return; }
    if (!drag) return;

    const tile = drag.startTile;
    const movedEnough = drag.started;
    const targetTile = drag.targetTile;

    // Szybki klik (bez przeciągania)
    if (!movedEnough) {
      if (drag.isGroupDrag && typeof drag.startGroupId === 'number') {
        const gid = drag.startGroupId;
        const withCtrl = !!(e.ctrlKey || e.metaKey);

        if (withCtrl) {
          toggleGroupSelectionById(gid, !selectedGroupIds.has(gid));
        } else {
          const wasSoloGroup = (selectedGroupIds && selectedGroupIds.size === 1 && selectedGroupIds.has(gid));
          if (selectedIds && selectedIds.size) {
            selectedIds.clear();
            saveSelection();
            els.grid.querySelectorAll('.tile').forEach(t => {
              const tid = Number(t.dataset.id);
              setTileSelectionVisualById(tid, false);
            });
          }

          if (wasSoloGroup) {
            selectedGroupIds.delete(gid);
            saveGroupSelection();
            setGroupSelectionVisualById(gid, false);
            try {
              els.grid.querySelectorAll(`.group-overlayfill[data-group-id="${gid}"]`).forEach(el => el.remove());
            } catch {}
          } else {
            const prev = Array.from(selectedGroupIds);
            selectedGroupIds.clear();
            selectedGroupIds.add(gid);
            saveGroupSelection();
            prev.forEach(other => { if (other !== gid) setGroupSelectionVisualById(other, false); });
            setGroupSelectionVisualById(gid, true);
          }
          renderInfoOnly();
        }

        try { if (drag?.ghost?.parentNode) drag.ghost.parentNode.removeChild(drag.ghost); } catch {}
        hideInsertCaret();
        drag = null;
        return;
      }

      // Szybki PPM na kaflu: Ctrl = toggle; bez Ctrl = tylko ten kafel (czyść zaznaczenia grup)
      // Klik w Kafel
      const id = Number(tile?.dataset?.id);
      const withCtrl = !!(e.ctrlKey || e.metaKey);

      if (withCtrl) {
        if (selectedIds.has(id)) {
            selectedIds.delete(id);
        } else {
            // Jeśli kafel w zaznaczonej grupie -> odznacz grupę
            const tEl = els.grid.querySelector(`.tile[data-id="${id}"]`);
            const gid = tEl ? Number(tEl.dataset.groupId) : -1;
            if (gid >= 0 && selectedGroupIds && selectedGroupIds.has(gid)) {
                selectedGroupIds.delete(gid);
                saveGroupSelection();
                setGroupSelectionVisualById(gid, false);
            }
            selectedIds.add(id);
        }
        saveSelection();
      } else {
        if (selectedGroupIds && selectedGroupIds.size) {
          selectedGroupIds.clear();
          saveGroupSelection();
          try {
            els.grid.querySelectorAll('.group-chip.selected').forEach(ch => ch.classList.remove('selected'));
            els.grid.querySelectorAll('.group-frame.selected').forEach(fr => fr.classList.remove('selected'));
            els.grid.querySelectorAll('.group-overlayfill').forEach(el => el.remove());
            els.grid.querySelectorAll('.group-chip .btn-select[aria-pressed="true"]').forEach(b => { b.textContent = '☐'; b.setAttribute('aria-pressed','false'); });
          } catch {}
        }
        if (selectedIds.size === 1 && selectedIds.has(id)) {
          if (drag.startTileSelected) {
             selectedIds.clear();
          }
        } else {
          selectedIds = new Set([id]);
        }
        saveSelection();
      }

      els.grid.querySelectorAll('.tile').forEach(t => {
        const tid = Number(t.dataset.id);
        setTileSelectionVisualById(tid, selectedIds.has(tid));
      });
      renderInfoOnly();

      try { if (drag?.ghost?.parentNode) drag.ghost.parentNode.removeChild(drag.ghost); } catch {}
      hideInsertCaret();
      drag = null;
      return;
    }

    // DnD – przeniesienie bloku
    if (!(drag.packIds && drag.packIds.length)) {
      if (drag.ghost?.parentNode) drag.ghost.parentNode.removeChild(drag.ghost);
      clearDragVisual(); hideInsertCaret(); drag = null; return;
    }

    try {
      const allTabs = await chrome.tabs.query({ windowId: lastWinId });
      const orderTabs = allTabs.slice().sort((a,b)=>a.index-b.index);
      const order = orderTabs.map(t=>t.id);
      const pos = new Map(order.map((id,i)=>[id,i]));

      const pack = Array.isArray(drag.packIds) ? [...drag.packIds] : [];
      if (!pack.length) {
        if (drag.ghost?.parentNode) drag.ghost.parentNode.removeChild(drag.ghost);
        clearDragVisual(); hideInsertCaret(); drag = null; return;
      }
      pack.sort((a,b)=> (pos.get(a)||0) - (pos.get(b)||0));
      const setPack = new Set(pack);

      let anchorTileId = null, side = 'after';
      if (lastCaret && typeof lastCaret.tileId === 'number') {
        anchorTileId = lastCaret.tileId;
        side = (lastCaret.side === 'before') ? 'before' : 'after';
      } else if (targetTile) {
        anchorTileId = Number(targetTile.dataset.id);
        const isColumns = els.grid.classList.contains('columns');
        if (isColumns) {
          try {
            const z = classifyPointerZone(e.clientX, e.clientY, targetTile);
            if (z && z.zone === 'OUTSIDE') {
              const brT = z.tileRect.t - z.slotRect.vGapPx / 2;
              const brB = z.tileRect.b + z.slotRect.vGapPx / 2;
              const py  = z.point.y;
              side = (Math.abs(py - brT) <= Math.abs(py - brB)) ? 'before' : 'after';
            } else {
              const tr = z ? z.tileRect : getTileRectInGrid(targetTile);
              const py = z ? z.point.y  : pointToGridSpace(e.clientX, e.clientY).y;
              side = (py < (tr.t + tr.b) / 2) ? 'before' : 'after';
            }
          } catch {
            const r = targetTile.getBoundingClientRect();
            side = (e.clientY < (r.top + r.height / 2)) ? 'before' : 'after';
          }
        } else {
          try {
            const z = classifyPointerZone(e.clientX, e.clientY, targetTile);
            if (z && z.zone === 'OUTSIDE') {
              const brL = z.tileRect.l - z.slotRect.hGapPx / 2;
              const brR = z.tileRect.r + z.slotRect.hGapPx / 2;
              const px  = z.point.x;
              side = (Math.abs(px - brL) <= Math.abs(px - brR)) ? 'before' : 'after';
            } else {
              const tr = z ? z.tileRect : getTileRectInGrid(targetTile);
              const px = z ? z.point.x  : pointToGridSpace(e.clientX, e.clientY).x;
              side = (px < (tr.l + tr.r) / 2) ? 'before' : 'after';
            }
          } catch {
            const r = targetTile.getBoundingClientRect();
            side = (e.clientX < (r.left + r.width/2)) ? 'before' : 'after';
          }
        }

        // Override dla zamkniętej grupy: decyduj wyłącznie po środku kafla (pewne i przewidywalne)
        try {
          const gidTarget = Number(targetTile?.dataset?.groupId);
          const isCollapsedTarget = Number.isFinite(gidTarget) && gidTarget >= 0 && collapsedGroupIds && collapsedGroupIds.has(gidTarget);
          if (isCollapsedTarget) {
            const r = targetTile.getBoundingClientRect();
            if (isColumns) {
              side = (e.clientY < (r.top + r.height / 2)) ? 'before' : 'after';
            } else {
              side = (e.clientX < (r.left + r.width / 2)) ? 'before' : 'after';
            }
          }
        } catch {}
      } else {
        if (drag.ghost?.parentNode) drag.ghost.parentNode.removeChild(drag.ghost);
        clearDragVisual(); hideInsertCaret(); drag = null; return;
      }

      const packPositions = pack.map(id => pos.get(id) || 0).sort((a,b)=>a-b);
      const firstIdx = packPositions[0];
      const lastIdx  = packPositions[packPositions.length - 1];
      const leftNeighbor  = firstIdx > 0 ? order[firstIdx - 1] : null;
      const rightNeighbor = lastIdx < order.length - 1 ? order[lastIdx + 1] : null;

      const orderWithout = order.filter(id => !setPack.has(id));

      let insertAt = 0;
      if (setPack.has(anchorTileId)) {
        if (side === 'before') {
          if (leftNeighbor != null) {
            const idx = orderWithout.indexOf(leftNeighbor);
            insertAt = Math.max(0, idx + 1);
          } else {
            insertAt = 0;
          }
        } else {
          if (rightNeighbor != null) {
            const idx = orderWithout.indexOf(rightNeighbor);
            insertAt = Math.max(0, idx);
          } else {
            insertAt = orderWithout.length;
          }
        }
      } else {
        let anchorIdx = orderWithout.indexOf(anchorTileId);
        if (anchorIdx < 0) anchorIdx = 0;
        insertAt = clamp(anchorIdx + (side === 'after' ? 1 : 0), 0, orderWithout.length);
      }

      const packMinPos = firstIdx;
      let movingRight = insertAt > packMinPos;

      console.log('[DnD] TARGET CALC:', {
        anchorTileId,
        side,
        computedInsertAt: insertAt,
        movingRight,
        packMinPos
      });

      const byId = new Map(orderTabs.map(t => [t.id, t]));
      const packPinned   = !!byId.get(pack[0])?.pinned;
      const anchorPinned = !!byId.get(anchorTileId)?.pinned;
      if ((packPinned && !anchorPinned) || (!packPinned && anchorPinned)) {
        if (drag.ghost?.parentNode) drag.ghost.parentNode.removeChild(drag.ghost);
        clearDragVisual(); hideInsertCaret(); drag = null; return;
      }

      // Decyzja grupowa (JOIN/KEEP/UNGROUP) — INSIDE grupy = JOIN; OUTSIDE = KEEP/UNGROUP
      let groupOp = { mode: 'none', groupId: -1 };
      const isGroupDrag = !!(drag && drag.isGroupDrag);

      if (!packPinned) {
        const anchorTab = byId.get(anchorTileId);
        const anchorGid = (anchorTab && typeof anchorTab.groupId === 'number') ? anchorTab.groupId : -1;

        if (anchorGid >= 0) {
          const grpMembers = orderTabs.filter(t => t.groupId === anchorGid);
          const firstId = grpMembers.length ? grpMembers[0].id : null;
          const lastId  = grpMembers.length ? grpMembers[grpMembers.length - 1].id : null;

          let zoneInfo = null;
          try {
            const anchorEl = els.grid.querySelector(`.tile[data-id="${anchorTileId}"]`);
            if (anchorEl) zoneInfo = classifyPointerZone(e.clientX, e.clientY, anchorEl);
          } catch {}

          const isCollapsedTarget = !!(collapsedGroupIds && collapsedGroupIds.has(anchorGid));
          
          if (isCollapsedTarget) {
            // ZAMKNIĘTA GRUPA
            // Sprawdź sferę: OUTSIDE = omiń grupę (KEEP/UNGROUP), INSIDE = wejdź do grupy (JOIN)
            const isOutsideZone = !!(zoneInfo && zoneInfo.zone === 'OUTSIDE');

            if (isOutsideZone) {
              // Sfera zewnętrzna: nie wchodź do grupy.
              groupOp = isGroupDrag ? { mode: 'keep', groupId: -1 } : { mode: 'ungroup_if_grouped', groupId: -1 };

              // KOREKTA POZYCJI DLA RUCHU W PRAWO ("after"):
              // AnchorTile to tylko PIERWSZA karta grupy. Jeśli insertAt = anchor + 1, trafimy do środka grupy.
              // Musimy przeskoczyć całą grupę (ustawić się za ostatnią kartą tej grupy).
              if (side === 'after') {
                const anchorGroupIds = orderWithout.filter(id => (byId.get(id)?.groupId === anchorGid));
                const lastGroupMember = anchorGroupIds.length ? anchorGroupIds[anchorGroupIds.length - 1] : null;
                if (lastGroupMember) {
                  const idxLast = orderWithout.indexOf(lastGroupMember);
                  insertAt = Math.max(0, idxLast + 1);
                }
              }
            } else {
              // Wnętrze (ikona): JOIN do środka (chyba że to ta sama grupa).
              const isSelfDrag = drag && drag.groupIds && drag.groupIds.includes(anchorGid);
              if (isSelfDrag) {
                 groupOp = { mode: 'keep', groupId: -1 };
              } else {
                 groupOp = { mode: 'join', groupId: anchorGid };
              }
              
              // Ustal pozycję wewnątrz grupy (na początek lub koniec) zależnie od połowy, w którą celowano
              const anchorGroupIds = orderWithout.filter(id => (byId.get(id)?.groupId === anchorGid));
              const firstGroupId = anchorGroupIds.length ? anchorGroupIds[0] : null;
              const lastGroupId2 = anchorGroupIds.length ? anchorGroupIds[anchorGroupIds.length - 1] : null;

              if (side === 'before' && firstGroupId != null) {
                const idxBeg = orderWithout.indexOf(firstGroupId);
                insertAt = Math.max(0, idxBeg);
              } else if (lastGroupId2 != null) {
                const idxEnd = orderWithout.indexOf(lastGroupId2);
                insertAt = Math.max(0, idxEnd + 1);
              } else {
                // fallback
                let anchorIdx = orderWithout.indexOf(anchorTileId);
                if (anchorIdx < 0) anchorIdx = 0;
                insertAt = Math.max(0, anchorIdx + (side === 'before' ? 0 : 1));
              }
              // Ważne: aktualizuj flagę kierunku dla precyzyjnego wstawiania wewnątrz
              movingRight = insertAt > packMinPos;
            }
          } else {
            // OTWARTA GRUPA
            // INSIDE = JOIN; OUTSIDE na krawędziach = WYJŚCIE
            const isOutsideEdge =
              !!(zoneInfo && zoneInfo.zone === 'OUTSIDE' &&
                ((side === 'before' && anchorTileId === firstId) || (side === 'after' && anchorTileId === lastId)));

            if (isOutsideEdge) {
              groupOp = isGroupDrag ? { mode: 'keep', groupId: -1 } : { mode: 'ungroup', groupId: -1 };
            } else {
              // Sprawdź czy nie próbujemy wejść do grupy, którą sami ciągniemy
              const isSelfDrag = drag && drag.groupIds && drag.groupIds.includes(anchorGid);
              if (isSelfDrag) {
                 groupOp = { mode: 'keep', groupId: -1 };
              } else {
                 groupOp = { mode: 'join', groupId: anchorGid };
              }
            }
          }
        } else {
          // Kotwica poza grupami → bez łączenia
          groupOp = isGroupDrag ? { mode: 'keep', groupId: -1 } : { mode: 'ungroup_if_grouped', groupId: -1 };
        }
      }

      // Safety: JOIN wg miejsca dropu (INSIDE=JOIN, OUTSIDE=KEEP) — brak dodatkowych ograniczeń

      // Ruch
      if (drag && drag.isGroupDrag) {
        // Zbuduj atomy: grupy (pełne składy, bez pinned) i pojedyncze kafle
        const groupIdsAllowed = new Set(Array.isArray(drag?.groupIds) ? drag.groupIds : []);
        
        // BEZPIECZNIK: Jeśli mamy zaznaczone grupy w globalnym stanie, DODAJ JE TU.
        if (selectedGroupIds) selectedGroupIds.forEach(g => groupIdsAllowed.add(g));

        const setPackIds = new Set(pack);
        const groupFull = (gid) => {
          const ids = orderTabs.filter(t => t.groupId === gid && !t.pinned).map(t => t.id);
          return ids.length && ids.every(id => setPackIds.has(id));
        };
        
        // Uznaj za atom grupy, jeśli:
        // 1. Jest w drag.groupIds (TO JEST KLUCZOWE I PEWNE),
        // 2. Jest w selectedGroupIds (dodatkowe zabezpieczenie),
        // 3. Jest zwinięta (collapsed),
        // 4. Wszystkie jej karty są w paczce (groupFull) - to łapie też grupy niezaznaczone jawnie, ale w całości wzięte.
        const shouldBeGroupAtom = (gid) => {
             if (gid < 0) return false;
             // Jawnie sprawdź drag.groupIds, bo groupIdsAllowed mogło ucierpieć przy konwersji setów
             const explicitInDrag = drag.groupIds && drag.groupIds.includes(gid);
             if (explicitInDrag) return true;
             
             if (groupIdsAllowed.has(gid)) return true;
             if (collapsedGroupIds && collapsedGroupIds.has(gid)) return true;
             if (groupFull(gid)) return true;
             return false;
        };

        const packSorted = pack.slice().sort((a,b)=> (pos.get(a)||0) - (pos.get(b)||0));
        const byGroupSeen = new Set();
        const items = []; // {kind:'group', ids:[...]} | {kind:'tab', ids:[id]}

        console.log('[DnD] DEBUG ATOMS LOOP:', { groupIdsAllowed: Array.from(groupIdsAllowed) });

        for (const id of packSorted) {
          const t = byId.get(id);
          const gid = (t && typeof t.groupId === 'number') ? t.groupId : -1;
          const isGroup = shouldBeGroupAtom(gid);
          
          // console.log(`ID: ${id}, GID: ${gid}, shouldBeGroup: ${isGroup}`); // Okomentuj jeśli za dużo spamu

          if (isGroup) {
            if (byGroupSeen.has(gid)) continue;
            const fullIds = orderTabs
              .filter(tt => tt.groupId === gid && !tt.pinned)
              .sort((a,b)=> (pos.get(a.id)||0) - (pos.get(b.id)||0))
              .map(tt => tt.id);
            items.push({ kind: 'group', gid, ids: fullIds });
            byGroupSeen.add(gid);
          } else {
            items.push({ kind: 'tab', ids: [id] });
          }
        }

        console.log('[DnD] ATOMS BUILT:', items.map(i => `${i.kind} (len:${i.ids?.length}, gid:${i.gid})`));
        console.log('[DnD] DECISION groupOp:', groupOp);

        const moveTabAt = async (id, index) => { await chrome.tabs.move(Number(id), { index }); };
        const moveGroupAt = async (gid, index) => { await chrome.tabGroups.move(Number(gid), { index }); };

        // Pojedyncza grupa + KEEP: przenieś atomowo
        let usedAtomicGroupMove = false;
        try {
          if (groupOp && groupOp.mode !== 'join') {
            const onlyGroupAtom = (items.length === 1 && items[0]?.kind === 'group' && typeof items[0]?.gid === 'number');
            if (onlyGroupAtom) {
              await moveGroupAt(Number(items[0].gid), insertAt);
              usedAtomicGroupMove = true;
            }
          }
        } catch {}

        if (!usedAtomicGroupMove) {
          // Logika precyzyjna dla atomów (Grupa/Tab) - obliczamy offsety z góry
          
          // 1. Oblicz offset (przesunięcie) dla każdego atomu w paczce
          let currentOffset = 0;
          for (const it of items) {
            it._targetOffset = currentOffset;
            currentOffset += (it.kind === 'group' ? (it.ids?.length || 0) : 1);
          }

          if (movingRight) {
            // W PRAWO: Iteruj OD KOŃCA (reverse).
            // Ale wstawiaj na (insertAt + offset).
            // Dzięki temu Tab wstawiamy na (8 + 7 = 15), a Grupę na (8 + 0 = 8).
            // Kolejność wykonania (od tyłu) zapobiega psuciu indeksów elementów, które dopiero będziemy przesuwać.
            
            for (let i = items.length - 1; i >= 0; i--) {
              const it = items[i];
              const targetIdx = insertAt + it._targetOffset;
              console.log(`[DnD] RIGHT-MOVE-OFFSET ${it.kind} ID/GID: ${it.kind === 'group' ? it.gid : it.ids[0]} TO INDEX: ${targetIdx}`);
              
              if (it.kind === 'group') {
                try { await moveGroupAt(Number(it.gid), targetIdx); } catch {}
              } else {
                try { await moveTabAt(Number(it.ids[0]), targetIdx); } catch {}
              }
            }
          } else {
            // W LEWO: Iteruj normalnie (forward).
            // Wstawiaj na (insertAt + offset).
            for (const it of items) {
              const targetIdx = insertAt + it._targetOffset;
              console.log(`[DnD] LEFT-MOVE-OFFSET ${it.kind} ID/GID: ${it.kind === 'group' ? it.gid : it.ids[0]} TO INDEX: ${targetIdx}`);
              
              if (it.kind === 'group') {
                try { await moveGroupAt(Number(it.gid), targetIdx); } catch {}
              } else {
                try { await moveTabAt(Number(it.ids[0]), targetIdx); } catch {}
              }
            }
          }
        } // koniec if (!usedAtomicGroupMove)
      } else {
        // Zwykły pakiet kafli (bez atomów grup)
        if (movingRight) {
          for (let i = pack.length - 1; i >= 0; i--) {
            await chrome.tabs.move(pack[i], { index: insertAt + i });
          }
        } else {
          for (let i = 0; i < pack.length; i++) {
            await chrome.tabs.move(pack[i], { index: insertAt + i });
          }
        }
      }

// Akcja grupowa — JOIN wg miejsca dropu + selekcja po JOIN (zamknięta/otwarta)
let didJoin = false;
let targetCollapsed = false;
const movedTabIds = Array.isArray(pack) ? pack.slice() : [];

try {
  if (groupOp.mode === 'join' && groupOp.groupId >= 0) {
    targetCollapsed = !!(collapsedGroupIds && collapsedGroupIds.has(groupOp.groupId));
    await chrome.tabs.group({ groupId: groupOp.groupId, tabIds: movedTabIds });
    didJoin = true;
  } else if (groupOp.mode === 'keep') {
    // no-op
  } else if (groupOp.mode === 'ungroup' || groupOp.mode === 'ungroup_if_grouped') {
    const toUngroup = movedTabIds.filter(id => {
      const t = byId.get(id);
      return t && typeof t.groupId === 'number' && t.groupId >= 0;
    });
    if (toUngroup.length) await chrome.tabs.ungroup(toUngroup);
  }
} catch {}

// Selekcja po JOIN:
// - Do zamkniętej [A]: [A] odznaczona, dorzucone kafle odznaczone, [B] znika naturalnie.
// - Do otwartej [A]: dorzucone kafle zaznaczone.
try {
  if (didJoin) {
    if (targetCollapsed) {
      if (selectedGroupIds && selectedGroupIds.has(groupOp.groupId)) {
        selectedGroupIds.delete(groupOp.groupId);
        try { saveGroupSelection?.(); } catch {}
        try { setGroupSelectionVisualById(groupOp.groupId, false); } catch {}
      }
      let changed = false;
      for (const id of movedTabIds) {
        if (selectedIds.has(id)) { selectedIds.delete(id); changed = true; }
      }
      if (changed) saveSelection();
    } else {
      let changed = false;
      for (const id of movedTabIds) {
        if (!selectedIds.has(id)) { selectedIds.add(id); changed = true; }
      }
      if (changed) saveSelection();
    }
  }
} catch {}

render();
    } catch (err) {
      console.warn('DnD block move failed', err);
    }

    if (drag.ghost?.parentNode) drag.ghost.parentNode.removeChild(drag.ghost);
    clearDragVisual();
    hideInsertCaret();
    drag = null;
  }

  /* ---- Marquee (zaznaczanie obszarem w całym <main>) ---- */
  function marqueeStart(e) {
    baseSelected = new Set(selectedIds);
    marquee = {
      startX: e.clientX,
      startY: e.clientY,
      startScrollTop: scroller.scrollTop,
      startScrollLeft: scroller.scrollLeft,
      lastScrollTop: scroller.scrollTop,
      lastScrollLeft: scroller.scrollLeft,
      boxEl: document.createElement('div'),
      tilesSnapshot: [],
      mode: {
        ctrl: !!((e.ctrlKey || e.metaKey) && !(e.getModifierState && e.getModifierState('AltGraph'))),
        alt:  !!(e.altKey || (e.getModifierState && e.getModifierState('AltGraph')))
      }
    };
    marquee.boxEl.className = 'marquee';
    document.body.appendChild(marquee.boxEl);

    marquee._keyH = (ev) => {
      if (!marquee) return;
      // BLOKADA SPAMU: Jeśli to powtórzenie klawisza (trzymanie), ignoruj.
      // Reaguj tylko na fizyczną zmianę stanu (wciśnięcie/puszczenie).
      if (ev.repeat) return;

      const isAltGr = !!(ev.getModifierState && ev.getModifierState('AltGraph'));
      marquee.mode.ctrl = !!((ev.ctrlKey || ev.metaKey) && !isAltGr);
      marquee.mode.alt  = !!(ev.altKey || isAltGr);
      marqueeUpdate({ clientX: lastPointer.x, clientY: lastPointer.y });
    };
    document.addEventListener('keydown', marquee._keyH, true);
    document.addEventListener('keyup', marquee._keyH, true);

    document.addEventListener('mousemove', marqueeUpdate, true);
    document.addEventListener('mouseup', marqueeEnd, true);
    mainEl.addEventListener('scroll', onMarqueeScroll, true);
    startAutoScroll();
  }

  function onMarqueeScroll() {
    if (!marquee) return;
    marquee.lastScrollTop = scroller.scrollTop;
    marquee.lastScrollLeft = scroller.scrollLeft;
    marqueeUpdate({ clientX: lastPointer.x, clientY: lastPointer.y });
  }

function marqueeUpdate(e) {
lastPointer.x = e.clientX; lastPointer.y = e.clientY;
if (!marquee) return;

// 1) Logiczny prostokąt — bez klamrowania do viewportu; korygujemy tylko o scroll
const dScrollX = scroller.scrollLeft - marquee.startScrollLeft;
const dScrollY = scroller.scrollTop - marquee.startScrollTop;
const sxRaw = marquee.startX - dScrollX;
const syRaw = marquee.startY - dScrollY;
const cxRaw = e.clientX;
const cyRaw = e.clientY;

const x1 = Math.min(sxRaw, cxRaw);
const y1 = Math.min(syRaw, cyRaw);
const x2 = Math.max(sxRaw, cxRaw);
const y2 = Math.max(syRaw, cyRaw);

if ((x2 - x1) < MARQUEE_MIN_PX && (y2 - y1) < MARQUEE_MIN_PX) {
marquee.boxEl.style.transform = 'translate(-9999px,-9999px)';
els.grid.querySelectorAll('.tile').forEach(t => {
const id = Number(t.dataset.id);
setTileSelectionVisualById(id, baseSelected.has(id));
});
return;
}

// 2) Rysowanie ramki — bez klamrowania; ramka „sięga” poza ekran
marquee.boxEl.style.left = x1 + 'px';
marquee.boxEl.style.top = y1 + 'px';
marquee.boxEl.style.width = Math.max(0, x2 - x1) + 'px';
marquee.boxEl.style.height = Math.max(0, y2 - y1) + 'px';
marquee.boxEl.style.transform = 'none';

// 3) Test trafień — używamy logicznego prostokąta (x1..y2)
const tilesNow = [...els.grid.querySelectorAll('.tile')].map(t => {
const r = t.getBoundingClientRect();
return { id: Number(t.dataset.id), rect: r, el: t };
});

const hits = new Set();
const rect = { left: x1, top: y1, right: x2, bottom: y2 };
const useFull = !!(marquee?.mode?.alt); // Alt = pełne zawarcie
for (const t of tilesNow) {
  const r = t.rect;
  const inter = !(r.right < rect.left || r.left > rect.right || r.bottom < rect.top || r.top > rect.bottom);
  const full  = (r.left >= rect.left && r.right <= rect.right && r.top >= rect.top && r.bottom <= rect.bottom);
  if (useFull ? full : inter) hits.add(t.id);
}

// Podgląd selekcji: Ctrl = toggle, bez Ctrl = solo
const selPreview = new Set(baseSelected);
if (marquee.mode.ctrl) {
  for (const id of hits) {
    if (selPreview.has(id)) selPreview.delete(id); else selPreview.add(id);
  }
} else {
  selPreview.clear();
  for (const id of hits) selPreview.add(id);
}

  // BEZ Ctrl/Alt: podgląd chipów jak dla kafli (od razu)
  if (!marquee.mode.ctrl && !marquee.mode.alt) {
    try {
      const chipEls = Array.from(document.querySelectorAll('.group-chip'));
      const chipHits = new Set();
      for (const ch of chipEls) {
        const gid = Number(ch.getAttribute('data-group-id'));
        if (!Number.isFinite(gid)) continue;
        const r = ch.getBoundingClientRect();
        const inter = !(r.right < x1 || r.left > x2 || r.bottom < y1 || r.top > y2);
        const full  = (r.left >= x1 && r.right <= x2 && r.top >= y1 && r.bottom <= y2);
        const take  = useFull ? full : inter;
        if (take) chipHits.add(gid);
      }
      for (const ch of chipEls) {
        const gid = Number(ch.getAttribute('data-group-id'));
        const on = chipHits.has(gid);
        ch.classList.toggle('selected', on);
        const b = ch.querySelector('.btn-select');
        if (b) { b.textContent = on ? '☑' : '☐'; b.setAttribute('aria-pressed', on ? 'true' : 'false'); }
      }
    } catch {}
  }

  for (const t of tilesNow) {
    setTileSelectionVisualById(t.id, selPreview.has(t.id));
  }
}

function marqueeEnd(e) {
  document.removeEventListener('mousemove', marqueeUpdate, true);
  document.removeEventListener('mouseup', marqueeEnd, true);
  mainEl.removeEventListener('scroll', onMarqueeScroll, true);

  // zdejmij nasłuch klawiszy (dynamiczne Alt/Ctrl)
  if (marquee && marquee._keyH) {
    document.removeEventListener('keydown', marquee._keyH, true);
    document.removeEventListener('keyup', marquee._keyH, true);
  }

  stopAutoScroll();

  if (!marquee) return;

  // 1) Kotwica logiczna (nie klamruj do viewportu) — korygujemy tylko o scroll
  const dScrollX = scroller.scrollLeft - marquee.startScrollLeft;
  const dScrollY = scroller.scrollTop  - marquee.startScrollTop;
  const sxRaw = marquee.startX - dScrollX;
  const syRaw = marquee.startY - dScrollY;
  const cxRaw = e.clientX;
  const cyRaw = e.clientY;

  const x1 = Math.min(sxRaw, cxRaw);
  const y1 = Math.min(syRaw, cyRaw);
  const x2 = Math.max(sxRaw, cxRaw);
  const y2 = Math.max(syRaw, cyRaw);

  if ((x2 - x1) < MARQUEE_MIN_PX && (y2 - y1) < MARQUEE_MIN_PX) {
    clearSelection();
    els.grid.querySelectorAll('.tile').forEach(t => {
      const id = Number(t.dataset.id);
      setTileSelectionVisualById(id, false);
    });
    renderInfoOnly();

    if (marquee.boxEl?.parentNode) marquee.boxEl.parentNode.removeChild(marquee.boxEl);
    marquee = null;
    return;
  }

  // 2) Trafienia na podstawie LOGICZNEGO prostokąta
  const rect = { left: x1, top: y1, right: x2, bottom: y2 };
  const tilesNow = [...els.grid.querySelectorAll('.tile')].map(t => {
    const r = t.getBoundingClientRect();
    return { id: Number(t.dataset.id), rect: r, el: t };
  });

  // Alt = pełne zawarcie (Alt|AltGr), Ctrl = toggle (bez Ctrl z AltGr)
  const useFull  = !!(e.altKey || (e.getModifierState && e.getModifierState('AltGraph')));
  const withCtrl = !!((e.ctrlKey || e.metaKey) && !(e.getModifierState && e.getModifierState('AltGraph')));

  // Trafienia kafli (Alt → pełne zawarcie; bez Alt → „dotknięcie”)
  const hits = new Set();
  for (const t of tilesNow) {
    const r = t.rect;
    const inter = !(r.right < rect.left || r.left > rect.right || r.bottom < rect.top || r.top > rect.bottom);
    const full  = (r.left >= rect.left && r.right <= rect.right && r.top >= rect.top && r.bottom <= rect.bottom);
    if (useFull ? full : inter) hits.add(t.id);
  }

  // Priorytet chipa grupy: chip wybiera grupę zamiast kafli z tej grupy
  const chipEls = Array.from(document.querySelectorAll('.group-chip'));
  const chipHits = new Set();
  for (const ch of chipEls) {
    const gid = Number(ch.getAttribute('data-group-id'));
    if (!Number.isFinite(gid)) continue;
    const r = ch.getBoundingClientRect();
    const inter = !(r.right < x1 || r.left > x2 || r.bottom < y1 || r.top > y2);
    const full  = (r.left >= x1 && r.right <= x2 && r.top >= y1 && r.bottom <= y2);
    if (useFull ? full : inter) chipHits.add(gid);
  }

  // Mapa: tileId -> groupId
  const tileGroupById = new Map(tilesNow.map(t => [t.id, Number(t.el?.dataset?.groupId || -1)]));

  // Usuń kafle z grup trafionych chipem
  const finalTileHits = new Set();
  for (const id of hits) {
    const gid = tileGroupById.get(id);
    if (chipHits.has(gid)) continue;
    finalTileHits.add(id);
  }

  // Aktualizacja selekcji (Ctrl = toggle, bez Ctrl = solo)
  const prevGroups = new Set(selectedGroupIds || new Set());

  if (withCtrl) {
    // Toggle kafli
    for (const id of finalTileHits) {
      if (selectedIds.has(id)) selectedIds.delete(id); else selectedIds.add(id);
    }
    // Toggle chipów; włączenie chipa usuwa zaznaczenia kafli z tej grupy
    if (!selectedGroupIds) selectedGroupIds = new Set();
    for (const gid of chipHits) {
      if (selectedGroupIds.has(gid)) {
        selectedGroupIds.delete(gid);
      } else {
        selectedGroupIds.add(gid);
        for (const [tid, g] of tileGroupById) {
          if (g === gid && selectedIds.has(tid)) selectedIds.delete(tid);
        }
      }
    }
  } else {
    // Solo: ustaw wyłącznie trafione kafle i chipy
    selectedIds = new Set(finalTileHits);
    selectedGroupIds = new Set(chipHits);
  }

  // Zapis selekcji
  saveSelection();
  try { saveGroupSelection?.(); } catch {}

  // Odśwież UI grup: zdejmij z tych, które wypadły; nałóż na nowe
  try {
    for (const gid of prevGroups) {
      if (!selectedGroupIds.has(gid)) setGroupSelectionVisualById(gid, false);
    }
    for (const gid of (selectedGroupIds || [])) {
      if (!prevGroups.has(gid)) setGroupSelectionVisualById(gid, true);
    }
  } catch {}

  if (marquee.boxEl?.parentNode) marquee.boxEl.parentNode.removeChild(marquee.boxEl);
  marquee = null;

  const tiles = els.grid.querySelectorAll('.tile');
  tiles.forEach(t => {
    const id = Number(t.dataset.id);
    setTileSelectionVisualById(id, selectedIds.has(id));
  });
  renderInfoOnly();
}

  // Podpięcie PPM do <main>
  mainEl.addEventListener('mousedown', onMouseDown);

  // ESC (poza DnD): wyczyść zaznaczenie (☐/☑) bez zmian w układzie
  function onGlobalEscClearSelection(e) {
    if (e.key !== 'Escape') return;
    if (drag) return; // DnD ma własną obsługę ESC (anulowanie przenoszenia)
    if (!selectedIds || selectedIds.size === 0) return;
    e.preventDefault();
    e.stopPropagation();
    clearSelection();
    try {
      els.grid.querySelectorAll('.tile').forEach(t => {
        const id = Number(t.dataset.id);
        setTileSelectionVisualById(id, false);
      });
      renderInfoOnly();
    } catch {}
  }
  document.addEventListener('keydown', onGlobalEscClearSelection, true);
}

// Globalny ŚPM: autoscroll (toggle/trzymanie) + szybkie zamknięcie kafla
function setupMiddleClickAutoscroll() {
  const state = {
    down: false,
    downTs: 0,
    startX: 0, startY: 0,
    lastX: 0, lastY: 0,
    active: false,         // czy autoscroll działa
    mode: 'none',          // 'none' | 'hold' | 'toggle'
    anchorX: 0, anchorY: 0,
    raf: 0,
    holdTimer: 0,
    moved: false,
    targetTileId: null,
    lastTs: 0              // do liczenia dt (px/s → px/frame)
  };

  function setCursor(on) { document.documentElement.classList.toggle('as-autoscroll', !!on); }

  // Połknięcie pierwszego click/auxclick/contextmenu po wyjściu z toggle
  let suppressClickOnce = false;
  function swallowOnceIfNeeded(e) {
    if (!suppressClickOnce) return;
    e.preventDefault(); e.stopPropagation();
    suppressClickOnce = false;
  }

  // Czerwone „uzbrojenie” kafla na czas możliwego szybkiego zamknięcia
  let armedTileEl = null;
  function armTile(el) {
    clearArm();
    if (el) { armedTileEl = el; armedTileEl.classList.add('mmb-armed'); }
  }
  function clearArm() {
    if (armedTileEl) { armedTileEl.classList.remove('mmb-armed'); armedTileEl = null; }
  }


  function ensureLoop() { if (!state.raf) state.raf = requestAnimationFrame(tick); }

  function startHold() {
    clearArm();
    state.active = true; state.mode = 'hold';
    state.anchorX = state.startX; state.anchorY = state.startY;
    state.lastTs = performance.now();
    setCursor(true); ensureLoop();
  }
  function startToggle() {
    clearArm();
    state.active = true; state.mode = 'toggle';
    state.anchorX = state.startX; state.anchorY = state.startY;
    state.lastTs = performance.now();
    setCursor(true); ensureLoop();
  }
  function edgeSpeedFactor(delta, anchorCoord, minEdge, maxEdge) {
    const dir = Math.sign(delta) || 0;
    if (!dir) return 0;
    const distToEdge = dir > 0 ? (maxEdge - anchorCoord) : (anchorCoord - minEdge);
    if (distToEdge <= 0) return 0;
    const norm = Math.max(0, Math.min(1, Math.abs(delta) / distToEdge));
    if (norm < AUTOSCROLL_DEAD_PCT) return 0;
    return Math.min(1, (norm - AUTOSCROLL_DEAD_PCT) / (AUTOSCROLL_SAT_PCT - AUTOSCROLL_DEAD_PCT));
  }

  function tick() {
    if (!state.active) { state.raf = 0; return; }
    const rect = scroller.getBoundingClientRect();
    const now = performance.now();
    const dt = Math.min(0.05, Math.max(0, (now - state.lastTs) / 1000));
    state.lastTs = now;

    const dx = state.lastX - state.anchorX;
    const dy = state.lastY - state.anchorY;

    let fx = edgeSpeedFactor(dx, state.anchorX, rect.left,  rect.right);
    let fy = edgeSpeedFactor(dy, state.anchorY, rect.top,   rect.bottom);

    // snap osi jak wcześniej
    const ax = Math.abs(dx), ay = Math.abs(dy);
    if (ax > ay * AS_SNAP_RATIO) fy *= AS_SNAP_DAMP;
    else if (ay > ax * AS_SNAP_RATIO) fx *= AS_SNAP_DAMP;

    // kierunek (lewo/prawo, góra/dół) wg znaku dx/dy
    const dirX = Math.sign(dx) || 0;
    const dirY = Math.sign(dy) || 0;

    if (fx && dirX) scroller.scrollLeft += (AUTOSCROLL_MAX_SPEED_PPS * fx * dirX) * dt;
    if (fy && dirY) scroller.scrollTop  += (AUTOSCROLL_MAX_SPEED_PPS * fy * dirY) * dt;

    state.raf = requestAnimationFrame(tick);
  }
  function stopAll() {
    if (state.holdTimer) { clearTimeout(state.holdTimer); state.holdTimer = 0; }
    if (state.raf) { cancelAnimationFrame(state.raf); state.raf = 0; }
    state.active = false; state.mode = 'none';
    setCursor(false);
  }

  function onMouseDown(e) {
    // Jeśli toggle włączony: wyłącz i POŁKNIJ pierwszy klik dowolnym przyciskiem (LPM/PPM/ŚPM)
    if (state.active && state.mode === 'toggle') {
      e.preventDefault(); e.stopPropagation();
      stopAll();
      suppressClickOnce = true;
      return;
    }

    // Globalnie blokujemy natywny autoscroll ŚPM
    if (e.button === 1) {
      e.preventDefault(); e.stopPropagation();
      state.down = true; state.moved = false;
      state.downTs = Date.now();
      state.startX = state.lastX = e.clientX;
      state.startY = state.lastY = e.clientY;

      const tile = e.target.closest && e.target.closest('.tile');
      state.targetTileId = tile ? Number(tile.dataset.id) : null;

      // Podświetl kafel tylko w oknie możliwego „szybkiego zamknięcia”
      if (tile) armTile(tile);

      if (state.holdTimer) clearTimeout(state.holdTimer);
      state.holdTimer = setTimeout(() => {
        if (!state.down || state.moved || state.active) return;
        startToggle();
      }, AS_HOLD_TOGGLE_MS);
    }
  }
  function onMouseMove(e) {
    state.lastX = e.clientX; state.lastY = e.clientY;
    if (state.down && !state.active) {
      const moved = Math.hypot(state.lastX - state.startX, state.lastY - state.startY) > AS_CLICK_TOL_PX;
      if (moved) { state.moved = true; startHold(); }
    }
  }
  function onMouseUp(e) {
    const isMMB = e.button === 1;
    if (isMMB) { e.preventDefault(); e.stopPropagation(); }
    if (state.holdTimer) { clearTimeout(state.holdTimer); state.holdTimer = 0; }

    if (isMMB && state.active) {
      // Pływak (hold/toggle) → wyłącz i „połknij” następny click
      stopAll();
      clearArm();
      suppressClickOnce = true;
    } else if (!state.active && state.down && isMMB) {
      // Szybkie kliknięcie ŚPM bez ruchu => zamknij kafel
      const dt = Date.now() - state.downTs;
      const canQuickClose = (dt < AS_HOLD_TOGGLE_MS) && !state.moved && state.targetTileId;
      const toClose = state.targetTileId;
      clearArm();
      if (canQuickClose) {
        try { closeTab({ id: toClose }); } catch {}
      }
    }
    state.down = false;
  }
  function onKeyDown(e) { if (e.key === 'Escape' && state.active) { stopAll(); } }

  document.addEventListener('mousedown', onMouseDown, true);
  document.addEventListener('mousemove', onMouseMove, true);
  document.addEventListener('mouseup', onMouseUp, true);
  document.addEventListener('keydown', onKeyDown, true);

  document.addEventListener('click', swallowOnceIfNeeded, true);
  document.addEventListener('auxclick', swallowOnceIfNeeded, true);
  document.addEventListener('contextmenu', swallowOnceIfNeeded, true);

  // Zapasowo blokuj natywne akcje ŚPM
  document.addEventListener('auxclick', (e) => {
    if (e.button === 1) { e.preventDefault(); e.stopPropagation(); }
  }, true);
}

/* === Keep‑alive dla ukrytej siatki: co 10 s bezczynności → render() + ping do SW === */
const KEEPALIVE_IDLE_MS = 10000;
let keepaliveAttached = false;
function attachKeepAlive() {
  if (keepaliveAttached) return;
  keepaliveAttached = true;

  let lastActivity = Date.now();
  const mark = () => { lastActivity = Date.now(); };

  // Aktywność użytkownika i zmiany widoczności
  ['mousemove','keydown','wheel','pointerdown','touchstart','focus','blur','visibilitychange']
    .forEach(ev => document.addEventListener(ev, mark, { capture: true, passive: true }));

  try {
    const sc = document.querySelector('main');
    if (sc) sc.addEventListener('scroll', mark, { passive: true });
  } catch {}

  // Co 2 s sprawdź, czy przez >= 10 s było cicho, a karta jest ukryta
  setInterval(() => {
    if (document.visibilityState !== 'hidden') return;
    const idle = Date.now() - lastActivity;
    if (idle >= KEEPALIVE_IDLE_MS) {
      try { render(); } catch {}
      try { chrome.runtime.sendMessage({ type: 'KEEPALIVE_PING', ts: Date.now() }); } catch {}
      lastActivity = Date.now(); // odmierzaj kolejne 10 s
    }
  }, 2000);
}
/* ---- Przywracanie zamkniętych kart ---- */
// Wrappery zgodne z Brave/Chromium (callback → Promise)
async function sessionsGetRecentlyClosedCompat(max = RESTORE_MENU_MAX) {
  return new Promise((resolve) => {
    try {
      chrome.sessions.getRecentlyClosed({ maxResults: Math.max(1, Number(max) || 0) }, (res) => {
        if (chrome.runtime.lastError) {
          console.warn('getRecentlyClosed lastError:', chrome.runtime.lastError);
          resolve([]);
          return;
        }
        resolve(res || []);
      });
    } catch (e) {
      console.warn('getRecentlyClosed threw:', e);
      resolve([]);
    }
  });
}
async function sessionsRestoreCompat(sessionId) {
  return new Promise((resolve) => {
    try {
      chrome.sessions.restore(sessionId, (res) => {
        if (chrome.runtime.lastError) {
          console.warn('sessions.restore lastError:', chrome.runtime.lastError);
        }
        resolve(res || null);
      });
    } catch (e) {
      console.warn('sessions.restore threw:', e);
      resolve(null);
    }
  });
}

async function getRecentlyClosedTabsForWindow(winId, limit = RESTORE_MENU_MAX) {
  try {
    const items = await chrome.sessions.getRecentlyClosed({ maxResults: Math.max(25, limit) });
    const onlyTabs = (items || []).filter(it => it.tab && !it.tab.incognito);
    const withWin = onlyTabs.filter(it => typeof it.tab.windowId === 'number');
    // Najpierw per-okno, ale jeśli pusto → globalnie
    let filtered = (withWin.length && typeof winId === 'number')
      ? withWin.filter(it => it.tab.windowId === winId)
      : onlyTabs;
    if (!filtered.length) filtered = onlyTabs;
    filtered.sort((a,b) => (b.lastModified || 0) - (a.lastModified || 0));
    return filtered.slice(0, limit);
  } catch { return []; }
}

async function restoreBySessionId(sessionId, stayOnSwitcher = true) {
  try {
    await chrome.sessions.restore(String(sessionId));
  } catch (e) {
    console.warn('sessions.restore failed', e);
  }
  if (stayOnSwitcher) {
    try {
      const url = SWITCHER_URL;
      if (typeof lastWinId === 'number') {
        await chrome.windows.update(lastWinId, { focused: true });
        const tabs = await chrome.tabs.query({ windowId: lastWinId, url });
        if (tabs && tabs[0]) await chrome.tabs.update(tabs[0].id, { active: true });
      } else {
        const tabs = await chrome.tabs.query({ url });
        if (tabs && tabs[0]) {
          await chrome.windows.update(tabs[0].windowId, { focused: true });
          await chrome.tabs.update(tabs[0].id, { active: true });
        }
      }
    } catch (e) {
      console.warn('refocus switcher failed:', e);
    }
  }
  render();
  try { updateRestoreButtonState(); } catch {}
}

async function populateRestoreMenu() {
  const menu = els.restoreMenu;
  if (!menu) return;
  menu.textContent = '';

  const items = await getRecentlyClosedTabsForWindow(lastWinId, RESTORE_MENU_MAX);
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'Brak zamkniętych kart w tym oknie';
    menu.appendChild(empty);
    return;
  }

  // pomocnik: konwersja sekund → ms (Brave potrafi dać 10-cyfrowe sekundy)
  const toMs = (v) => {
    const n = Number(v) || 0;
    return n < 1e12 ? n * 1000 : n;
  };
  const showMeta = !!els.showMeta?.checked;

  for (const it of items) {
		const row = document.createElement('div'); row.className = 'mi'; row.setAttribute('role','menuitem');
		// tooltip jak na kaflach — tylko nazwa
		const fullTitle = (it.tab?.title || it.tab?.url || '(bez tytułu)').toString();
		row.title = fullTitle;
		row.setAttribute('aria-label', fullTitle);

    const fav = document.createElement('div');
    fav.className = 'fav-wrap';
    try { attachFavicon(it.tab, fav); } catch {}

    const text = document.createElement('div');
    text.style.minWidth = 0;

    const t = document.createElement('div');
    t.className = 't';
    t.textContent = it.tab.title || '(bez tytułu)';

    text.appendChild(t);

    if (showMeta) {
      const m = document.createElement('div');
      m.className = 'm';
      const when = toMs(it.lastModified);
      m.textContent = `${getHost(it.tab.url)} • ${formatAgo(when)}`;
      text.appendChild(m);
    }

    const act = document.createElement('div');
    act.textContent = '↶';
    act.style.opacity = .7;

    row.appendChild(fav);
    row.appendChild(text);
    row.appendChild(act);

    row.addEventListener('click', async (e) => {
      e.preventDefault(); e.stopPropagation();
      closeRestoreMenu();
      const sid = it?.tab?.sessionId || it?.sessionId;
      if (sid) await restoreBySessionId(String(sid), true);
    });

    menu.appendChild(row);
  }
}

function openRestoreMenu() {
  if (!els.restoreMenu) return;
  els.restoreMenu.style.display = 'block';
  els.restoreMenuBtn?.setAttribute('aria-expanded', 'true');
  populateRestoreMenu();
}
function closeRestoreMenu() {
  if (!els.restoreMenu) return;
  els.restoreMenu.style.display = 'none';
  els.restoreMenuBtn?.setAttribute('aria-expanded', 'false');
}
async function updateRestoreButtonState() {
    if (!els.restoreMenuBtn) return;
    const items = await getRecentlyClosedTabsForWindow(lastWinId, 1);
    const hasItems = items && items.length > 0;
    els.restoreMenuBtn.disabled = !hasItems;
    els.restoreMenuBtn.style.opacity = hasItems ? '1' : '0.6';
}

function initRestoreUI() {
  if (els.restoreMenuBtn) {
    els.restoreMenuBtn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (els.restoreMenuBtn.disabled) return;
      const open = els.restoreMenu?.style.display === 'block';
      if (open) closeRestoreMenu(); else openRestoreMenu();
    });
    // Sprawdź stan przy inicjalizacji
    updateRestoreButtonState();
  }
  document.addEventListener('mousedown', (e) => {
    const wrap = document.querySelector('.restore-wrap');
    if (!wrap) return;
    if (els.restoreMenu?.style.display === 'block' && !wrap.contains(e.target)) closeRestoreMenu();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && els.restoreMenu?.style.display === 'block') closeRestoreMenu();
    
    // Obsługa Delete: Usuń zaznaczone
    if (e.key === 'Delete') {
        // Upewnij się, że nie jesteśmy w polu tekstowym (np. filtr)
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        
        e.preventDefault();
        if (els.deleteSelectedBtn && !els.deleteSelectedBtn.disabled) {
            els.deleteSelectedBtn.click(); // Wywołaj logikę przycisku
        }
    }
  }, true);
}


// Pomoc „?” po prawej krawędzi – toggle i zamykanie
function initHelpUITop() {
  try {
    const btn = document.getElementById('helpBtnTop');
    const tip = document.getElementById('helpTipTop');
    if (!btn || !tip) return;

    const close = () => { tip.style.display = 'none'; btn.setAttribute('aria-expanded','false'); };
    const open  = () => { tip.style.display = 'block'; btn.setAttribute('aria-expanded','true'); };
    const toggle = () => { (tip.style.display === 'block') ? close() : open(); };

    btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); toggle(); }, true);
    tip.addEventListener('mousedown', (e) => { e.stopPropagation(); }, true);

    document.addEventListener('mousedown', (e) => {
      if (tip.style.display !== 'block') return;
      const inTip = e.target && (e.target === tip || (e.target.closest && e.target.closest('#helpTipTop')));
      const inBtn = e.target && (e.target === btn || (e.target.closest && e.target.closest('#helpBtnTop')));
      if (!inTip && !inBtn) close();
    }, true);

    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && tip.style.display === 'block') close(); }, true);
  } catch {}
}

// Smart tooltip (zamiast natywnego title) – singleton + delegacja
// Smart tooltip (zamiast natywnego title) – „jak natywny”: pokazuj po bezruchu, znikaj przy ruchu
function initSmartTooltip() {
  if (window.__smartTipInit) return; window.__smartTipInit = true;

  const tip = document.createElement('div');
  tip.className = 'smart-tip';
  document.body.appendChild(tip);

  let showTimer = 0, hideTimer = 0;
  let hoveredEl = null;      // element pod kursorem z data-tip
  let anchor = null;         // element, dla którego tooltip jest pokazany
  let lastText = '';

  // „Jak natywny”:
  const TIP_DELAY_MS = 700;      // czas bezruchu przed pokazaniem
  const HIDE_DELAY_MS = 60;      // lekkie opóźnienie chowania
  const MOVE_TOL_PX = 2;         // małe drgnięcia nie resetują od razu
  const EDGE = 8;
  const OFF_X = 12, OFF_Y = 16;  // offset od kursora (jak bąbelek)

  let lastMoveX = 0, lastMoveY = 0;
  let pendingX = 0, pendingY = 0; // gdzie pokazać po bezruchu

  const clearTimers = () => {
    if (showTimer) clearTimeout(showTimer);
    if (hideTimer) clearTimeout(hideTimer);
    showTimer = hideTimer = 0;
  };

  const place = (clientX, clientY) => {
    tip.style.transform = 'none';
    const r = tip.getBoundingClientRect();
    const W = window.innerWidth, H = window.innerHeight;

    let left = clientX + OFF_X;
    let top  = clientY + OFF_Y;

    if (left < EDGE) left = EDGE;
    if (top  < EDGE) top  = EDGE;
    if (left + r.width  > W - EDGE) left = Math.max(EDGE, W - EDGE - r.width);
    if (top  + r.height > H - EDGE) top  = Math.max(EDGE, H - EDGE - r.height);

    tip.style.left = left + 'px';
    tip.style.top  = top  + 'px';
  };

  const hide = () => {
    clearTimers();
    tip.style.transform = 'translate(-9999px,-9999px)';
    anchor = null;
  };

  const scheduleShowAt = (el, text, x, y) => {
    clearTimers();
    if (!text) return;
    pendingX = x; pendingY = y;
    showTimer = setTimeout(() => {
      // jeśli wciąż ten sam hover i nie ruszył się znacznie
      if (!hoveredEl || hoveredEl !== el) return;
      lastText = String(text).trim();
      if (!lastText) return;
      anchor = el;
      tip.textContent = lastText;
      place(pendingX, pendingY);
    }, TIP_DELAY_MS);
  };

  const pickupTipText = (el) => {
    if (!el || !el.getAttribute) return '';
    let text = el.getAttribute('data-tip') || el.getAttribute('title') || '';
    if (text && el.hasAttribute('title')) {
      el.setAttribute('data-tip', text);
      el.removeAttribute('title'); // wyłącz natywny
    }
    return el.getAttribute('data-tip') || '';
  };

  const onOver = (e) => {
    let el = e.target;
    // znajdź najbliższy z data-tip/title
    for (let i = 0; el && i < 4; i++, el = el.parentElement) {
      if (!el) break;
      const txt = pickupTipText(el);
      if (txt) {
        hoveredEl = el;
        lastMoveX = e.clientX; lastMoveY = e.clientY;
        scheduleShowAt(el, txt, lastMoveX, lastMoveY);
        return;
      }
    }
  };

  const onOut = (e) => {
    if (!hoveredEl) return;
    const toEl = e.relatedTarget;
    if (toEl && (toEl === hoveredEl || (toEl.closest && hoveredEl.contains(toEl)))) return;
    hoveredEl = null;
    clearTimers();
    hideTimer = setTimeout(hide, HIDE_DELAY_MS);
  };

  const onMove = (e) => {
    if (!hoveredEl) return;
    const dx = Math.abs(e.clientX - lastMoveX);
    const dy = Math.abs(e.clientY - lastMoveY);
    if (dx > MOVE_TOL_PX || dy > MOVE_TOL_PX) {
      lastMoveX = e.clientX; lastMoveY = e.clientY;
      clearTimers();
      // jeśli tooltip był pokazany — schowaj i wymagaj ponownego bezruchu
      if (anchor) hide();
      // ustaw nowy timer pokazania po bezruchu
      const txt = pickupTipText(hoveredEl);
      if (txt) scheduleShowAt(hoveredEl, txt, lastMoveX, lastMoveY);
    }
  };

  const onFocus = (e) => {
    const el = e.target;
    const txt = pickupTipText(el);
    if (!txt) return;
    // przy focusie nie mamy kursora — pokaż pod elementem po „natywnym” czasie
    const rect = el.getBoundingClientRect();
    lastMoveX = Math.min(window.innerWidth - EDGE, Math.max(EDGE, (rect.left + rect.right) / 2));
    lastMoveY = rect.bottom;
    hoveredEl = el;
    scheduleShowAt(el, txt, lastMoveX, lastMoveY);
  };

  const onBlur = () => { hoveredEl = null; hide(); };

  const onEsc = (e) => { if (e.key === 'Escape') hide(); };
  const onScroll = () => { hide(); hoveredEl = null; clearTimers(); };
  const onResize = () => { hide(); hoveredEl = null; clearTimers(); };

  document.addEventListener('mouseover', onOver, true);
  document.addEventListener('mouseout', onOut, true);
  document.addEventListener('mousemove', onMove, true);

  document.addEventListener('focusin', onFocus, true);
  document.addEventListener('focusout', onBlur, true);

  document.addEventListener('keydown', onEsc, true);
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onResize, true);
}


// --- Obsługa Popupa Edycji Grupy ---
let currentEditGroupId = null; // ID grupy edytowanej (null = nowa grupa)
let pendingGroupCreateIds = []; // ID kart do nowej grupy

function initGroupDialog() {
    console.log('[DEBUG] initGroupDialog start', els.groupEditDialog);
    if (!els.groupEditDialog) return;
    
    // 1. Generowanie kolorów
    const colors = Object.keys(GROUP_COLORS);
    els.gedColors.innerHTML = '';
    colors.forEach(c => {
        const hex = GROUP_COLORS[c];
        const sw = document.createElement('div');
        sw.className = 'color-swatch';
        sw.style.backgroundColor = hex;
        sw.dataset.color = c;
        sw.title = GROUP_COLORS_PL[c] || c;
        sw.addEventListener('click', () => {
            els.gedColors.querySelectorAll('.color-swatch').forEach(el => el.classList.remove('selected'));
            sw.classList.add('selected');
        });
        els.gedColors.appendChild(sw);
    });

    // Obsługa akcji
    if (els.actToggle) els.actToggle.addEventListener('click', () => {
        if (currentEditGroupId !== null) {
            // Sprawdź aktualny stan, żeby odwrócić? Trudne bez pobierania.
            // Ale możemy po prostu przełączyć lokalnie collapsedGroupIds i zsynkować.
            toggleGroupCollapsedById(currentEditGroupId);
            close();
        }
    });
    if (els.actHide) els.actHide.addEventListener('click', () => {
        if (currentEditGroupId !== null) hideGroupById(currentEditGroupId);
        close();
    });
    if (els.actUngroup) els.actUngroup.addEventListener('click', () => {
        if (currentEditGroupId !== null) ungroupGroupById(currentEditGroupId);
        close();
    });
    if (els.actDelete) els.actDelete.addEventListener('click', () => {
        if (currentEditGroupId !== null) deleteGroupById(currentEditGroupId);
        close();
    });


    // Funkcja zamykająca
    const close = () => { els.groupEditDialog.style.display = 'none'; };

    // 2. Przyciski
    if (els.gedCancel) els.gedCancel.addEventListener('click', (e) => {
        e.stopPropagation(); // Ważne, żeby nie triggerowało zamykania "na zewnątrz"
        close();
    });

    if (els.gedSave) els.gedSave.addEventListener('click', async (e) => {
        e.stopPropagation();
        const title = els.gedTitle.value.trim();
        const sel = els.gedColors.querySelector('.color-swatch.selected');
        const color = sel ? sel.dataset.color : 'grey';
        
        close();

        if (currentEditGroupId !== null) {
            try { await chrome.tabGroups.update(currentEditGroupId, { title, color }); } catch {}
        } else {
            if (pendingGroupCreateIds.length) {
                try {
                    const gid = await chrome.tabs.group({ tabIds: pendingGroupCreateIds });
                    await chrome.tabGroups.update(gid, { title, color });
                    selectedIds.clear();
                    selectedGroupIds.clear();
                    selectedGroupIds.add(gid);
                    saveSelection();
                    saveGroupSelection();
                } catch {}
            }
        }
        render();
    });

    // 3. Zamykanie na klik na zewnątrz (globalnie)
    document.addEventListener('mousedown', (e) => {
        if (els.groupEditDialog.style.display !== 'none' && els.groupEditDialog.style.display !== '') {
            // Czy kliknięto wewnątrz popupa?
            if (els.groupEditDialog.contains(e.target)) return;
            
            // Czy kliknięto w przyciski otwierające? (żeby nie zamknąć i otworzyć od razu)
            if (e.target === els.btnGroupNew || e.target.closest('#btnGroupNew')) return;
            if (e.target === els.btnGroupProps || e.target.closest('#btnGroupProps')) return;

            close();
        }
    }, true);

    // Obsługa klawiszy w polu nazwy
    if (els.gedTitle) {
        els.gedTitle.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                els.gedSave.click(); // Symuluj klik w Zapisz
            } else if (e.key === 'Escape') {
                e.preventDefault();
                close(); // Anuluj
            }
        });
    }
    // Globalny Esc dla popupa (gdy focus nie jest w polu)
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && els.groupEditDialog.style.display !== 'none') {
            close();
        }
    });
}

function openGroupDialog(groupId, preselectIds = [], anchorBtn = null) {
    if (!els.groupEditDialog) return;
    
    // Reset UI
    els.gedTitle.value = '';
    els.gedColors.querySelectorAll('.color-swatch').forEach(el => el.classList.remove('selected'));
    
    currentEditGroupId = groupId;
    pendingGroupCreateIds = preselectIds;
    
    // Pokaż akcje tylko przy edycji istniejącej grupy
    if (groupId !== null && els.gedActions) {
        els.gedActions.style.display = 'flex';
        // Aktualizuj tekst Zwiń/Rozwiń?
        if (els.actToggle) {
             const isCol = collapsedGroupIds && collapsedGroupIds.has(groupId);
             els.actToggle.textContent = isCol ? '▾ Rozwiń grupę' : '▸ Zwiń grupę';
        }
    } else if (els.gedActions) {
        els.gedActions.style.display = 'none';
    }

    const showAtAnchor = () => {
        els.groupEditDialog.style.display = 'block';
        if (anchorBtn) {
            const rect = anchorBtn.getBoundingClientRect();
            // Pozycjonuj pod przyciskiem, wyrównaj do prawej krawędzi przycisku
            const popW = els.groupEditDialog.offsetWidth || 280;
            let left = rect.right - popW;
            if (left < 10) left = 10; // safety
            els.groupEditDialog.style.top = (rect.bottom + 6) + 'px';
            els.groupEditDialog.style.left = left + 'px';
            els.groupEditDialog.style.transform = 'none';
        } else {
            // Fallback na środek
            els.groupEditDialog.style.top = '50%';
            els.groupEditDialog.style.left = '50%';
            els.groupEditDialog.style.transform = 'translate(-50%, -50%)';
        }
    };

    if (groupId !== null) {
        chrome.tabGroups.get(groupId, (g) => {
            if (chrome.runtime.lastError || !g) return;
            els.gedTitle.value = g.title || '';
            const sw = els.gedColors.querySelector(`.color-swatch[data-color="${g.color}"]`);
            if (sw) sw.classList.add('selected');
            showAtAnchor();
        });
    } else {
        els.gedTitle.value = 'Nowa grupa';
        const sw = els.gedColors.querySelector(`.color-swatch[data-color="grey"]`);
        if (sw) sw.classList.add('selected');
        showAtAnchor();
    }
}

// --- Lista Grup ---
async function populateListMenu() {
    const menu = els.menuGroupList;
    if (!menu) return;
    menu.textContent = '';
    
    try {
        const groups = await chrome.tabGroups.query({ windowId: lastWinId });
        if (!groups || !groups.length) {
            const empty = document.createElement('div');
            empty.className = 'empty';
            empty.textContent = 'Brak grup';
            menu.appendChild(empty);
            return;
        }

        for (const g of groups) {
            const row = document.createElement('div');
            row.className = 'mi';
            row.style.display = 'flex';
            row.style.alignItems = 'center';
            row.style.justifyContent = 'flex-start';
            row.style.padding = '6px 8px';
            
            // 1. Ikona stanu
            const isHidden = hiddenGroupIds && hiddenGroupIds.has(g.id);
            
            const stateIcon = document.createElement('div');
            stateIcon.style.fontSize = '14px';
            stateIcon.style.color = '#666';
            stateIcon.style.marginRight = '0px';
            stateIcon.style.minWidth = '16px';
            stateIcon.style.textAlign = 'center';
            stateIcon.style.flexShrink = '0';
            stateIcon.textContent = isHidden ? '👁' : (g.collapsed ? '📁' : '📂');
            
            // 2. Kropka
            const dot = document.createElement('div');
            dot.style.width = '12px'; dot.style.height = '12px'; 
            dot.style.borderRadius = '50%'; 
            dot.style.backgroundColor = GROUP_COLORS[g.color] || GROUP_COLORS.grey;
            dot.style.marginRight = '0px';
            dot.style.flexShrink = '0';
            
            // 3. Tytuł
            const title = document.createElement('div');
            title.textContent = g.title || '(bez nazwy)';
            title.style.fontSize = '13px';
            title.style.whiteSpace = 'nowrap';
            title.style.overflow = 'hidden';
            title.style.textOverflow = 'ellipsis';
            title.style.flex = '1';
            
            row.appendChild(stateIcon);
            row.appendChild(dot);
            row.appendChild(title);
            
            row.addEventListener('click', async () => {
                menu.style.display = 'none';
                
                // Odkryj jeśli ukryta
                if (hiddenGroupIds.has(g.id)) {
                    hiddenGroupIds.delete(g.id);
                    await saveHiddenGroups();
                }
                
                // Rozwiń i aktywuj (przewiń)
                await chrome.tabGroups.update(g.id, { collapsed: false });
                
                // Renderuj, żeby grupa pojawiła się w DOM, potem scrolluj
                render();
                
                setTimeout(() => {
                    const el = els.grid.querySelector(`.tile[data-group-id="${g.id}"]`);
                    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }, 100);
            });
            
            menu.appendChild(row);
        }
    } catch {}
}

// --- Przenieś do grupy ---
async function populateMoveMenu() {
    const menu = els.menuGroupMove;
    if (!menu) return;
    menu.textContent = '';
    
    try {
        const groups = await chrome.tabGroups.query({ windowId: lastWinId });
        if (!groups || !groups.length) {
            const empty = document.createElement('div');
            empty.className = 'empty';
            empty.textContent = 'Brak grup';
            menu.appendChild(empty);
            return;
        }

        for (const g of groups) {
            const row = document.createElement('div');
            row.className = 'mi';
            row.style.display = 'flex';
            row.style.alignItems = 'center';
            row.style.justifyContent = 'flex-start';
            row.style.padding = '6px 8px';
            
            // 1. Ikona stanu
            const isHidden = hiddenGroupIds && hiddenGroupIds.has(g.id);
            
            const stateIcon = document.createElement('div');
            stateIcon.style.fontSize = '14px';
            stateIcon.style.color = '#666';
            stateIcon.style.marginRight = '0px';
            stateIcon.style.minWidth = '16px';
            stateIcon.style.textAlign = 'center';
            stateIcon.style.flexShrink = '0';
            stateIcon.textContent = isHidden ? '👁' : (g.collapsed ? '📁' : '📂');

            // 2. Kropka
            const dot = document.createElement('div');
            dot.style.width = '12px'; dot.style.height = '12px'; 
            dot.style.borderRadius = '50%'; 
            dot.style.backgroundColor = GROUP_COLORS[g.color] || GROUP_COLORS.grey;
            dot.style.marginRight = '0px';
            dot.style.flexShrink = '0';
            
            // 3. Tytuł
            const title = document.createElement('div');
            title.textContent = g.title || '(bez nazwy)';
            title.style.fontSize = '13px';
            title.style.whiteSpace = 'nowrap';
            title.style.overflow = 'hidden';
            title.style.textOverflow = 'ellipsis';
            title.style.flex = '1';
            
            row.appendChild(stateIcon);
            row.appendChild(dot);
            row.appendChild(title);
            
            row.addEventListener('click', async () => {
                menu.style.display = 'none';
                const idsSet = new Set();
                if (selectedIds) selectedIds.forEach(id => idsSet.add(id));
                if (selectedGroupIds) {
                    const allTabs = await chrome.tabs.query({ windowId: lastWinId });
                    for (const t of allTabs) {
                        if (t.groupId >= 0 && selectedGroupIds.has(t.groupId) && !t.pinned) idsSet.add(t.id);
                    }
                }
                const finalIds = Array.from(idsSet);
                if (finalIds.length) {
                    await chrome.tabs.group({ groupId: g.id, tabIds: finalIds });
                    
                    // Czyść WSZYSTKIE zaznaczenia
                    selectedGroupIds.clear();
                    selectedIds.clear(); // Dodano
                    saveGroupSelection();
                    saveSelection();     // Dodano
                    render();
                }
            });
            
            menu.appendChild(row);
        }
    } catch {}
}

// --- Menu Koloru Akcentu ---
function setAccentColor(colorName) {
    const hex = GROUP_COLORS[colorName] || GROUP_COLORS.blue;
    if (els.accentDot) els.accentDot.style.backgroundColor = hex;
    saveSettings({ accentColor: colorName });
    applyAccentCSS(hex);
}

function populateAccentMenu() {
    const menu = els.menuAccentColor;
    if (!menu) return;
    menu.innerHTML = '';
    
    const colors = Object.keys(GROUP_COLORS);
    for (const c of colors) {
        const hex = GROUP_COLORS[c];
        const row = document.createElement('div');
        row.className = 'mi';
        row.style.display = 'flex';
        row.style.alignItems = 'center';
        row.style.padding = '6px 8px';
        
        const dot = document.createElement('div');
        dot.style.width = '12px'; dot.style.height = '12px'; 
        dot.style.borderRadius = '50%'; 
        dot.style.backgroundColor = hex;
        dot.style.marginRight = '8px';
        
        const txt = document.createElement('div');
        txt.textContent = GROUP_COLORS_PL[c] || c; // PL nazwa na liście
        txt.style.fontSize = '13px';
        
        row.appendChild(dot);
        row.appendChild(txt);
        
        row.addEventListener('click', () => {
            setAccentColor(c);
            menu.style.display = 'none';
        });
        menu.appendChild(row);
    }
}

// UI
function bindUI() {
  if (els.depth) els.depth.addEventListener('change', () => { const v = clamp(els.depth.value, LIMITS.depthMin, LIMITS.depthMax); els.depth.value = v; saveSettings({ depth: v }); });
  if (els.ignorePinnedExt) els.ignorePinnedExt.addEventListener('change', () => { saveSettings({ ignorePinned: !!els.ignorePinnedExt.checked }); });
  if (els.autoPin) els.autoPin.addEventListener('change', () => { saveSettings({ autoPinSwitcher: !!els.autoPin.checked }); });

  if (els.orientation) els.orientation.addEventListener('change', () => { saveSettings({ orientation: els.orientation.value }); updateCountLabel(); toggleCountAvailability(); render(); });
  if (els.count) els.count.addEventListener('change', () => { const v = clamp(els.count.value, LIMITS.countMin, LIMITS.countMax); els.count.value = v; saveSettings({ gridCount: v }); render(); });
  if (els.tileW) els.tileW.addEventListener('change', () => { const v = clamp(els.tileW.value, LIMITS.tileWMin, LIMITS.tileWMax); els.tileW.value = v; saveSettings({ tileWidth: v }); applyCSSVars(); render(); });
  if (els.tileH) els.tileH.addEventListener('change', () => { const v = clamp(els.tileH.value, LIMITS.tileHMin, LIMITS.tileHMax); els.tileH.value = v; saveSettings({ tileHeight: v }); applyCSSVars(); render(); });
  if (els.tilePad) els.tilePad.addEventListener('change', () => { const v = clamp(els.tilePad.value, LIMITS.padMin, LIMITS.padMax); els.tilePad.value = v; saveSettings({ tilePadding: v }); applyCSSVars(); render(); });
  if (els.iconSize) els.iconSize.addEventListener('change', () => { const size = clamp(els.iconSize.value, 16, 128); els.iconSize.value = size; saveSettings({ iconSize: size }); applyFavSize(size); forceFaviconRefresh(); });
  if (els.sort) els.sort.addEventListener('change', () => { saveSettings({ sort: els.sort.value }, false); render(); });
  if (els.hidePinned) els.hidePinned.addEventListener('change', () => { saveSettings({ hidePinned: !!els.hidePinned.checked }, false); render(); });
  if (els.showClose) els.showClose.addEventListener('change', () => { saveSettings({ showClose: !!els.showClose.checked }, false); render(); });
  if (els.showMeta) els.showMeta.addEventListener('change', () => { saveSettings({ showMeta: !!els.showMeta.checked }); render(); });
  if (els.fullTitle) els.fullTitle.addEventListener('change', () => { const on = !!els.fullTitle.checked; saveSettings({ fullTitle: on }); document.body.classList.toggle('full-title', on); render(); });
  if (els.filter) els.filter.addEventListener('input', debounce(() => { saveSettings({ filterText: els.filter.value }, false); render(); }));
  if (els.refresh) els.refresh.addEventListener('click', () => { clearSelection(); forceFaviconRefresh(); renderInfoOnly(); });
  
  if (els.deleteSelectedBtn) {
      els.deleteSelectedBtn.addEventListener('click', async () => {
          if (els.deleteSelectedBtn.disabled) return;
          // Usuń zaznaczone grupy
          if (selectedGroupIds && selectedGroupIds.size) {
              const gids = Array.from(selectedGroupIds);
              for (const gid of gids) {
                  try {
                      const tabs = await chrome.tabs.query({ windowId: lastWinId });
                      const ids = tabs.filter(t => t.groupId === gid && !t.pinned).map(t => t.id);
                      if (ids.length) await chrome.tabs.remove(ids);
                  } catch {}
              }
              selectedGroupIds.clear();
              saveGroupSelection();
          }
          // Usuń zaznaczone kafle (te, które nie zostały usunięte z grupami)
          if (selectedIds && selectedIds.size) {
              const ids = Array.from(selectedIds);
              if (ids.length) await chrome.tabs.remove(ids);
              selectedIds.clear();
              saveSelection();
          }
          renderInfoOnly();
      });
  }

  // Obsługa przycisków grupowych
  if (els.btnGroupNew) {
      els.btnGroupNew.addEventListener('click', async () => {
          if (els.btnGroupNew.disabled) return;
          
          // Zbierz wszystkie zaznaczone ID (kafle + kafle z grup)
          const idsSet = new Set();
          if (selectedIds) selectedIds.forEach(id => idsSet.add(id));
          if (selectedGroupIds && selectedGroupIds.size) {
              try {
                  const tabs = await chrome.tabs.query({ windowId: lastWinId });
                  for (const t of tabs) {
                      if (t.groupId >= 0 && selectedGroupIds.has(t.groupId) && !t.pinned) idsSet.add(t.id);
                  }
              } catch {}
          }
          
          if (idsSet.size > 0) {
              openGroupDialog(null, Array.from(idsSet), els.btnGroupNew);
          }
      });
  }

  if (els.btnGroupProps) {
      els.btnGroupProps.addEventListener('click', () => {
          if (els.btnGroupProps.disabled) return;
          if (selectedGroupIds && selectedGroupIds.size === 1) {
              const gid = Array.from(selectedGroupIds)[0];
              openGroupDialog(gid, [], els.btnGroupProps);
          }
      });
  }

  // Menu: Przenieś
  if (els.btnGroupMove) {
      els.btnGroupMove.addEventListener('click', (e) => {
          e.stopPropagation();
          if (els.btnGroupMove.disabled) return;
          const open = els.menuGroupMove.style.display === 'block';
          document.querySelectorAll('.menu').forEach(m => m.style.display = 'none'); // zamknij inne
          if (!open) {
              els.menuGroupMove.style.display = 'block';
              populateMoveMenu();
          }
      });
  }

  // Menu: Lista
  if (els.btnGroupList) {
      els.btnGroupList.addEventListener('click', (e) => {
          e.stopPropagation();
          const open = els.menuGroupList.style.display === 'block';
          document.querySelectorAll('.menu').forEach(m => m.style.display = 'none'); // zamknij inne
          if (!open) {
              els.menuGroupList.style.display = 'block';
              populateListMenu();
          }
      });
  }

  // Zamykanie menu na klik na zewnątrz
  if (els.btnAccentColor) {
      els.btnAccentColor.addEventListener('click', (e) => {
          e.stopPropagation();
          const open = els.menuAccentColor.style.display === 'block';
          document.querySelectorAll('.menu').forEach(m => m.style.display = 'none');
          if (!open) {
              els.menuAccentColor.style.display = 'block';
              populateAccentMenu();
          }
      });
  }

  document.addEventListener('click', (e) => {
      if (!e.target.closest('.menu') && !e.target.closest('.btn')) {
          document.querySelectorAll('.menu').forEach(m => m.style.display = 'none');
      }
  });
}


// Media indicator (🔊/🔈/🎬) + mruganie obwódki (CSS w kolejnym kroku)
const mediaState = new Map();

function applyMediaToTile(tabId) {
  try {
    const st = mediaState.get(tabId) || { playing:false, kind:'none', tabMuted:false };
    const tile = els.grid.querySelector(`.tile[data-id="${tabId}"]`);
    if (!tile) return;
    const titleEl = tile.querySelector('.title');
    if (!titleEl) return;
    titleEl.classList.remove('muted');

    let ico = titleEl.querySelector('.media-ico');
    if (!ico && st.kind !== 'none') {
      ico = document.createElement('button');
      ico.className = 'btn-icon media-ico';
      ico.style.marginRight = '4px';
      ico.title = 'Wycisz/Włącz dźwięk';
      ico.addEventListener('click', (e) => {
        e.stopPropagation();
        const cur = mediaState.get(tabId) || { tabMuted:false };
        try { chrome.tabs.update(tabId, { muted: !cur.tabMuted }); } catch {}
      });
      titleEl.prepend(ico);
    }

    const sym =
      st.kind === 'audio' ? '🔊' :
      st.kind === 'muted' ? '🔈' :
      st.kind === 'video' ? '🎬' : '';

    if (ico) {
      if (sym) {
        ico.textContent = sym;
        ico.style.display = '';
        ico.setAttribute('aria-label', sym === '🔊' ? 'Wycisz kartę' : 'Włącz dźwięk');
      } else {
        ico.remove();
      }
    } else if (sym) {
      // jeżeli brak ico i jest symbol, wstaw od nowa
      const btn = document.createElement('button');
      btn.className = 'btn-icon media-ico';
      btn.style.marginRight = '4px';
      btn.title = 'Wycisz/Włącz dźwięk';
      btn.textContent = sym;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const cur = mediaState.get(tabId) || { tabMuted:false };
        try { chrome.tabs.update(tabId, { muted: !cur.tabMuted }); } catch {}
      });
      titleEl.prepend(btn);
    }

    tile.classList.toggle('media-active', !!st.playing);
  } catch {}
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== 'MEDIA_STATE_UPDATE') return;
  const tabId = Number(msg.tabId);
  if (!tabId) return;

  mediaState.set(tabId, {
    playing: !!msg.playing,
    kind: String(msg.kind || 'none'),
    tabMuted: !!msg.tabMuted
  });

  applyMediaToTile(tabId);
  
  // Jeśli karta należy do zamkniętej grupy -> wymuś render, żeby zapalić lidera
  // (Sprawdzamy w DOM, czy mamy lidera tej grupy, ale prościej po prostu odświeżyć)
  // Dla optymalizacji: render() tylko jeśli mamy collapsedGroupIds.
  if (collapsedGroupIds && collapsedGroupIds.size > 0) {
      render();
  }
});


/* // Init */
function init() {
  loadSettings(() => {
    applyCSSVarsAll();

    // Pre‑sync: dopasuj collapsed/hidden do stanu przeglądarki zanim zrobimy pierwszy render
    try {
      chrome.windows.getLastFocused({ populate: false }, (win) => {
        const proceed = () => {
          bindUI();
          render();
          attachLiveListeners();
          setupMiddleClickAutoscroll();
          initRestoreUI();
          initHelpUITop();
          initSmartTooltip();
          initGroupDialog();
          attachKeepAlive();
          attachMRUCommitListeners();
        };

        if (!win || typeof win.id !== 'number') { proceed(); return; }
        lastWinId = win.id;

        try {
          chrome.tabGroups.query({ windowId: win.id }, (groups) => {
            if (!groups) { proceed(); return; }

            let dirtyColl = false, dirtyHid = false;
            const present = new Set(groups.map(g => g.id));

            for (const g of groups) {
              if (g.collapsed) {
                if (!collapsedGroupIds.has(g.id)) { collapsedGroupIds.add(g.id); dirtyColl = true; }
              } else {
                if (collapsedGroupIds.delete(g.id)) dirtyColl = true;
                if (hiddenGroupIds && hiddenGroupIds.delete && hiddenGroupIds.delete(g.id)) dirtyHid = true;
              }
            }
            // usuń z lokalnych stanów grupy nieobecne w tym oknie
            for (const gid of [...collapsedGroupIds]) {
              if (!present.has(gid)) { collapsedGroupIds.delete(gid); dirtyColl = true; }
            }
            for (const gid of [...(hiddenGroupIds || [])]) {
              if (!present.has(gid)) { hiddenGroupIds.delete(gid); dirtyHid = true; }
            }

            if (dirtyColl) saveCollapsedGroups();
            if (dirtyHid) saveHiddenGroups();

            proceed();
          });
        } catch {
          proceed();
        }
      });
    } catch {
      // Fallback: gdyby coś poszło nie tak, jedziemy starym torem
      bindUI();
      render();
      attachLiveListeners();
      setupMiddleClickAutoscroll();
      initRestoreUI();
      initHelpUITop();
      initSmartTooltip();
	  initGroupDialog();
      attachKeepAlive();
      attachMRUCommitListeners();
    }
  });
}
init();



