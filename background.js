// LastTAB-return — powrót po zamknięciu aktywnej karty
// - Stabilny MRU (ignoruje auto-aktywację sąsiada po zamknięciu)
// - Opcjonalne ignorowanie kart przypiętych
// - Otwieranie siatki kart (switcher) z opcją automatycznego przypięcia
// - Blokada „zahaczonych” sąsiadów przy NATYWNYM zamykaniu (X/ŚPM/Ctrl+W): guard + stop/pause (bez mute), spec-URL -> discard

const DEFAULT_DEPTH = 10;
const ACTIVATE_COMMIT_DELAY_MS = 150;
const DEFAULT_IGNORE_PINNED = false;
const DEFAULT_AUTOPIN_SWITCHER = true;
const MAX_STACK_CAP = 51;

// 4 punkty zamknięcia — parametry
const WILL_CLOSE_TTL_MS = 2000;   // ważność sygnału "zaraz się zamknę"
const PLAY_GUARD_MS = 2000;       // jak długo działa strażnik pause-on-play na sąsiadach (bez mute)

let depth = DEFAULT_DEPTH;
let ignorePinned = DEFAULT_IGNORE_PINNED;
let autoPinSwitcher = DEFAULT_AUTOPIN_SWITCHER;

// MRU i stan per okno
const mruByWindow = new Map();        // winId -> [tabId,...], 0 = najnowsza faktycznie użyta
const activeByWindow = new Map();     // winId -> aktualnie aktywna wg naszego "commita"
const pendingActivation = new Map();  // winId -> {timer, tabId, previousTabId, ts}

const SWITCHER_URL = chrome.runtime.getURL('switcher.html');
const realActiveByWindow = new Map();     // rzeczywiście aktywna karta (w tym pinned/switcher)
const switcherActiveByWindow = new Map(); // czy aktualnie aktywna to switcher
const prevActiveByWindow = new Map();     // winId -> tabId|null

// Dodatkowe mapy dla blokady sąsiadów
const lastOrderByWindow = new Map();      // winId -> [tabId,...] (po index)
const willCloseNeighbors = new Map();     // closingTabId -> { winId, neighbors:[left,right], ts }


// Helpers
function clampDepth(v) {
  v = Number(v);
  if (!Number.isFinite(v)) return DEFAULT_DEPTH;
  return Math.max(0, Math.min(50, Math.floor(v)));
}
function mapUiDepth(v) {
  const ui = clampDepth(v);
  return ui === 0 ? 0 : Math.min(51, ui + 1);
}
function getStack(winId) {
  let s = mruByWindow.get(winId);
  if (!s) { s = []; mruByWindow.set(winId, s); }
  return s;
}
function removeFromStack(stack, tabId) {
  const i = stack.indexOf(tabId);
  if (i !== -1) stack.splice(i, 1);
}
function moveToFront(stack, tabId) {
  removeFromStack(stack, tabId);
  if (depth === 0) return;
  stack.unshift(tabId);
  if (stack.length > MAX_STACK_CAP) stack.length = MAX_STACK_CAP;
}
function pruneStacksRemovePinned() {
  if (!ignorePinned) return;
  chrome.tabs.query({}, (tabs) => {
    const pinnedSet = new Set(tabs.filter(t => t.pinned).map(t => t.id));
    for (const [winId, stack] of mruByWindow) {
      const filtered = stack.filter(id => !pinnedSet.has(id));
      mruByWindow.set(winId, filtered);
      if (pinnedSet.has(activeByWindow.get(winId))) {
        activeByWindow.delete(winId);
      }
    }
  });
}

