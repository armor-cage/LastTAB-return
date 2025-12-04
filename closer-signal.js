// CS: sygnał „zaraz się zamknę” + lokalny guard/stop na żądanie tła
// - Bez UI, bez modyfikacji DOM.
// - Na stronach specjalnych (chrome://, PDF) CS nie działa — tło użyje discard().

(function () {
  const IS_TOP = (window === window.top);

  // sygnał pre-arm (Faza A) — emitowany również przy reload; tło odróżni w onRemoved
  let sent = false;
  function pingWillClose() {
    if (sent) return;
    sent = true;
    try { chrome.runtime.sendMessage({ type: 'TAB_WILL_CLOSE', ts: Date.now() }); } catch {}
  }
  window.addEventListener('beforeunload', pingWillClose, { capture: true });
  window.addEventListener('pagehide', (e) => { if (!e.persisted) pingWillClose(); }, { capture: true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') setTimeout(pingWillClose, 0);
  }, { capture: true });

  // --- ACTIVE_COMMIT z żywego kontekstu (Etap 2) ---
  // Pingi MRU tylko z top-frame (unikamy spamu z iframów)
  if (IS_TOP) {
    const COMMIT_DELAY_MS = 300;
    let commitTimer = 0;

    function scheduleActiveCommit(why) {
      try { clearTimeout(commitTimer); } catch {}
      commitTimer = setTimeout(() => {
        try { chrome.runtime.sendMessage({ type: 'ACTIVE_COMMIT', ts: Date.now(), why: String(why || '') }); } catch {}
      }, COMMIT_DELAY_MS);
    }
    function cancelActiveCommit() {
      try { clearTimeout(commitTimer); } catch {}
      commitTimer = 0;
    }

    // Na starcie, jeśli już widoczna karta – zbroimy delikatny ping
    if (document.visibilityState === 'visible') {
      setTimeout(() => scheduleActiveCommit('init-visible'), 0);
    }

    // Widoczność / fokus budzą commit
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') scheduleActiveCommit('visible');
      else cancelActiveCommit();
    }, true);
    window.addEventListener('focus', () => scheduleActiveCommit('focus'), true);
    window.addEventListener('pageshow', () => scheduleActiveCommit('pageshow'), true);

    // Ukrycie/opuszczenie/wyjście – anuluj oczekujący commit
    window.addEventListener('blur', () => cancelActiveCommit(), true);
    window.addEventListener('beforeunload', () => cancelActiveCommit(), { capture: true });
    window.addEventListener('pagehide', () => cancelActiveCommit(), { capture: true });
  }

  // strażnik „pause-on-play” (bez mute)
  let guardUntil = 0;
  function armGuard(ttlMs) {
    const until = Date.now() + Math.max(0, Number(ttlMs) || 0);
    guardUntil = Math.max(guardUntil, until);
  }
  document.addEventListener('play', (ev) => {
    if (Date.now() <= guardUntil) {
      try { ev.target.pause(); } catch {}
    }
  }, true);

  function stopNow(ttlMs) {
    try { window.stop(); } catch {}
    try {
      const media = document.querySelectorAll('video, audio');
      for (const m of media) { try { m.pause(); } catch {} }
    } catch {}
    if (ttlMs) armGuard(ttlMs);
  }

  // MEDIA PLUS: wykrywanie audio/wideo i ping do tła (all_frames)
  let __mediaPingTimer = 0;
  let __lastMediaSig = '';
  const MEDIA_DEBOUNCE_MS = 250;

  function computeMediaState() {
    try {
      const media = document.querySelectorAll('audio, video');
      let playingAudible = false, playingMuted = false, videoPlaying = false;
      media.forEach((m) => {
        try {
          const tag = (m.tagName || '').toLowerCase();
          const isPlaying = !m.paused && !m.ended && m.readyState >= 2;
          if (!isPlaying) return;
          const isMuted = !!m.muted || (typeof m.volume === 'number' && m.volume === 0);
          if (tag === 'video') videoPlaying = true;
          if (isMuted) playingMuted = true; else playingAudible = true;
        } catch {}
      });
      return { playingAudible, playingMuted, videoPlaying };
    } catch { return { playingAudible:false, playingMuted:false, videoPlaying:false }; }
  }

  function scheduleMediaPing(why) {
    try { clearTimeout(__mediaPingTimer); } catch {}
    __mediaPingTimer = setTimeout(() => {
      try {
        const st = computeMediaState();
        const sig = `${st.playingAudible?'1':'0'}|${st.playingMuted?'1':'0'}|${st.videoPlaying?'1':'0'}`;
        if (sig !== __lastMediaSig) {
          __lastMediaSig = sig;
          chrome.runtime.sendMessage({ type: 'MEDIA_STATE', ...st, why: String(why || ''), ts: Date.now() });
        }
      } catch {}
    }, MEDIA_DEBOUNCE_MS);
  }

  (['play','playing','pause','volumechange','ended','ratechange','loadeddata','emptied','suspend','stalled','waiting','seeking','seeked'])
    .forEach(ev => document.addEventListener(ev, () => scheduleMediaPing(ev), true));
  document.addEventListener('visibilitychange', () => scheduleMediaPing('visibility'), true);
  window.addEventListener('pageshow', () => scheduleMediaPing('pageshow'), true);
  setTimeout(() => scheduleMediaPing('init'), 0);

  // Polecenia z tła
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'NEIGHBOR_ARM_GUARD') {
      armGuard(msg.ttlMs || 0);
      try { sendResponse({ ok: true }); } catch {}
    } else if (msg.type === 'NEIGHBOR_STOP_NOW') {
      stopNow(msg.ttlMs || 0);
      try { sendResponse({ ok: true }); } catch {}
    }
  });
})();