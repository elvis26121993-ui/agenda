/*
 * Agenda de Voz — lógica de la app.
 * Todo se guarda en el propio teléfono (IndexedDB). No hay servidor ni cuentas.
 * Seguridad: nunca se usa innerHTML con datos del usuario; todo texto entra con textContent.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------- utilidades
  var $ = function (id) { return document.getElementById(id); };
  var LOCALE = 'es';
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parseYMD(s) { var p = s.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function addDays(d, n) { var r = new Date(d.getFullYear(), d.getMonth(), d.getDate()); r.setDate(r.getDate() + n); return r; }
  function todayStr() { return ymd(new Date()); }
  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  function fmtLong(s) {
    return cap(new Intl.DateTimeFormat(LOCALE, { weekday: 'long', day: 'numeric', month: 'long' }).format(parseYMD(s)));
  }
  function fmtMonth(d) { return cap(new Intl.DateTimeFormat(LOCALE, { month: 'long' }).format(d)) + ' ' + d.getFullYear(); }
  function fmtTime(t) {
    if (!t) return '';
    var h = +t.slice(0, 2), m = t.slice(3, 5);
    var suf = h < 12 ? 'a. m.' : 'p. m.';
    var h12 = h % 12 === 0 ? 12 : h % 12;
    return h12 + ':' + m + ' ' + suf;
  }
  function spokenTime(t) {
    var h = +t.slice(0, 2), m = +t.slice(3, 5);
    var part = h < 12 ? 'de la mañana' : h < 19 ? 'de la tarde' : 'de la noche';
    if (h === 0) part = 'de la madrugada';
    var h12 = h % 12 === 0 ? 12 : h % 12;
    var mins = m === 0 ? '' : m === 30 ? ' y media' : m === 15 ? ' y cuarto' : ' y ' + m;
    return (h12 === 1 ? 'a la una' : 'a las ' + h12) + mins + ' ' + part;
  }
  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var a = new Uint8Array(16); crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function icon(paths) {
    var ns = 'http://www.w3.org/2000/svg';
    var s = document.createElementNS(ns, 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true');
    paths.forEach(function (d) { var p = document.createElementNS(ns, 'path'); p.setAttribute('d', d); s.appendChild(p); });
    return s;
  }
  var ICON_CHECK = ['M5 12l5 5L19 7'];
  var ICON_PLAY = ['M8 5v14l11-7z'];
  var ICON_STOP = ['M7 7h10v10H7z'];
  var ICON_SPEAK = ['M4 9v6h4l5 4V5L8 9H4z', 'M16 8.5a4.5 4.5 0 010 7'];

  var toastTimer;
  function toast(msg, ms) {
    var t = $('toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, ms || 2600);
  }

  // ------------------------------------------------------------- preferencias
  var prefs = { lang: 'es-PE', rate: 1 };
  try {
    var saved = JSON.parse(localStorage.getItem('agenda.prefs') || '{}');
    if (typeof saved.lang === 'string' && /^es-[A-Z]{2}$/.test(saved.lang)) prefs.lang = saved.lang;
    if (typeof saved.rate === 'number' && saved.rate >= 0.6 && saved.rate <= 1.5) prefs.rate = saved.rate;
  } catch (e) { /* sin almacenamiento: se usan valores por defecto */ }
  function savePrefs() { try { localStorage.setItem('agenda.prefs', JSON.stringify(prefs)); } catch (e) { } }

  // ------------------------------------------------------------- base de datos
  var DB_NAME = 'agenda-voz';
  var dbp = new Promise(function (resolve, reject) {
    var req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = function () {
      var db = req.result;
      if (!db.objectStoreNames.contains('entries')) db.createObjectStore('entries', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('audios')) db.createObjectStore('audios', { keyPath: 'id' });
    };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  });
  function tx(store, mode, fn) {
    return dbp.then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(store, mode);
        var s = t.objectStore(store);
        var out = fn(s);
        t.oncomplete = function () { resolve(out && 'result' in out ? out.result : out); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error || new Error('Operación cancelada')); };
      });
    });
  }
  var DB = {
    all: function (store) { return tx(store, 'readonly', function (s) { return s.getAll(); }); },
    get: function (store, id) { return tx(store, 'readonly', function (s) { return s.get(id); }); },
    put: function (store, v) { return tx(store, 'readwrite', function (s) { s.put(v); }); },
    del: function (store, id) { return tx(store, 'readwrite', function (s) { s.delete(id); }); }
  };

  var entries = [];
  function loadAll() {
    return DB.all('entries').then(function (list) { entries = list || []; });
  }
  var persistAsked = false;
  function askPersist() {
    if (persistAsked) return; persistAsked = true;
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () { });
  }

  // ------------------------------------------------------------------ estado
  var state = { date: todayStr(), view: 'day', query: '', calMonth: null };

  // ------------------------------------------------------------------ render
  function render() {
    renderHeader();
    renderWeek();
    renderList();
  }
  function renderHeader() {
    $('monthLabel').textContent = fmtMonth(parseYMD(state.date));
    ['day', 'upcoming', 'search'].forEach(function (v) {
      var b = document.querySelector('.tab[data-view="' + v + '"]');
      b.classList.toggle('is-on', state.view === v);
      b.setAttribute('aria-pressed', state.view === v ? 'true' : 'false');
    });
    $('searchBar').hidden = state.view !== 'search';
  }
  function datesWithEntries() {
    var set = {};
    entries.forEach(function (e) { if (!e.done) set[e.date] = true; });
    return set;
  }
  function renderWeek() {
    var wk = $('week'); wk.textContent = '';
    var sel = parseYMD(state.date);
    var monday = addDays(sel, -((sel.getDay() + 6) % 7));
    var has = datesWithEntries();
    var tdy = todayStr();
    var dowFmt = new Intl.DateTimeFormat(LOCALE, { weekday: 'short' });
    for (var i = 0; i < 7; i++) {
      var d = addDays(monday, i), s = ymd(d);
      var b = el('button', 'day');
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', s === state.date && state.view === 'day' ? 'true' : 'false');
      b.setAttribute('aria-label', fmtLong(s));
      if (s === tdy) b.classList.add('is-today');
      if (s === state.date) b.classList.add('is-on');
      b.appendChild(el('small', null, dowFmt.format(d).replace('.', '')));
      b.appendChild(el('b', null, String(d.getDate())));
      if (has[s]) b.appendChild(el('span', 'dot'));
      b.dataset.date = s;
      wk.appendChild(b);
    }
  }
  function sortEntries(a, b) {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    var ta = a.time || '', tb = b.time || '';
    if (ta !== tb) return ta < tb ? -1 : 1;
    return (a.created || 0) - (b.created || 0);
  }
  function renderList() {
    var list = $('list'); list.textContent = '';
    var title = $('dayTitle');
    var shown = [];
    var fold = window.AgendaParser.fold;
    if (state.view === 'day') {
      title.textContent = state.date === todayStr() ? 'Hoy · ' + fmtLong(state.date) : fmtLong(state.date);
      shown = entries.filter(function (e) { return e.date === state.date; }).sort(sortEntries);
      shown.forEach(function (e) { list.appendChild(itemNode(e, false)); });
      $('emptyTitle').textContent = 'Nada anotado para este día';
    } else if (state.view === 'upcoming') {
      title.textContent = 'Lo que viene';
      var tdy = todayStr();
      var late = entries.filter(function (e) { return !e.done && e.date < tdy; }).sort(sortEntries);
      var next = entries.filter(function (e) { return !e.done && e.date >= tdy; }).sort(sortEntries).slice(0, 200);
      if (late.length) {
        list.appendChild(el('li', 'group-label', 'Atrasados'));
        late.forEach(function (e) { list.appendChild(itemNode(e, true)); });
      }
      var last = null;
      next.forEach(function (e) {
        if (e.date !== last) { last = e.date; list.appendChild(el('li', 'group-label', e.date === tdy ? 'Hoy' : fmtLong(e.date))); }
        list.appendChild(itemNode(e, false));
      });
      shown = late.concat(next);
      $('emptyTitle').textContent = 'No tienes pendientes. ¡Todo al día!';
    } else {
      var q = fold(state.query.trim());
      title.textContent = q ? 'Resultados' : 'Escribe para buscar';
      if (q) {
        shown = entries.filter(function (e) { return fold((e.title || '') + ' ' + (e.notes || '')).indexOf(q) >= 0; })
          .sort(function (a, b) { return -sortEntries(a, b); });
        shown.forEach(function (e) { list.appendChild(itemNode(e, true)); });
      }
      $('emptyTitle').textContent = q ? 'Sin resultados' : 'Busca por palabra';
    }
    $('empty').hidden = shown.length > 0 || (state.view === 'search' && !state.query.trim());
  }
  function itemNode(e, showDate) {
    var li = el('li', 'item' + (e.done ? ' is-done' : ''));
    var chk = el('button', 'check');
    chk.type = 'button';
    chk.setAttribute('aria-label', e.done ? 'Marcar como pendiente' : 'Marcar como hecho');
    chk.setAttribute('aria-pressed', e.done ? 'true' : 'false');
    chk.appendChild(icon(ICON_CHECK));
    chk.addEventListener('click', function () { toggleDone(e); });

    var main = el('button', 'item-main');
    main.type = 'button';
    main.setAttribute('aria-label', 'Editar: ' + e.title);
    var timeTxt = (showDate ? fmtLong(e.date) + (e.time ? ' · ' : '') : '') + (e.time ? fmtTime(e.time) : (showDate ? '' : 'Sin hora'));
    main.appendChild(el('div', 'item-time', timeTxt));
    main.appendChild(el('div', 'item-title', e.title));
    if (e.notes) main.appendChild(el('div', 'item-notes', e.notes));
    var tags = el('div', 'item-tags');
    if (e.audioId) tags.appendChild(el('span', 'tag', 'Audio'));
    if (e.remind && e.time) tags.appendChild(el('span', 'tag', 'Aviso'));
    if (tags.childNodes.length) main.appendChild(tags);
    main.addEventListener('click', function () { openEditor(e); });

    var acts = el('div', 'item-actions');
    var say = el('button', 'icon-btn');
    say.type = 'button'; say.setAttribute('aria-label', 'Escuchar esta nota');
    say.appendChild(icon(ICON_SPEAK));
    say.addEventListener('click', function () { speak(entrySpeech(e, true)); });
    acts.appendChild(say);
    if (e.audioId) {
      var play = el('button', 'icon-btn');
      play.type = 'button'; play.setAttribute('aria-label', 'Reproducir el audio grabado');
      play.appendChild(icon(ICON_PLAY));
      play.addEventListener('click', function () { toggleAudio(e.audioId, play); });
      acts.appendChild(play);
    }
    li.appendChild(chk); li.appendChild(main); li.appendChild(acts);
    return li;
  }

  function toggleDone(e) {
    e.done = !e.done; e.updated = Date.now();
    DB.put('entries', e).then(render).catch(dbError);
  }
  function dbError(err) {
    console.error(err);
    toast('No se pudo guardar. Revisa que el teléfono tenga espacio libre.', 4000);
  }

  // --------------------------------------------------------- reproducir audio
  var player = new Audio();
  var playerUrl = null, playerBtn = null;
  function stopPlayer() {
    player.pause();
    if (playerUrl) { URL.revokeObjectURL(playerUrl); playerUrl = null; }
    if (playerBtn) { playerBtn.classList.remove('is-playing'); swapIcon(playerBtn, ICON_PLAY); playerBtn = null; }
  }
  function swapIcon(btn, paths) { btn.textContent = ''; btn.appendChild(icon(paths)); }
  player.addEventListener('ended', stopPlayer);
  function toggleAudio(audioId, btn) {
    if (playerBtn === btn) { stopPlayer(); return; }
    stopPlayer();
    DB.get('audios', audioId).then(function (rec) {
      if (!rec || !rec.blob) { toast('No se encontró el audio.'); return; }
      playerUrl = URL.createObjectURL(rec.blob);
      player.src = playerUrl;
      playerBtn = btn; btn.classList.add('is-playing'); swapIcon(btn, ICON_STOP);
      return player.play();
    }).catch(function () { stopPlayer(); toast('No se pudo reproducir el audio.'); });
  }

  // --------------------------------------------------------- leer en voz alta
  var hasTTS = 'speechSynthesis' in window;
  function pickVoice() {
    if (!hasTTS) return null;
    var vs = speechSynthesis.getVoices().filter(function (v) { return /^es/i.test(v.lang); });
    return vs.filter(function (v) { return v.lang.replace('_', '-') === prefs.lang; })[0] ||
      vs.filter(function (v) { return /419|MX|US|PE|CO/.test(v.lang); })[0] || vs[0] || null;
  }
  if (hasTTS) speechSynthesis.getVoices();
  function speak(text) {
    if (!hasTTS) { toast('Este navegador no puede leer en voz alta.'); return; }
    speechSynthesis.cancel();
    var u = new SpeechSynthesisUtterance(text);
    var v = pickVoice();
    if (v) u.voice = v;
    u.lang = v ? v.lang : prefs.lang;
    u.rate = prefs.rate;
    speechSynthesis.speak(u);
  }
  function entrySpeech(e, withDate) {
    var s = '';
    if (withDate) s += (e.date === todayStr() ? 'Hoy' : fmtLong(e.date)) + ', ';
    if (e.time) s += (withDate ? spokenTime(e.time) : cap(spokenTime(e.time))) + ': ';
    s += e.title + '.';
    if (e.notes) s += ' ' + e.notes;
    return s;
  }
  function speakDay() {
    if (hasTTS && speechSynthesis.speaking) { speechSynthesis.cancel(); return; }
    var d = state.view === 'day' ? state.date : todayStr();
    var items = entries.filter(function (e) { return e.date === d && !e.done; }).sort(sortEntries);
    var head = (d === todayStr() ? 'Hoy, ' : '') + fmtLong(d) + '. ';
    if (!items.length) { speak(head + 'No tienes pendientes.'); return; }
    speak(head + (items.length === 1 ? 'Tienes una nota. ' : 'Tienes ' + items.length + ' notas. ') +
      items.map(function (e) { return entrySpeech(e, false); }).join(' '));
  }

  // ------------------------------------------------------- dictado por voz
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var micBusy = false;
  function srErrorText(code) {
    switch (code) {
      case 'not-allowed': case 'service-not-allowed':
        return 'El micrófono está bloqueado. Permítelo en los ajustes del navegador para este sitio.';
      case 'audio-capture': return 'No se encontró un micrófono.';
      case 'network': return 'El dictado necesita internet. Puedes escribir la nota o grabar un audio sin conexión.';
      case 'language-not-supported': return 'Este idioma no está disponible para dictado. Prueba otro en Ajustes.';
      default: return 'No se pudo usar el dictado (' + code + ').';
    }
  }
  /* Reconocedor que se reinicia solo hasta que el usuario lo detiene.
     Se usa modo no continuo porque en Android el modo continuo repite frases. */
  function Listener(onUpdate, onFinish) {
    var finals = [], interim = '', active = false, rec = null, lastErr = null, restarts = 0, aborted = false;
    function startOne() {
      rec = new SR();
      rec.lang = prefs.lang;
      rec.interimResults = true;
      rec.continuous = false;
      rec.maxAlternatives = 1;
      rec.onresult = function (ev) {
        interim = '';
        for (var i = ev.resultIndex; i < ev.results.length; i++) {
          var r = ev.results[i];
          if (r.isFinal) { var t = r[0].transcript.trim(); if (t) finals.push(t); }
          else interim += r[0].transcript;
        }
        restarts = 0;
        onUpdate(finals.join(' '), interim.trim());
      };
      rec.onerror = function (ev) {
        if (ev.error === 'no-speech' || ev.error === 'aborted') return;
        lastErr = ev.error; active = false;
      };
      rec.onend = function () {
        interim = '';
        if (active && restarts < 20) { restarts++; try { startOne(); return; } catch (e) { lastErr = 'start'; } }
        active = false; micBusy = false;
        onFinish(aborted ? null : finals.join(' ').trim(), lastErr);
      };
      rec.start();
    }
    return {
      start: function () {
        if (micBusy) return false;
        micBusy = true; active = true;
        try { startOne(); } catch (e) { micBusy = false; active = false; onFinish('', 'start'); return false; }
        return true;
      },
      stop: function () { active = false; try { rec && rec.stop(); } catch (e) { } },
      abort: function () { active = false; aborted = true; try { rec && rec.abort(); } catch (e) { } }
    };
  }

  var dictation = null;
  function startDictation() {
    if (!SR) {
      toast('Tu navegador no tiene dictado. Usa Chrome en Android o Safari en iPhone. También puedes usar el micrófono del teclado.', 6000);
      openEditor(null);
      return;
    }
    stopPlayer(); if (hasTTS) speechSynthesis.cancel();
    var tr = $('transcript');
    tr.textContent = '';
    tr.appendChild(el('span', 'hint', 'Habla con naturalidad. Puedes decir el día y la hora.'));
    $('dictError').hidden = true;
    $('wave').classList.remove('is-off');
    $('dictDone').disabled = false;
    $('dlgDictate').showModal();
    dictation = Listener(function (finalTxt, interim) {
      tr.textContent = '';
      if (finalTxt) tr.appendChild(document.createTextNode(finalTxt + ' '));
      if (interim) tr.appendChild(el('span', 'interim', interim));
    }, function (text, err) {
      $('wave').classList.add('is-off');
      dictation = null;
      if (text === null) return; // cancelado
      if (err && !text) {
        $('dictError').textContent = srErrorText(err);
        $('dictError').hidden = false;
        $('dictDone').disabled = true;
        return;
      }
      $('dlgDictate').close();
      if (!text) { toast('No escuché nada. Vuelve a intentarlo.'); return; }
      var p = window.AgendaParser.parse(text, new Date());
      openEditor(null, {
        title: p.title || text,
        date: p.date || (state.view === 'day' ? state.date : todayStr()),
        time: p.time || '',
        notes: '',
        remind: !!p.time
      });
    });
    if (!dictation.start()) $('dlgDictate').close();
  }
  $('dictDone').addEventListener('click', function () { if (dictation) dictation.stop(); else $('dlgDictate').close(); });
  $('dictCancel').addEventListener('click', function () { if (dictation) dictation.abort(); $('dlgDictate').close(); });
  $('dlgDictate').addEventListener('cancel', function () { if (dictation) dictation.abort(); });

  // Micrófonos pequeños dentro del editor: añaden lo dictado al campo.
  var fieldDict = null, fieldBtn = null;
  function stopFieldDict() { if (fieldDict) fieldDict.stop(); }
  Array.prototype.forEach.call(document.querySelectorAll('.mini-mic'), function (btn) {
    btn.addEventListener('click', function () {
      if (fieldDict) { var same = fieldBtn === btn; stopFieldDict(); if (same) return; }
      if (!SR) { toast('Usa el micrófono de tu teclado para dictar aquí.', 4000); return; }
      if (recorder) { toast('Detén la grabación antes de dictar.'); return; }
      var target = $(btn.dataset.target);
      var base = target.value;
      var status = $('miniStatus');
      fieldBtn = btn; btn.classList.add('is-live');
      status.textContent = 'Escuchando… toca el micrófono otra vez para terminar.'; status.hidden = false;
      fieldDict = Listener(function (fin, interim) {
        var add = (fin + ' ' + interim).trim();
        target.value = (base ? base.replace(/\s+$/, '') + ' ' : '') + add;
      }, function (text, err) {
        btn.classList.remove('is-live'); status.hidden = true;
        fieldDict = null; fieldBtn = null;
        if (text != null) {
          target.value = (base ? base.replace(/\s+$/, '') + ' ' : '') + (text || '');
          target.value = target.value.trim();
          if (target.id === 'fTitle' && target.value) target.value = cap(target.value);
        }
        if (err && !text) toast(srErrorText(err), 5000);
      });
      fieldDict.start();
    });
  });

  // --------------------------------------------------------------- grabadora
  var recorder = null, recStream = null, recChunks = [], recTimer = null, recStart = 0, recDiscard = false;
  var pendingAudio = undefined; // undefined = sin cambios, null = quitar, Blob = nuevo
  var previewUrl = null;
  var MAX_REC_MS = 10 * 60 * 1000;
  function pickMime() {
    if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
    var opts = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'];
    for (var i = 0; i < opts.length; i++) if (MediaRecorder.isTypeSupported(opts[i])) return opts[i];
    return '';
  }
  function showPreview(blob) {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = blob ? URL.createObjectURL(blob) : null;
    var a = $('recAudio');
    if (previewUrl) { a.src = previewUrl; a.hidden = false; $('recDel').hidden = false; }
    else { a.removeAttribute('src'); a.hidden = true; $('recDel').hidden = true; }
  }
  function startRecording() {
    if (!navigator.mediaDevices || !window.MediaRecorder) { toast('Este navegador no permite grabar audio.'); return; }
    if (fieldDict) { toast('Termina el dictado antes de grabar.'); return; }
    stopPlayer();
    recDiscard = false;
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }).then(function (stream) {
      recStream = stream; recChunks = [];
      var mime = pickMime();
      recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      recorder.ondataavailable = function (ev) { if (ev.data && ev.data.size) recChunks.push(ev.data); };
      recorder.onstop = function () {
        var type = (recorder && recorder.mimeType) || mime || 'audio/webm';
        var blob = new Blob(recChunks, { type: type.split(';')[0] });
        recStream.getTracks().forEach(function (t) { t.stop(); });
        recorder = null; recStream = null; clearInterval(recTimer);
        $('recBtn').textContent = 'Volver a grabar'; $('recBtn').classList.remove('is-live');
        if (recDiscard) { recDiscard = false; return; }
        if (blob.size > 0) { pendingAudio = blob; showPreview(blob); }
      };
      recorder.start(1000);
      recStart = Date.now();
      $('recBtn').textContent = 'Detener'; $('recBtn').classList.add('is-live');
      $('recTime').textContent = '0:00';
      recTimer = setInterval(function () {
        var s = Math.floor((Date.now() - recStart) / 1000);
        $('recTime').textContent = Math.floor(s / 60) + ':' + pad(s % 60);
        if (Date.now() - recStart > MAX_REC_MS) stopRecording();
      }, 250);
    }).catch(function (err) {
      toast(err && err.name === 'NotAllowedError'
        ? 'El micrófono está bloqueado. Permítelo en los ajustes del navegador.'
        : 'No se pudo abrir el micrófono.', 5000);
    });
  }
  function stopRecording() { if (recorder && recorder.state !== 'inactive') recorder.stop(); }
  $('recBtn').addEventListener('click', function () { if (recorder) stopRecording(); else startRecording(); });
  $('recDel').addEventListener('click', function () {
    pendingAudio = null; showPreview(null);
    $('recBtn').textContent = 'Grabar'; $('recTime').textContent = '0:00';
  });

  // ------------------------------------------------------------------ editor
  var editing = null;
  function openEditor(entry, prefill) {
    editing = entry;
    var v = entry || prefill || {};
    $('editHeading').textContent = entry ? 'Editar nota' : 'Nueva nota';
    $('fTitle').value = v.title || '';
    $('fDate').value = v.date || (state.view === 'day' ? state.date : todayStr());
    $('fTime').value = v.time || '';
    $('fNotes').value = v.notes || '';
    $('fRemind').checked = !!v.remind;
    $('editDelete').hidden = !entry;
    pendingAudio = undefined;
    $('recBtn').textContent = 'Grabar'; $('recBtn').classList.remove('is-live'); $('recTime').textContent = '0:00';
    showPreview(null);
    if (entry && entry.audioId) {
      $('recBtn').textContent = 'Volver a grabar';
      DB.get('audios', entry.audioId).then(function (rec) { if (rec && rec.blob && editing === entry) showPreview(rec.blob); });
    }
    $('dlgEdit').showModal();
    if (prefill && prefill.autoRecord) startRecording();
  }
  function closeEditor() {
    stopFieldDict();
    if (recorder) { recDiscard = true; stopRecording(); }
    if (recStream) recStream.getTracks().forEach(function (t) { t.stop(); });
    showPreview(null);
    if ($('dlgEdit').open) $('dlgEdit').close();
    editing = null;
  }
  $('editCancel').addEventListener('click', closeEditor);
  $('dlgEdit').addEventListener('cancel', function (ev) { ev.preventDefault(); closeEditor(); });
  $('editForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    if (recorder) { toast('Detén la grabación primero.'); return; }
    var title = $('fTitle').value.trim();
    var date = $('fDate').value;
    if (!title) {
      if (pendingAudio instanceof Blob) title = 'Nota de audio';
      else { toast('Escribe o dicta qué quieres anotar.'); $('fTitle').focus(); return; }
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { toast('Elige un día.'); return; }
    var now = Date.now();
    var wasEditing = !!editing;
    var e = editing ? Object.assign({}, editing) : { id: uid(), created: now, done: false };
    var timeChanged = !editing || editing.time !== $('fTime').value || editing.date !== date;
    e.title = title.slice(0, 200);
    e.notes = $('fNotes').value.trim().slice(0, 4000);
    e.date = date;
    e.time = /^\d{2}:\d{2}$/.test($('fTime').value) ? $('fTime').value : '';
    e.remind = $('fRemind').checked && !!e.time;
    if (timeChanged) e.notified = false;
    e.updated = now;
    var ops = [];
    var oldAudio = editing && editing.audioId;
    if (pendingAudio instanceof Blob) {
      var aid = uid();
      ops.push(DB.put('audios', { id: aid, blob: pendingAudio, type: pendingAudio.type, created: now }));
      e.audioId = aid;
    } else if (pendingAudio === null) {
      e.audioId = null;
    }
    Promise.all(ops).then(function () { return DB.put('entries', e); }).then(function () {
      if (oldAudio && oldAudio !== e.audioId) return DB.del('audios', oldAudio);
    }).then(function () {
      askPersist();
      if (e.remind && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
      return loadAll();
    }).then(function () {
      closeEditor();
      if (state.view === 'day' && e.date !== state.date) state.date = e.date;
      render();
      toast(wasEditing ? 'Cambios guardados' : 'Anotado para ' + (e.date === todayStr() ? 'hoy' : fmtLong(e.date).toLowerCase()));
    }).catch(dbError);
  });
  $('editDelete').addEventListener('click', function () {
    var e = editing; if (!e) return;
    confirmAsk('¿Borrar «' + e.title + '»? No se puede deshacer.', 'Sí, borrar').then(function (ok) {
      if (!ok) return;
      DB.del('entries', e.id).then(function () { return e.audioId ? DB.del('audios', e.audioId) : null; })
        .then(loadAll).then(function () { closeEditor(); render(); toast('Nota borrada'); }).catch(dbError);
    });
  });

  // ---------------------------------------------------------------- confirmar
  function confirmAsk(text, yes) {
    return new Promise(function (resolve) {
      var d = $('dlgConfirm');
      $('confirmText').textContent = text;
      $('confirmYes').textContent = yes || 'Aceptar';
      function done(v) {
        $('confirmYes').removeEventListener('click', onYes);
        $('confirmNo').removeEventListener('click', onNo);
        d.removeEventListener('cancel', onNo);
        if (d.open) d.close();
        resolve(v);
      }
      function onYes() { done(true); }
      function onNo() { done(false); }
      $('confirmYes').addEventListener('click', onYes);
      $('confirmNo').addEventListener('click', onNo);
      d.addEventListener('cancel', onNo);
      d.showModal();
    });
  }

  // ------------------------------------------------------------- calendario
  function openMonth() {
    var d = parseYMD(state.date);
    state.calMonth = new Date(d.getFullYear(), d.getMonth(), 1);
    renderMonth();
    $('dlgMonth').showModal();
  }
  function renderMonth() {
    var m = state.calMonth;
    $('calLabel').textContent = fmtMonth(m);
    var g = $('calGrid'); g.textContent = '';
    ['lu', 'ma', 'mi', 'ju', 'vi', 'sá', 'do'].forEach(function (s) { g.appendChild(el('div', 'dow', s)); });
    var start = addDays(m, -((m.getDay() + 6) % 7));
    var has = datesWithEntries(), tdy = todayStr();
    for (var i = 0; i < 42; i++) {
      var d = addDays(start, i), s = ymd(d);
      var b = el('button', null, String(d.getDate()));
      b.type = 'button';
      b.setAttribute('aria-label', fmtLong(s));
      if (d.getMonth() !== m.getMonth()) b.classList.add('out');
      if (s === tdy) b.classList.add('is-today');
      if (s === state.date) b.classList.add('is-on');
      if (has[s]) b.classList.add('has');
      b.dataset.date = s;
      g.appendChild(b);
    }
  }
  $('calGrid').addEventListener('click', function (ev) {
    var b = ev.target.closest('button[data-date]'); if (!b) return;
    state.date = b.dataset.date; state.view = 'day';
    $('dlgMonth').close(); render();
  });
  $('calPrev').addEventListener('click', function () { state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() - 1, 1); renderMonth(); });
  $('calNext').addEventListener('click', function () { state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() + 1, 1); renderMonth(); });
  $('calClose').addEventListener('click', function () { $('dlgMonth').close(); });

  // --------------------------------------------------------------- avisos
  function checkReminders() {
    var now = new Date();
    var nowMs = now.getTime();
    entries.forEach(function (e) {
      if (!e.remind || !e.time || e.done || e.notified) return;
      var at = parseYMD(e.date); at.setHours(+e.time.slice(0, 2), +e.time.slice(3, 5), 0, 0);
      var diff = nowMs - at.getTime();
      if (diff >= 0 && diff < 6 * 3600 * 1000) {
        e.notified = true;
        DB.put('entries', e).catch(function () { });
        notify(e);
      }
    });
  }
  function notify(e) {
    var body = fmtTime(e.time) + (e.notes ? ' · ' + e.notes.slice(0, 120) : '');
    toast('⏰ ' + e.title, 8000);
    if (navigator.vibrate) navigator.vibrate([300, 150, 300]);
    if ('Notification' in window && Notification.permission === 'granted' && navigator.serviceWorker) {
      navigator.serviceWorker.ready.then(function (reg) {
        return reg.showNotification(e.title, { body: body, tag: e.id, icon: 'icon-192.png', badge: 'icon-192.png' });
      }).catch(function () { });
    }
  }

  // ------------------------------------------------------- ajustes y copias
  function openSettings() {
    $('sLang').value = prefs.lang;
    $('sRate').value = String(prefs.rate);
    var nb = $('btnNotif');
    if (!('Notification' in window)) { nb.textContent = 'Este navegador no tiene notificaciones'; nb.disabled = true; }
    else if (Notification.permission === 'granted') { nb.textContent = 'Notificaciones activadas'; nb.disabled = true; }
    else if (Notification.permission === 'denied') { nb.textContent = 'Notificaciones bloqueadas en el navegador'; nb.disabled = true; }
    var info = $('storageInfo');
    info.textContent = entries.length + (entries.length === 1 ? ' nota guardada' : ' notas guardadas') + ' en este teléfono.';
    if (navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then(function (est) {
        var mb = (est.usage || 0) / 1048576;
        info.textContent += ' Espacio usado: ' + (mb < 0.1 ? 'menos de 0,1' : mb.toFixed(1).replace('.', ',')) + ' MB.';
      }).catch(function () { });
    }
    $('dlgSettings').showModal();
  }
  $('sLang').addEventListener('change', function () { prefs.lang = $('sLang').value; savePrefs(); });
  $('sRate').addEventListener('change', function () { prefs.rate = parseFloat($('sRate').value) || 1; savePrefs(); speak('Así sonará la lectura.'); });
  $('setClose').addEventListener('click', function () { $('dlgSettings').close(); });
  $('btnNotif').addEventListener('click', function () {
    Notification.requestPermission().then(function () { $('dlgSettings').close(); openSettings(); });
  });

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result).split(',')[1] || ''); };
      r.onerror = function () { reject(r.error); };
      r.readAsDataURL(blob);
    });
  }
  function base64ToBlob(b64, type) {
    var bin = atob(b64), arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: type });
  }
  $('btnExport').addEventListener('click', function () {
    Promise.all([DB.all('entries'), DB.all('audios')]).then(function (r) {
      return Promise.all(r[1].map(function (a) {
        return blobToBase64(a.blob).then(function (b64) { return { id: a.id, type: a.type || a.blob.type, data: b64 }; });
      })).then(function (audios) {
        return { app: 'agenda-voz', version: 1, exported: new Date().toISOString(), entries: r[0], audios: audios };
      });
    }).then(function (data) {
      var blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = 'agenda-copia-' + todayStr() + '.json';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
      toast('Copia guardada en Descargas');
    }).catch(function () { toast('No se pudo crear la copia.'); });
  });

  // Validación estricta de una copia importada: solo se aceptan campos conocidos.
  var ID_RE = /^[A-Za-z0-9-]{1,64}$/;
  function cleanEntry(x) {
    if (!x || typeof x !== 'object') return null;
    if (typeof x.id !== 'string' || !ID_RE.test(x.id)) return null;
    if (typeof x.title !== 'string' || !x.title.trim()) return null;
    if (typeof x.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(x.date)) return null;
    var time = typeof x.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(x.time) ? x.time : '';
    return {
      id: x.id,
      title: x.title.slice(0, 200),
      notes: typeof x.notes === 'string' ? x.notes.slice(0, 4000) : '',
      date: x.date,
      time: time,
      done: x.done === true,
      remind: x.remind === true && !!time,
      notified: x.notified === true,
      audioId: typeof x.audioId === 'string' && ID_RE.test(x.audioId) ? x.audioId : null,
      created: typeof x.created === 'number' ? x.created : Date.now(),
      updated: Date.now()
    };
  }
  $('importFile').addEventListener('change', function () {
    var f = this.files && this.files[0];
    this.value = '';
    if (!f) return;
    if (f.size > 300 * 1048576) { toast('El archivo es demasiado grande.'); return; }
    f.text().then(function (txt) {
      var data;
      try { data = JSON.parse(txt); } catch (e) { throw new Error('formato'); }
      if (!data || data.app !== 'agenda-voz' || !Array.isArray(data.entries)) throw new Error('formato');
      var list = data.entries.map(cleanEntry).filter(Boolean);
      var audios = (Array.isArray(data.audios) ? data.audios : []).filter(function (a) {
        return a && typeof a.id === 'string' && ID_RE.test(a.id) && typeof a.type === 'string' &&
          /^audio\/[a-z0-9.+-]{1,40}$/i.test(a.type) && typeof a.data === 'string' && /^[A-Za-z0-9+/=]*$/.test(a.data);
      });
      return confirmAsk('Se añadirán ' + list.length + ' notas y ' + audios.length +
        ' audios de la copia. Las notas con el mismo identificador se reemplazarán. ¿Continuar?', 'Restaurar')
        .then(function (ok) {
          if (!ok) return false;
          var ops = audios.map(function (a) {
            return DB.put('audios', { id: a.id, blob: base64ToBlob(a.data, a.type), type: a.type, created: Date.now() });
          }).concat(list.map(function (e) { return DB.put('entries', e); }));
          return Promise.all(ops).then(loadAll).then(function () { render(); toast('Copia restaurada: ' + list.length + ' notas'); return true; });
        });
    }).catch(function (err) {
      toast(err && err.message === 'formato' ? 'Ese archivo no es una copia de esta agenda.' : 'No se pudo restaurar la copia.', 4500);
    });
  });

  // ---------------------------------------------------------------- eventos
  $('week').addEventListener('click', function (ev) {
    var b = ev.target.closest('button[data-date]'); if (!b) return;
    state.date = b.dataset.date; state.view = 'day'; render();
  });
  // Deslizar la semana con el dedo
  (function () {
    var x0 = null, y0 = null;
    var wk = $('week');
    wk.addEventListener('touchstart', function (e) { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
    wk.addEventListener('touchend', function (e) {
      if (x0 == null) return;
      var dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
      x0 = null;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) {
        state.date = ymd(addDays(parseYMD(state.date), dx < 0 ? 7 : -7)); render();
      }
    }, { passive: true });
  })();
  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
    t.addEventListener('click', function () {
      state.view = t.dataset.view; render();
      if (state.view === 'search') $('searchInput').focus();
    });
  });
  $('searchInput').addEventListener('input', function () { state.query = this.value.slice(0, 100); renderList(); });
  $('btnToday').addEventListener('click', function () { state.date = todayStr(); state.view = 'day'; render(); });
  $('btnMonth').addEventListener('click', openMonth);
  $('btnSpeakDay').addEventListener('click', speakDay);
  $('btnSettings').addEventListener('click', openSettings);
  $('btnAdd').addEventListener('click', function () { openEditor(null); });
  $('btnDictate').addEventListener('click', startDictation);
  $('btnMemo').addEventListener('click', function () { openEditor(null, { title: '', autoRecord: true }); });
  // Cerrar hojas tocando fuera
  Array.prototype.forEach.call(document.querySelectorAll('dialog.sheet'), function (d) {
    d.addEventListener('click', function (ev) {
      if (ev.target !== d) return;
      if (d.id === 'dlgEdit') return; // el editor no se cierra por accidente
      if (d.id === 'dlgDictate' && dictation) dictation.abort();
      if (d.id === 'dlgConfirm') { $('confirmNo').click(); return; }
      d.close();
    });
  });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { stopPlayer(); }
    else { if (state.view === 'day') renderWeek(); checkReminders(); }
  });

  // ------------------------------------------------------------------ inicio
  loadAll().then(function () {
    render();
    checkReminders();
    setInterval(checkReminders, 20000);
  }).catch(function (err) {
    console.error(err);
    $('emptyTitle').textContent = 'No se pudo abrir el almacenamiento';
    $('empty').hidden = false;
    toast('Este navegador no permite guardar datos (¿modo incógnito?).', 6000);
  });

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () { });
    });
  }
})();