// --- MRU: trwałość w chrome.storage.session (przetrwa ubicia SW do końca sesji) ---
function persistMRUToSession() {
  try {
    const obj = {};
    for (const [winId, stack] of mruByWindow) obj[winId] = stack.slice();
    chrome.storage.session.set({ mruStacks: obj }, () => {});
  } catch {}
}
// Odtwórz MRU; cb(restored:boolean)
function restoreMRUFromSession(cb) {
  chrome.storage.session.get('mruStacks', (res) => {
    const saved = res && res.mruStacks;
    if (!saved || typeof saved !== 'object') { cb && cb(false); return; }
    chrome.tabs.query({}, (tabs) => {
      const byWin = new Map();
      const byId = new Map();
      for (const t of tabs || []) {
        if (!byWin.has(t.windowId)) byWin.set(t.windowId, new Set());
        byWin.get(t.windowId).add(t.id);
        byId.set(t.id, t);
      }
      let restored = 0;
      for (const k of Object.keys(saved)) {
        const winId = Number(k);
        const present = byWin.get(winId);
        if (!present) continue;
        const ids = (saved[k] || []).map(Number).filter(Boolean);
        const arr = [];
        for (const id of ids) {
          if (!present.has(id)) continue;
          const t = byId.get(id);
          if (ignorePinned && t && t.pinned) continue;
          arr.push(id);
        }
        if (arr.length) {
          if (arr.length > MAX_STACK_CAP) arr.length = MAX_STACK_CAP;
          mruByWindow.set(winId, arr);
          restored++;
        }
      }
      cb && cb(restored > 0);
    });
  });
}
// Uzupełnij active* na podstawie aktualnie aktywnych kart; nie psuj MRU
function warmActiveStatesFromCurrentActives(cb) {
  chrome.tabs.query({ active: true }, (tabs) => {
    for (const t of tabs || []) {
      realActiveByWindow.set(t.windowId, t.id);
      activeByWindow.set(t.windowId, t.id);
      const s = getStack(t.windowId);
      if (!s.includes(t.id)) s.unshift(t.id);
    }
    cb && cb();
  });
}

// --- Utrzymuj ostatni porządek kart (po index) per okno ---
function refreshOrder(winId) {
  if (typeof winId !== 'number') return;
  chrome.tabs.query({ windowId: winId }, (tabs) => {
    if (chrome.runtime.lastError || !tabs) return;
    tabs.sort((a, b) => a.index - b.index);
    lastOrderByWindow.set(winId, tabs.map(t => t.id));
  });
}
function neighborsFromSnapshot(winId, closingId) {
  const order = lastOrderByWindow.get(winId) || [];
  const i = order.indexOf(closingId);
  const left = i > 0 ? order[i - 1] : null;
  const right = (i >= 0 && i < order.length - 1) ? order[i + 1] : null;
  return [left, right];
}
function pruneWillClose() {
  const now = Date.now();
  for (const [k, v] of willCloseNeighbors) {
    if (!v || (now - (v.ts || 0)) > WILL_CLOSE_TTL_MS) willCloseNeighbors.delete(k);
  }
}

// --- Blokada sąsiadów: CS guard/stop (bez mute), fallback discard ---
function isSpecialScheme(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'chrome:' || u.protocol === 'chrome-extension:' || u.protocol === 'edge:' || u.protocol === 'about:' || u.protocol === 'brave:';
  } catch { return false; }
}
function sendMsg(tabId, msg) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, msg, (resp) => {
      if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
      resolve(resp);
    });
  });
}
async function armNeighbors(winId, closingId, preset = null) {
  const [l, r] = preset || neighborsFromSnapshot(winId, closingId);
  const ids = [l, r].filter(Boolean);
  for (const id of ids) {
    try {
      const t = await chrome.tabs.get(id);
      if (!isSpecialScheme(t.url || '')) {
        await sendMsg(id, { type: 'NEIGHBOR_ARM_GUARD', ttlMs: PLAY_GUARD_MS });
      }
    } catch {}
  }
}
async function stopNeighbors(winId, closingId, excludeId = null, preset = null) {
  const [l, r] = preset || neighborsFromSnapshot(winId, closingId);
  const ids = [l, r].filter(Boolean);
  for (const id of ids) {
    if (excludeId && id === excludeId) continue;
    try {
      const t = await chrome.tabs.get(id);
      if (isSpecialScheme(t.url || '')) {
        try { await chrome.tabs.discard(id); } catch {}
      } else {
        await sendMsg(id, { type: 'NEIGHBOR_STOP_NOW', ttlMs: PLAY_GUARD_MS });
      }
    } catch {
      // Brak CS (CSP/strona spec) — spróbuj discard
      try { await chrome.tabs.discard(id); } catch {}
    }
  }
}


// Pewne przełączenie na target po zamknięciu (przebija auto‑aktywację sąsiada)
function ensureActive(winId, targetTabId) {
  const delays = [0, 120, 240, 360]; // 0ms, 120ms, 320ms
  let cancelled = false;

  const tryOnce = (i) => {
    if (cancelled || i >= delays.length) return;
    setTimeout(async () => {
      try {
        // jeśli target zniknął — kończ
        const t = await chrome.tabs.get(targetTabId);
        if (!t || t.windowId !== winId) return;

        const act = await chrome.tabs.query({ windowId: winId, active: true });
        const currentId = act && act[0] ? act[0].id : null;
        if (currentId === targetTabId) return; // już OK

        await chrome.tabs.update(targetTabId, { active: true });
      } catch (e) {
        // target mógł zniknąć
        return;
      }
      tryOnce(i + 1);
    }, delays[i]);
  };

  tryOnce(0);
}

