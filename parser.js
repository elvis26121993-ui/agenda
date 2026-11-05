/*
 * Intérprete de frases en español para la Agenda.
 * Convierte "mañana a las 3 de la tarde reunión con Juan" en
 * { title: "Reunión con Juan", date: "2026-11-06", time: "15:00" }.
 * Sin dependencias. Funciona en el navegador (window.AgendaParser) y en Node (pruebas).
 */
(function (root) {
  'use strict';

  var WEEKDAYS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
  var MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto',
    'septiembre', 'octubre', 'noviembre', 'diciembre'];
  var NUM_WORDS = {
    un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8,
    nueve: 9, diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, veinte: 20,
    treinta: 30, cuarenta: 40, cincuenta: 50, primero: 1
  };
  var NUM_RE = '(\\d{1,2}|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce)';
  var MIN_RE = '(\\d{1,2}|cinco|diez|quince|veinte|treinta|cuarenta|cincuenta|media|cuarto)';

  // Quita tildes sin cambiar la longitud del texto (para poder recortar por posiciones).
  function fold(s) {
    var from = 'áéíóúüÁÉÍÓÚÜñÑ';
    var to = 'aeiouuAEIOUUnN';
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var k = from.indexOf(s[i]);
      out += k >= 0 ? to[k] : s[i];
    }
    return out.toLowerCase();
  }

  function toNum(w) {
    if (w == null) return null;
    if (/^\d+$/.test(w)) return parseInt(w, 10);
    return Object.prototype.hasOwnProperty.call(NUM_WORDS, w) ? NUM_WORDS[w] : null;
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function addDays(d, n) { var r = new Date(d.getFullYear(), d.getMonth(), d.getDate()); r.setDate(r.getDate() + n); return r; }
  function validDate(y, m, d) {
    var t = new Date(y, m, d);
    return t.getFullYear() === y && t.getMonth() === m && t.getDate() === d ? t : null;
  }

  function parse(text, now) {
    now = now || new Date();
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var src = String(text || '').replace(/\s+/g, ' ').trim();
    var low = fold(src);
    var spans = [];
    var date = null;
    var time = null;
    var m;

    function take(match, extra) {
      var start = match.index + (extra || 0);
      spans.push([start, match.index + match[0].length]);
    }

    // ---------- HORA ----------
    var timeRe = new RegExp(
      '\\b(?:a\\s+las|a\\s+la|alas|las|la)\\s+' + NUM_RE +
      '(?:(?::|\\.|\\s+y\\s+)' + MIN_RE + '|\\s+menos\\s+' + MIN_RE + ')?' +
      '(?:\\s*(?:horas|hrs|hs|h))?' +
      '(?:\\s+(?:de\\s+la|en\\s+la|por\\s+la)\\s+(manana|tarde|noche|madrugada)|\\s*(a\\.?\\s?m\\.?|p\\.?\\s?m\\.?)(?=\\s|$|[,.;])|\\s+en\\s+punto)?', 'i');
    m = timeRe.exec(low);
    // "la una" solo cuenta como hora si va con "a la" o con un periodo del día
    if (m && /^(la|las)\s/.test(m[0]) && !m[2] && !m[3] && !m[4] && !m[5]) {
      // "las 5" sin "a" ni periodo: aceptar solo si es un número escrito con dígitos
      if (!/^\d/.test(m[1])) m = null;
    }
    if (m) {
      var h = toNum(m[1]);
      var min = 0;
      if (m[2] != null) {
        min = m[2] === 'media' ? 30 : m[2] === 'cuarto' ? 15 : toNum(m[2]);
      } else if (m[3] != null) {
        var sub = m[3] === 'media' ? 30 : m[3] === 'cuarto' ? 15 : toNum(m[3]);
        h = h - 1; min = 60 - sub;
        if (h < 0) h = 23;
      }
      var period = m[4] || null;
      var ampm = m[5] ? m[5].replace(/[^ap]/g, '') : null;
      if (h != null && min != null && h <= 23 && min <= 59) {
        if (ampm === 'p' && h < 12) h += 12;
        else if (ampm === 'a' && h === 12) h = 0;
        else if (period === 'tarde' && h < 12) h += 12;
        else if (period === 'noche') { if (h === 12) h = 0; else if (h >= 6 && h < 12) h += 12; }
        else if (!period && !ampm && h >= 1 && h <= 6) {
          // "a las 3" sin indicar periodo: casi siempre es de la tarde
          h += 12;
        }
        if (h === 24) h = 0;
        time = pad(h) + ':' + pad(min);
        take(m);
      }
    }
    if (!time) {
      m = /\b(\d{1,2})[:.](\d{2})\s*(a\.?\s?m\.?|p\.?\s?m\.?)?(?=\s|$|[,;])/.exec(low);
      if (m) {
        var hh = parseInt(m[1], 10), mm = parseInt(m[2], 10);
        var ap = m[3] ? m[3].replace(/[^ap]/g, '') : null;
        if (ap === 'p' && hh < 12) hh += 12;
        if (ap === 'a' && hh === 12) hh = 0;
        if (hh <= 23 && mm <= 59) { time = pad(hh) + ':' + pad(mm); take(m); }
      }
    }
    if (!time) {
      m = /\b(?:al|a)\s+medio\s?dia\b/.exec(low);
      if (m) { time = '12:00'; take(m); }
    }
    if (!time) {
      m = /\b(?:a\s+la\s+)?medianoche\b/.exec(low);
      if (m) { time = '00:00'; take(m); }
    }

    // ---------- FECHA ----------
    var mi;
    // 15 de noviembre (de 2026)
    m = new RegExp('\\b(?:el\\s+)?(?:dia\\s+)?(\\d{1,2}|primero)\\s+de\\s+(' + MONTHS.join('|') + ')(?:\\s+(?:de|del)\\s+(\\d{4}))?\\b').exec(low);
    if (m) {
      var dd = toNum(m[1]);
      mi = MONTHS.indexOf(m[2]);
      var yy = m[3] ? parseInt(m[3], 10) : today.getFullYear();
      var cand = validDate(yy, mi, dd);
      if (cand && !m[3] && cand < today) cand = validDate(yy + 1, mi, dd);
      if (cand) { date = ymd(cand); take(m); }
    }
    // 15/11 o 15/11/2026
    if (!date) {
      m = /\b(?:el\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(low);
      if (m) {
        var y2 = m[3] ? parseInt(m[3], 10) : today.getFullYear();
        if (y2 < 100) y2 += 2000;
        var c2 = validDate(y2, parseInt(m[2], 10) - 1, parseInt(m[1], 10));
        if (c2 && !m[3] && c2 < today) c2 = validDate(y2 + 1, c2.getMonth(), c2.getDate());
        if (c2) { date = ymd(c2); take(m); }
      }
    }
    if (!date) {
      m = /\bpasado\s+manana\b/.exec(low);
      if (m) { date = ymd(addDays(today, 2)); take(m); }
    }
    if (!date) {
      // "mañana" como día, no "de la mañana" / "en la mañana"
      var re = /\bmanana\b/g, x;
      while ((x = re.exec(low))) {
        var before = low.slice(Math.max(0, x.index - 4), x.index);
        if (!/la\s$/.test(before)) {
          date = ymd(addDays(today, 1));
          // incluir un "para" previo
          var pre = /\b(?:para\s+)$/.exec(low.slice(0, x.index));
          spans.push([pre ? pre.index : x.index, x.index + 6]);
          break;
        }
      }
    }
    if (!date) {
      m = /\b(?:para\s+)?hoy\b/.exec(low);
      if (m) { date = ymd(today); take(m); }
    }
    if (!date) {
      m = new RegExp('\\b(?:(?:para\\s+)?el\\s+|este\\s+|(?:el\\s+)?proximo\\s+|(?:el\\s+)?siguiente\\s+)?(' + WEEKDAYS.join('|') + ')(\\s+que\\s+viene|\\s+proximo)?\\b').exec(low);
      if (m) {
        var target = WEEKDAYS.indexOf(m[1]);
        var diff = (target - today.getDay() + 7) % 7;
        var isThis = /^este\s/.test(m[0]);
        var isNext = /proximo|siguiente|que viene/.test(m[0]);
        if (diff === 0 && !isThis) diff = 7;
        if (isNext && diff === 0) diff = 7;
        date = ymd(addDays(today, diff));
        take(m);
      }
    }
    if (!date) {
      m = /\b(?:dentro\s+de|en)\s+(\d{1,2}|un|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|quince|veinte|treinta)\s+(dias?|semanas?|mes|meses)\b/.exec(low);
      if (m) {
        var n = toNum(m[1]);
        var base = new Date(today);
        if (/^semana/.test(m[2])) base = addDays(today, n * 7);
        else if (/^mes/.test(m[2])) { base = new Date(today.getFullYear(), today.getMonth() + n, Math.min(today.getDate(), 28)); }
        else base = addDays(today, n);
        date = ymd(base); take(m);
      }
    }
    if (!date) {
      m = /\b(?:para\s+)?el\s+(?:dia\s+)?(\d{1,2}|primero)\b(?!\s*[:.\/]\d)/.exec(low);
      if (m) {
        var d3 = toNum(m[1]);
        if (d3 >= 1 && d3 <= 31) {
          var c3 = validDate(today.getFullYear(), today.getMonth(), d3);
          if (!c3 || c3 < today) c3 = validDate(today.getFullYear(), today.getMonth() + 1, d3) ||
            validDate(today.getFullYear(), today.getMonth() + 2, d3);
          if (c3) { date = ymd(c3); take(m); }
        }
      }
    }

    // ---------- TÍTULO ----------
    spans.sort(function (a, b) { return b[0] - a[0]; });
    var title = src;
    spans.forEach(function (s) { title = title.slice(0, s[0]) + ' ' + title.slice(s[1]); });
    title = title.replace(/\s+/g, ' ').trim();
    // quitar órdenes iniciales
    var lowT = fold(title);
    var cmd = /^(?:por\s+favor\s+)?(?:recuerdame(?:\s+que)?|recordarme(?:\s+que)?|recordar(?:\s+que)?|recuerda(?:me)?(?:\s+que)?|anota(?:r)?(?:\s+que)?|apunta(?:r)?(?:\s+que)?|agenda(?:r)?(?:me)?|agrega(?:r)?|anade|programa(?:r)?|tengo(?:\s+que)?|nota)\b[\s,:]*/.exec(lowT);
    if (cmd) title = title.slice(cmd[0].length);
    // limpiar conectores sobrantes al inicio y al final
    for (var k = 0; k < 3; k++) {
      title = title.replace(/^(?:[,.;:\-]\s*|(?:y|para|el|la|de|a|que)\s+)/i, '')
        .replace(/(?:\s+(?:y|para|el|la|de|a|que)|\s*[,;:\-])$/i, '').trim();
    }
    if (title) title = title.charAt(0).toUpperCase() + title.slice(1);

    return { title: title, date: date, time: time };
  }

  var api = { parse: parse, fold: fold };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AgendaParser = api;
})(typeof window !== 'undefined' ? window : this);