// MRU commit
function commitActivation(winId, tabId) {
  chrome.tabs.get(tabId, (t) => {
    if (chrome.runtime.lastError) return; // karta mogła zniknąć
    if (ignorePinned && t.pinned) return; // ignorujemy przypięte
    moveToFront(getStack(winId), tabId);
    activeByWindow.set(winId, tabId);
    persistMRUToSession();
  });
}

function scheduleActivation(winId, tabId, previousTabId) {
  const pending = pendingActivation.get(winId);
  if (pending) clearTimeout(pending.timer);

  const ts = Date.now();
  const timer = setTimeout(() => {
    const p = pendingActivation.get(winId);
    if (!p || p.tabId !== tabId) return;
    pendingActivation.delete(winId);
    // minimalny czas aktywności (eliminuje "zahaczenia")
    const elapsed = Date.now() - (p.ts || ts);
    if (elapsed < 300) {
      const left = 300 - elapsed;
      const t2 = setTimeout(() => {
        const q = pendingActivation.get(winId);
        if (!q || q.tabId !== tabId) return;
        pendingActivation.delete(winId);
        commitActivation(winId, tabId);
      }, left);
      pendingActivation.set(winId, { ...p, timer: t2 });
      return;
    }
    commitActivation(winId, tabId);
  }, ACTIVATE_COMMIT_DELAY_MS);

  pendingActivation.set(winId, { timer, tabId, previousTabId, ts });
}

// Inicjalizacja MRU: tylko aktywne, nieprzypięte
function initStacksFromActiveTabs() {
  chrome.tabs.query({ active: true }, (tabs) => {
    for (const t of tabs) {
      if (ignorePinned && t.pinned) continue;
      mruByWindow.set(t.windowId, [t.id]);
      activeByWindow.set(t.windowId, t.id);
      realActiveByWindow.set(t.windowId, t.id);
    }
  });
}

// Zdarzenia kart
chrome.tabs.onActivated.addListener(({ tabId, windowId, previousTabId }) => {
  // Zapisz realnie aktywną (niezależnie od pinned)
  realActiveByWindow.set(windowId, tabId);
  if (typeof previousTabId === 'number') {
    prevActiveByWindow.set(windowId, previousTabId);
  }
  // Zaktualizuj flagę — czy aktywna to nasz switcher
  chrome.tabs.get(tabId, (t) => {
    if (!chrome.runtime.lastError) {
      switcherActiveByWindow.set(windowId, t.url === SWITCHER_URL);
    }
  });

  // MRU + porządek kart
  scheduleActivation(windowId, tabId, previousTabId);
  refreshOrder(windowId);
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if ('pinned' in changeInfo) {
    if (changeInfo.pinned === true) {
      removeFromStack(getStack(tab.windowId), _tabId);
      if (activeByWindow.get(tab.windowId) === _tabId) {
        activeByWindow.delete(tab.windowId);
      }
    }
  }

  // Mirror stanu audio: muted/audible → broadcast do UI
  try {
    const cache = (globalThis.__mediaCache || (globalThis.__mediaCache = new Map()));
    let entry = cache.get(_tabId);
    if (!entry) { entry = { frames: new Map(), tabMuted: false, tabAudible: false }; cache.set(_tabId, entry); }

    let dirty = false;
    if (changeInfo && typeof changeInfo.audible === 'boolean') {
      entry.tabAudible = !!changeInfo.audible;
      dirty = true;
    }
    if (changeInfo && changeInfo.mutedInfo && typeof changeInfo.mutedInfo.muted === 'boolean') {
      entry.tabMuted = !!changeInfo.mutedInfo.muted;
      dirty = true;
    }

    if (dirty) {
      let anyAud = !!entry.tabAudible, anyMuted = false, anyVideo = false;
      for (const st of entry.frames.values()) {
        if (st.playingAudible) anyAud = true;
        if (st.playingMuted)   anyMuted = true;
        if (st.videoPlaying)   anyVideo = true;
      }
      const playing = anyAud || anyMuted || anyVideo;
      const tabMuted = !!entry.tabMuted;
      const kind = playing
        ? (anyAud && !tabMuted ? 'audio' : (tabMuted || anyMuted ? 'muted' : 'video'))
        : 'none';

      try {
        chrome.runtime.sendMessage({
          type: 'MEDIA_STATE_UPDATE',
          tabId: _tabId,
          playing,
          kind,        // 'audio' | 'muted' | 'video' | 'none'
          tabMuted
        });
      } catch {}
    }
  } catch {}

  refreshOrder(tab.windowId);
});

chrome.tabs.onCreated.addListener((tab) => {
  refreshOrder(tab.windowId);
});

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  const winId = removeInfo.windowId;

  if (removeInfo.isWindowClosing) {
    const pending = pendingActivation.get(winId);
    if (pending) clearTimeout(pending.timer);
    pendingActivation.delete(winId);
    mruByWindow.delete(winId);
    activeByWindow.delete(winId);
    realActiveByWindow.delete(winId);
    switcherActiveByWindow.delete(winId);
    willCloseNeighbors.delete(tabId);
    try { const c = globalThis.__mediaCache; if (c && c.delete) c.delete(tabId); } catch {}
    refreshOrder(winId);
    return;
  }

  // Anuluj ewentualny auto-commit po zamknięciu
  const pending = pendingActivation.get(winId);
  if (pending && pending.previousTabId === tabId) {
    clearTimeout(pending.timer);
    pendingActivation.delete(winId);
  }

  try { const c = globalThis.__mediaCache; if (c && c.delete) c.delete(tabId); } catch {}

  const stack = getStack(winId);
  const idx = stack.indexOf(tabId);
  const candidateFromStack = idx !== -1 ? stack[idx + 1] : null;
  if (idx !== -1) { stack.splice(idx, 1); persistMRUToSession(); }// zawsze czyść MRU z zamykanej

  const realActive = realActiveByWindow.get(winId);
  const isSwitcherActive = switcherActiveByWindow.get(winId) === true;

  if (isSwitcherActive && tabId !== realActive) {
    refreshOrder(winId);
    willCloseNeighbors.delete(tabId);
    return;
  }

  const wasActive = (realActive === tabId)
    || (prevActiveByWindow.get(winId) === tabId)
    || willCloseNeighbors.has(tabId);
  if (!wasActive) { refreshOrder(winId); willCloseNeighbors.delete(tabId); return; }
  if (depth === 0) { refreshOrder(winId); willCloseNeighbors.delete(tabId); return; }
  
  // 3) Wybór celu (MRU -> fallback)
  chrome.tabs.query({ windowId: winId }, async (tabs) => {
    const pool = ignorePinned ? tabs.filter(t => !t.pinned) : tabs;
    const present = new Set(pool.map(t => t.id));

    // Używaj tylko pierwszych "depth" wpisów MRU (bez fizycznego przycinania), z twardym cap 51
    const effLimit = depth === 0 ? 0 : Math.max(2, depth);
    if (stack.length > MAX_STACK_CAP) stack.length = MAX_STACK_CAP;
    const limited = effLimit ? stack.slice(0, Math.min(effLimit, MAX_STACK_CAP)) : [];
    const allowed = new Set(limited);

    let target = null;
    if (candidateFromStack && present.has(candidateFromStack) && allowed.has(candidateFromStack)) {
      target = candidateFromStack;
    } else {
      for (const id of limited) {
        if (present.has(id)) { target = id; break; }
      }
    }

    // Fallback: „drugi po lastAccessed” w oknie (z pominięciem auto‑aktywowanego sąsiada)
    if (!target && pool.length) {
      const nowActiveId = (tabs.find(t => t.active) || {}).id || null;
      let best = null;
      for (const t of pool) {
        if (nowActiveId && t.id === nowActiveId) continue;
        if (!best || (t.lastAccessed || 0) > (best.lastAccessed || 0)) best = t;
      }
      if (best) target = best.id;
    }

    const preset = willCloseNeighbors.get(tabId)?.neighbors || null;
    if (target) {
      await stopNeighbors(winId, tabId, target, preset);
      willCloseNeighbors.delete(tabId);
      ensureActive(winId, target);
      refreshOrder(winId);
    } else {
      await stopNeighbors(winId, tabId, null, preset);
      willCloseNeighbors.delete(tabId);
      refreshOrder(winId);
    }
  });
});


// Przenoszenie między oknami
chrome.tabs.onDetached.addListener((tabId, { oldWindowId }) => {
  removeFromStack(getStack(oldWindowId), tabId);
  const pending = pendingActivation.get(oldWindowId);
  if (pending && pending.tabId === tabId) {
    clearTimeout(pending.timer);
    pendingActivation.delete(oldWindowId);
  }
  if (activeByWindow.get(oldWindowId) === tabId) {
    activeByWindow.delete(oldWindowId);
  }
  refreshOrder(oldWindowId);
  persistMRUToSession();
});
chrome.tabs.onAttached.addListener((_tabId, info) => {
  if (info && typeof info.newWindowId === 'number') refreshOrder(info.newWindowId);
});

// Ignorujemy przesunięcia (MRU po ID, nie po indeksach) — ale odświeżaj porządek
chrome.tabs.onMoved.addListener((_tabId, moveInfo) => {
  if (moveInfo && typeof moveInfo.windowId === 'number') refreshOrder(moveInfo.windowId);
});

// Zmiana ustawień
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  if (changes.depth) {
    depth = mapUiDepth(changes.depth.newValue);
    // Nie przycinamy ani nie czyścimy MRU na zmianę ustawienia.
    // depth=0 wyłącza tylko zapisywanie (moveToFront) i reakcję na zamknięcie aktywnej.
    persistMRUToSession();
  }
  if (changes.ignorePinned) {
    ignorePinned = !!changes.ignorePinned.newValue;
    pruneStacksRemovePinned();
    persistMRUToSession();
  }
  if (changes.autoPinSwitcher) {
    autoPinSwitcher = !!changes.autoPinSwitcher.newValue;
  }
});

// Sprzątanie po zamknięciu okna
chrome.windows.onRemoved.addListener((winId) => {
  const pending = pendingActivation.get(winId);
  if (pending) clearTimeout(pending.timer);
  pendingActivation.delete(winId);
  mruByWindow.delete(winId);
  activeByWindow.delete(winId);
  realActiveByWindow.delete(winId);
  switcherActiveByWindow.delete(winId);
  prevActiveByWindow.delete(winId);
  lastOrderByWindow.delete(winId);
  persistMRUToSession();
});

// Otwieranie siatki kart (z przypięciem i re-use jeśli istnieje)
async function openSwitcher() {
  const url = chrome.runtime.getURL('switcher.html');
  try {
    const win = await chrome.windows.getLastFocused({ populate: false });
    const tabs = await chrome.tabs.query({ windowId: win.id, url });
    if (tabs && tabs.length) {
      const t = tabs[0];
      await chrome.windows.update(t.windowId, { focused: true });
      await chrome.tabs.update(t.id, { active: true, pinned: autoPinSwitcher ? true : t.pinned });
    } else {
      await chrome.tabs.create({ windowId: win.id, url, pinned: !!autoPinSwitcher });
    }
  } catch (e) {
    // fallback gdy brak aktywnego okna
    await chrome.tabs.create({ url, pinned: !!autoPinSwitcher });
  }
}

chrome.action.onClicked.addListener(openSwitcher);
chrome.commands.onCommand.addListener((cmd) => {
  if (cmd === 'open-switcher') openSwitcher();
});

// CS/Strony rozszerzenia: sygnały (zamknięcie/aktywacja)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  // CS: sygnał „zaraz się zamknę” (pre‑arm guard, bez przełączania)
  if (msg.type === 'TAB_WILL_CLOSE' && sender?.tab?.id && sender.tab.windowId !== undefined) {
    const closingId = sender.tab.id;
    const winId = sender.tab.windowId;
    pruneWillClose();
    const [l, r] = neighborsFromSnapshot(winId, closingId);
    willCloseNeighbors.set(closingId, { winId, neighbors: [l, r], ts: Date.now() });
    armNeighbors(winId, closingId, [l, r]).then(() => {
      sendResponse && sendResponse({ ok: true });
    });
    return true; // async
  }

  // ACTIVE_COMMIT: potwierdzenie aktywacji z żywego kontekstu (CS lub switcher.html)
  if (msg.type === 'ACTIVE_COMMIT') {
    (async () => {
      try {
        const tabId = Number(msg.tabId) || (sender?.tab?.id ?? 0);
        const windowId = Number(msg.windowId) || (sender?.tab?.windowId ?? 0);
        if (!tabId || !windowId) { sendResponse && sendResponse({ ok: false, reason: 'no_ids' }); return; }

        // Tylko jeśli nadal jest aktywna
        const [tInfoList, actList] = await Promise.all([
          chrome.tabs.get(tabId).then(t => [t]).catch(() => []),
          chrome.tabs.query({ windowId, active: true }).catch(() => [])
        ]);
        const tInfo = tInfoList[0];
        const actId = actList && actList[0] ? actList[0].id : null;
        if (!tInfo || tInfo.windowId !== windowId || actId !== tabId) { sendResponse && sendResponse({ ok: false, reason: 'not_active' }); return; }

        // Commit MRU (z poszanowaniem ignorePinned) i skasuj ewentualny pending
        commitActivation(windowId, tabId);
        const pending = pendingActivation.get(windowId);
        if (pending) { clearTimeout(pending.timer); pendingActivation.delete(windowId); }

        sendResponse && sendResponse({ ok: true });
      } catch (e) {
        sendResponse && sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true; // async
  }

  // MEDIA_STATE: stan odtwarzania z CS (agregacja po frameId) → broadcast do UI
  if (msg.type === 'MEDIA_STATE') {
    try {
      const tabId = sender?.tab?.id;
      const frameId = (typeof sender?.frameId === 'number') ? sender.frameId : -1;
      if (!tabId) { try { sendResponse && sendResponse({ ok:false, reason:'no_tab' }); } catch {} return; }

      const cache = (globalThis.__mediaCache || (globalThis.__mediaCache = new Map()));
      let entry = cache.get(tabId);
      if (!entry) { entry = { frames: new Map(), tabMuted: false, lastSig: '' }; cache.set(tabId, entry); }

      entry.frames.set(frameId, {
        playingAudible: !!msg.playingAudible,
        playingMuted:   !!msg.playingMuted,
        videoPlaying:   !!msg.videoPlaying,
        ts: Date.now()
      });

      let anyAud = false, anyMuted = false, anyVideo = false;
      for (const st of entry.frames.values()) {
        if (st.playingAudible) anyAud = true;
        if (st.playingMuted)   anyMuted = true;
        if (st.videoPlaying)   anyVideo = true;
      }
      const playing = anyAud || anyMuted || anyVideo;
      const tabMuted = !!entry.tabMuted;
      const kind = playing
        ? (anyAud && !tabMuted ? 'audio' : (anyMuted || tabMuted ? 'muted' : 'video'))
        : 'none';

      const sig = `${playing?'1':'0'}|${kind}|${tabMuted?'1':'0'}`;
      if (sig !== entry.lastSig) {
        entry.lastSig = sig;
        try {
          chrome.runtime.sendMessage({
            type: 'MEDIA_STATE_UPDATE',
            tabId,
            playing,
            kind,        // 'audio' | 'muted' | 'video' | 'none'
            tabMuted
          });
        } catch {}
      }

      try { sendResponse && sendResponse({ ok:true }); } catch {}
    } catch (e) {
      try { sendResponse && sendResponse({ ok:false, error:String(e) }); } catch {}
    }
    return; // bez async
  }

  // KEEPALIVE_PING: nic nie robimy – samo odebranie budzi SW
  if (msg.type === 'KEEPALIVE_PING') {
    try { sendResponse && sendResponse({ ok: true, pong: Date.now() }); } catch {}
    return; // bez async
  }
});

// Init
(function init() {
  chrome.storage.sync.get(
    { depth: DEFAULT_DEPTH, ignorePinned: DEFAULT_IGNORE_PINNED, autoPinSwitcher: DEFAULT_AUTOPIN_SWITCHER },
    (res) => {
      depth = mapUiDepth(res.depth);
      ignorePinned = !!res.ignorePinned;
      autoPinSwitcher = !!res.autoPinSwitcher;

      // 1) Spróbuj odtworzyć MRU z chrome.storage.session
      restoreMRUFromSession((restored) => {
        // 2) Uzupełnij stany aktywne; jeśli nie było MRU – zainicjalizuj z aktywnych
        const proceed = () => {
          pruneStacksRemovePinned();
          // od razu pobierz porządek kart dla wszystkich okien
          chrome.windows.getAll({ populate: false }, (wins) => {
            for (const w of wins || []) refreshOrder(w.id);
          });
        };
        if (restored) {
          warmActiveStatesFromCurrentActives(() => { persistMRUToSession(); proceed(); });
        } else {
          initStacksFromActiveTabs();
          persistMRUToSession();
          proceed();
        }
      });
    }
  );
})();