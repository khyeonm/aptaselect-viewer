// AptaSelect pipeline viewer.
//
// A PIPELINE viewer (whole output folder → one dashboard), not an extension
// viewer. Layout:
//   • top, sticky: per-stage count trend line (Join → Sel → Sort1 → Sort2),
//     drawn from the small summary.txt — read once.
//   • below: Excel-style stage tabs fused to a count-descending table.
//
// Streaming paging: the table never loads a whole stage file. Each page (and
// every tab switch / Next / Prev) fetches only that page of rows via
// /data/<stage>?page=N&page_size=25. The server returns { rows, total } with
// the header row already stripped and total = number of DATA rows.
(function () {
  'use strict';

  var STAGES = [
    { file: 'stage1_joined_ranked.tsv',    label: 'Join',      sub: 'Stage 1' },
    { file: 'stage2_selection_ranked.tsv', label: 'Selection', sub: 'Stage 2' },
    { file: 'stage3_sort1_ranked.tsv',     label: '1st Sort',  sub: 'Stage 3' },
    { file: 'stage4_sort2_ranked.tsv',     label: '2nd Sort',  sub: 'Stage 4' }
  ];
  var PAGE_SIZE = 20;

  var MARKS = [
    { seq: 'CCACTTCTCCTTCCATCCTAAAC', cls: 'apta-selL' }, // selection left primer
    { seq: 'GAGTAGTTTGGAGGGTTGTCTG',  cls: 'apta-selR' }, // selection right primer
    { seq: 'TCTCTCTCTC',              cls: 'apta-s2'   }, // 2nd-sort motif
    { seq: 'GAGAGAGAGA',              cls: 'apta-s2'   }  // 2nd-sort motif
  ];

  var state = {
    root: null,
    summary: null,     // { total, stages:[{pass,pct,uniq}] }
    curStage: 3,
    curPage: 0,
    page: { rows: [], total: 0 },  // rows currently shown (this page only)
    loading: false,
    reqId: 0,          // guards against out-of-order page responses
    chartH: 0          // user-chosen graph-panel height (px), preserved across renders
  };

  // Drag-to-resize between the graph (top) and the table (bottom). Listeners are
  // registered once; the handle's mousedown arms _drag on each render.
  var _drag = { on: false, startY: 0, startH: 0, chart: null, wrap: null };
  window.addEventListener('mousemove', function (e) {
    if (!_drag.on) return;
    var max = _drag.wrap.getBoundingClientRect().height - 160;
    var h = _drag.startH + (e.clientY - _drag.startY);
    h = Math.max(120, Math.min(h, Math.max(120, max)));
    state.chartH = h;
    _drag.chart.style.flex = '0 0 ' + h + 'px';
    _drag.chart.style.height = h + 'px';
  });
  window.addEventListener('mouseup', function () {
    if (_drag.on) { _drag.on = false; document.body.style.cursor = ''; document.body.style.userSelect = ''; }
  });

  function fileUrl(name) { return '/file/' + encodeURIComponent(name); }
  function fmt(n) { return Number(n).toLocaleString(); }
  function esc(s) { return String(s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }

  // ── ZIP (store / no compression) — bundle all stage TSVs + summary so the
  // whole result downloads as one file, built entirely in the browser (no libs,
  // no server changes). ──
  var _crcTable = (function () {
    var t = [];
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function _crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = _crcTable[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function _makeZip(files) {
    var enc = new TextEncoder();
    var chunks = [], central = [], offset = 0;
    function u16(n) { return [n & 0xFF, (n >> 8) & 0xFF]; }
    function u32(n) { return [n & 0xFF, (n >> 8) & 0xFF, (n >> 16) & 0xFF, (n >> 24) & 0xFF]; }
    files.forEach(function (f) {
      var nameB = enc.encode(f.name);
      var crc = _crc32(f.bytes), size = f.bytes.length;
      var lfh = [].concat(u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
        u32(crc), u32(size), u32(size), u16(nameB.length), u16(0));
      chunks.push(new Uint8Array(lfh), nameB, f.bytes);
      var cdh = [].concat(u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
        u32(crc), u32(size), u32(size), u16(nameB.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset));
      central.push({ h: new Uint8Array(cdh), n: nameB });
      offset += lfh.length + nameB.length + size;
    });
    var cStart = offset, cSize = 0;
    central.forEach(function (c) { chunks.push(c.h, c.n); cSize += c.h.length + c.n.length; });
    var eocd = [].concat(u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length),
      u32(cSize), u32(cStart), u16(0));
    chunks.push(new Uint8Array(eocd));
    var total = chunks.reduce(function (a, c) { return a + c.length; }, 0);
    var out = new Uint8Array(total), p = 0;
    chunks.forEach(function (c) { out.set(c, p); p += c.length; });
    return out;
  }
  function downloadAllZip() {
    var names = STAGES.map(function (s) { return s.file; }).concat(['summary.txt']);
    Promise.all(names.map(function (n) {
      return fetch(fileUrl(n))
        .then(function (r) { return r.ok ? r.arrayBuffer() : null; })
        .then(function (buf) { return buf ? { name: n, bytes: new Uint8Array(buf) } : null; })
        .catch(function () { return null; });
    })).then(function (files) {
      files = files.filter(Boolean);
      if (!files.length) { alert('No result files available to download.'); return; }
      var blob = new Blob([_makeZip(files)], { type: 'application/zip' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'aptaselect_results.zip';
      document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    });
  }

  function fetchText(name) {
    return fetch(fileUrl(name)).then(function (r) {
      if (!r.ok) throw new Error(name + ': HTTP ' + r.status);
      return r.text();
    });
  }

  // Streaming line paging over the raw TSV at /file/<name>. The whole file is
  // never loaded: we read the response body forward, skip the header + earlier
  // pages, take PAGE_SIZE lines, then stop — so a huge stage file only streams
  // its leading bytes. A cursor is reused when paging forward (Next); Prev or a
  // tab switch reopens from the top. Total row count comes from summary.txt.
  var _cur = null; // { name, page, reader, dec, buf, eof }

  function _open(name) {
    return fetch(fileUrl(name)).then(function (r) {
      if (!r.ok || !r.body) throw new Error(name + ' HTTP ' + (r.status || '?'));
      return { name: name, page: -1, reader: r.body.getReader(), dec: new TextDecoder(), buf: '', eof: false };
    });
  }
  function _line(c) {
    return new Promise(function (resolve) {
      (function pump() {
        var nl = c.buf.indexOf('\n');
        if (nl >= 0) { var l = c.buf.slice(0, nl); c.buf = c.buf.slice(nl + 1); resolve(l); return; }
        if (c.eof) { if (c.buf.length) { var t = c.buf; c.buf = ''; resolve(t); } else resolve(null); return; }
        c.reader.read().then(function (res) {
          if (res.done) { c.eof = true; pump(); return; }
          c.buf += c.dec.decode(res.value, { stream: true }); pump();
        }).catch(function () { c.eof = true; pump(); });
      })();
    });
  }
  function _lines(c, n) {
    var out = [];
    return (function step() {
      if (out.length >= n) return Promise.resolve(out);
      return _line(c).then(function (l) { if (l === null) return out; if (l.length) out.push(l); return step(); });
    })();
  }
  function fetchPage(name, page) {
    var reuse = _cur && _cur.name === name && _cur.page === page - 1 && !_cur.eof;
    var setup = reuse ? Promise.resolve(_cur) : _open(name).then(function (c) {
      if (_cur && _cur.reader) { try { _cur.reader.cancel(); } catch (e) {} }
      _cur = c;
      return _line(c).then(function () {               // drop header row
        var skip = page * PAGE_SIZE;
        return (function sk() {
          if (skip <= 0) return Promise.resolve();
          return _line(c).then(function (l) { if (l === null) { c.eof = true; return; } skip--; return sk(); });
        })();
      }).then(function () { return c; });
    });
    return setup.then(function (c) {
      return _lines(c, PAGE_SIZE).then(function (lines) {
        c.page = page;
        var rows = lines.map(function (ln) { var x = ln.split('\t'); return { rank: +x[0], count: +x[1], seq: x[2] }; })
          .filter(function (r) { return r.seq && !isNaN(r.rank); });
        return { rows: rows, total: null }; // total comes from summary.txt
      });
    }).catch(function () { return { rows: [], total: null }; });
  }

  function parseSummary(text) {
    var out = { total: 0, stages: [] };
    var m = text.match(/Total read pairs:\s*(\d+)/);
    if (m) out.total = parseInt(m[1], 10);
    var passRe = /Stage\s*(\d)\s*\([^)]*\):\s*(\d+)\s*\(([\d.]+)%\)/g;
    var uniqRe = /Stage\s*(\d)\s*unique sequences:\s*(\d+)/g;
    var pass = {}, uniq = {}, mm;
    while ((mm = passRe.exec(text))) pass[mm[1]] = { pass: +mm[2], pct: +mm[3] };
    while ((mm = uniqRe.exec(text))) uniq[mm[1]] = +mm[2];
    for (var i = 1; i <= 4; i++) {
      out.stages.push({ pass: pass[i] ? pass[i].pass : null, pct: pass[i] ? pass[i].pct : null, uniq: uniq[i] != null ? uniq[i] : null });
    }
    return out;
  }

  function stagePass(i) { return state.summary && state.summary.stages[i] ? state.summary.stages[i].pass : null; }
  function stageUniq(i) { return state.summary && state.summary.stages[i] ? state.summary.stages[i].uniq : null; }
  function stageTotalRows(i) {
    // Rows in the current stage table: prefer the page's reported total, fall
    // back to summary unique count.
    if (i === state.curStage && state.page.total) return state.page.total;
    var u = stageUniq(i);
    return u != null ? u : 0;
  }

  // ── Sequence highlighting ──
  function highlightSeq(seq) {
    var cls = new Array(seq.length);
    MARKS.forEach(function (m) {
      var idx = seq.indexOf(m.seq);
      while (idx >= 0) {
        for (var k = 0; k < m.seq.length; k++) if (!cls[idx + k]) cls[idx + k] = m.cls;
        idx = seq.indexOf(m.seq, idx + 1);
      }
    });
    var html = '', i = 0;
    while (i < seq.length) {
      var c = cls[i], j = i;
      while (j < seq.length && cls[j] === c) j++;
      var chunk = esc(seq.slice(i, j));
      html += c ? '<span class="' + c + '">' + chunk + '</span>' : chunk;
      i = j;
    }
    return html;
  }

  // ── Trend-line chart (inline SVG) — from summary.txt only ──
  function buildChart() {
    var W = 640, H = 210, padL = 56, padR = 20, padT = 24, padB = 40;
    var vals = STAGES.map(function (_, i) { var p = stagePass(i); return p != null ? p : 0; });
    var haveData = vals.some(function (v) { return v > 0; });
    var innerW = W - padL - padR, innerH = H - padT - padB;

    // "nice" rounding step (a tenth of the magnitude), so axis bounds land on
    // round numbers without overshooting — e.g. 10,662 rounds to 11,000, not
    // 15,000.
    function niceStep(v) { v = Math.abs(v) || 1; var mag = Math.pow(10, Math.floor(Math.log10(v))); return Math.max(1, mag / 10); }
    function roundUp(v) { var s = niceStep(v); return Math.ceil(v / s) * s; }
    function roundDown(v) { var s = niceStep(v); return Math.floor(v / s) * s; }

    // y-axis bounds: leave ~10% headroom above the tallest point so Join isn't
    // glued to the ceiling. When every stage sits high above zero (small
    // relative differences), start the axis above zero — a "broken axis" — so
    // the stage-to-stage drop stays legible instead of looking flat.
    var dataMax = Math.max.apply(null, vals);
    var pos = vals.filter(function (v) { return v > 0; });
    var dataMin = pos.length ? Math.min.apply(null, pos) : 0;
    var span = dataMax - dataMin;
    var broken = false, yMin = 0, yMax = roundUp((dataMax * 1.1) || 1);
    if (haveData && span > 0 && dataMin > 0.45 * dataMax) {
      var lo = roundDown(dataMin - span * 0.35);
      if (lo > 0) { broken = true; yMin = lo; yMax = roundUp(dataMax + span * 0.15); }
    }
    if (yMax <= yMin) yMax = yMin + 1;

    function x(i) { return padL + innerW * i / (STAGES.length - 1); }
    function y(v) { return padT + innerH * (1 - (v - yMin) / (yMax - yMin)); }

    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="apta-svg" preserveAspectRatio="xMidYMid meet">';
    [yMin, (yMin + yMax) / 2, yMax].forEach(function (v) {
      var yy = y(v);
      svg += '<line class="apta-grid" x1="' + padL + '" y1="' + yy + '" x2="' + (W - padR) + '" y2="' + yy + '"/>';
      svg += '<text class="apta-ylab" x="' + (padL - 8) + '" y="' + (yy + 4) + '">' + fmt(Math.round(v)) + '</text>';
    });
    // broken-axis mark: a small double slash at the base of the y-axis.
    if (broken) {
      var by = padT + innerH;
      svg += '<path class="apta-break" d="M' + (padL - 5) + ',' + (by - 1) + ' l9,-5 M' + (padL - 5) + ',' + (by + 4) + ' l9,-5"/>';
    }
    if (haveData) {
      var pts = vals.map(function (v, i) { return x(i) + ',' + y(v); }).join(' ');
      svg += '<polyline class="apta-line" points="' + pts + '"/>';
    }
    vals.forEach(function (v, i) {
      if (haveData) {
        svg += '<circle class="apta-dot" cx="' + x(i) + '" cy="' + y(v) + '" r="4"/>';
        svg += '<text class="apta-val" x="' + x(i) + '" y="' + (y(v) - 10) + '">' + fmt(v) + '</text>';
      }
      svg += '<text class="apta-xlab" x="' + x(i) + '" y="' + (H - 16) + '">' + STAGES[i].label + '</text>';
      svg += '<text class="apta-xsub" x="' + x(i) + '" y="' + (H - 3) + '">' + STAGES[i].sub + '</text>';
    });
    svg += '</svg>';

    var head = '<div class="apta-chart-head"><b>Reads passing each stage</b>' +
      (state.summary && state.summary.total ? '<span class="apta-total"> · ' + fmt(state.summary.total) + ' read pairs</span>' : '') +
      '<button class="apta-dl" id="apta-dl-all" title="Download all stage tables + summary as a .zip">↓ Download all (.zip)</button>' +
      '</div>';
    var box = document.createElement('div');
    box.className = 'apta-chart';
    box.innerHTML = head + svg + (haveData ? '' : '<div class="apta-chart-empty">summary.txt not found — trend unavailable</div>');
    return box;
  }

  // ── Tabs fused to the table + pager ──
  function buildBody() {
    var body = document.createElement('div');
    body.className = 'apta-body';

    var tabs = '<div class="apta-tabs" role="tablist">';
    STAGES.forEach(function (s, i) {
      var uniq = stageUniq(i);
      tabs += '<button class="apta-tab' + (i === state.curStage ? ' active' : '') + '" data-stage="' + i + '" role="tab">' +
        '<span class="apta-tab-name">' + s.label + '</span>' +
        (uniq != null ? '<span class="apta-tab-uniq">' + fmt(uniq) + ' seq</span>' : '') +
        '</button>';
    });
    tabs += '</div>';

    var total = stageTotalRows(state.curStage);
    var totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    var start = state.curPage * PAGE_SIZE;

    var tbl = '<div class="apta-panel"><div class="apta-tablewrap"><table class="apta-table"><thead><tr>' +
      '<th class="apta-c-rank">Rank</th><th class="apta-c-count">Count</th><th class="apta-c-seq">Sequence</th>' +
      '</tr></thead><tbody>';
    if (state.loading) {
      tbl += '<tr><td colspan="3" class="apta-empty">Loading page…</td></tr>';
    } else if (!state.page.rows.length) {
      tbl += '<tr><td colspan="3" class="apta-empty">No sequences in this stage.</td></tr>';
    } else {
      state.page.rows.forEach(function (r) {
        tbl += '<tr><td class="apta-c-rank">' + r.rank + '</td>' +
          '<td class="apta-c-count">' + fmt(r.count) + '</td>' +
          '<td class="apta-c-seq"><code>' + highlightSeq(r.seq) + '</code></td></tr>';
      });
    }
    tbl += '</tbody></table></div>';

    var shownFrom = total ? (start + 1) : 0;
    var shownTo = Math.min(start + PAGE_SIZE, total);
    var pager = '<div class="apta-pager">' +
      '<button class="apta-pg" data-pg="prev"' + (state.curPage <= 0 || state.loading ? ' disabled' : '') + '>&laquo; Prev</button>' +
      '<span class="apta-pg-info">Page ' + (state.curPage + 1) + ' / ' + totalPages +
      ' · ranks ' + shownFrom + '–' + shownTo + ' of ' + fmt(total) + '</span>' +
      '<button class="apta-pg" data-pg="next"' + (state.curPage >= totalPages - 1 || state.loading ? ' disabled' : '') + '>Next &raquo;</button>' +
      '</div>';
    tbl += pager + '</div>';

    body.innerHTML = tabs + tbl;
    return body;
  }

  function render() {
    var el = state.root;
    el.innerHTML = '';
    var wrap = document.createElement('div');
    wrap.className = 'apta';
    var chart = buildChart();          // top panel (.apta-chart)
    var handle = document.createElement('div');
    handle.className = 'apta-drag';
    handle.title = 'Drag to resize graph / table';
    var body = buildBody();            // bottom panel (.apta-body)
    // Preserve the user's chosen split across re-renders (tab / page changes).
    if (state.chartH) {
      chart.style.flex = '0 0 ' + state.chartH + 'px';
      chart.style.height = state.chartH + 'px';
    }
    wrap.appendChild(chart);
    wrap.appendChild(handle);
    wrap.appendChild(body);
    el.appendChild(wrap);
    bindEvents();
    handle.addEventListener('mousedown', function (e) {
      _drag.on = true;
      _drag.startY = e.clientY;
      _drag.startH = chart.getBoundingClientRect().height;
      _drag.chart = chart;
      _drag.wrap = wrap;
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });
  }

  function bindEvents() {
    var el = state.root;
    var dl = el.querySelector('#apta-dl-all');
    if (dl) dl.addEventListener('click', downloadAllZip);
    el.querySelectorAll('.apta-tab').forEach(function (b) {
      b.addEventListener('click', function () {
        var i = parseInt(this.getAttribute('data-stage'), 10);
        if (i !== state.curStage) loadStage(i, 0);
      });
    });
    el.querySelectorAll('.apta-pg').forEach(function (b) {
      b.addEventListener('click', function () {
        var total = stageTotalRows(state.curStage);
        var totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
        var pg = this.getAttribute('data-pg');
        if (pg === 'prev' && state.curPage > 0) loadStage(state.curStage, state.curPage - 1);
        else if (pg === 'next' && state.curPage < totalPages - 1) loadStage(state.curStage, state.curPage + 1);
      });
    });
  }

  // Fetch exactly one page (streaming) and re-render. reqId guards against a
  // slow earlier request overwriting a newer one.
  function loadStage(stageIdx, page) {
    state.curStage = stageIdx;
    state.curPage = page;
    state.loading = true;
    var my = ++state.reqId;
    render(); // shows "Loading page…" with tabs/chart intact
    return fetchPage(STAGES[stageIdx].file, page).then(function (pg) {
      if (my !== state.reqId) return; // superseded
      state.page = pg;
      state.loading = false;
      render();
    });
  }

  window.AutoPipePlugin = {
    render: function (container /*, fileUrl, filename */) {
      state.root = container;
      state.curStage = 3;
      state.curPage = 0;
      state.page = { rows: [], total: 0 };
      state.loading = true;
      state.reqId = 0;
      container.innerHTML = '<div class="apta-loading">Loading AptaSelect results…</div>';

      fetchText('summary.txt')
        .then(function (t) { state.summary = parseSummary(t); })
        .catch(function () { state.summary = null; })
        .then(function () {
          // Default to Stage 4 (final candidates); if it's empty, fall back to
          // the deepest stage that has rows.
          return fetchPage(STAGES[3].file, 0).then(function (pg) {
            if (pg.rows.length) { state.curStage = 3; state.page = pg; state.loading = false; render(); return; }
            // probe earlier stages
            var i = 2;
            (function tryStage() {
              if (i < 0) { state.loading = false; render(); return; }
              fetchPage(STAGES[i].file, 0).then(function (p2) {
                if (p2.rows.length) { state.curStage = i; state.page = p2; state.loading = false; render(); }
                else { i--; tryStage(); }
              });
            })();
          });
        })
        .catch(function (e) {
          container.innerHTML = '<div class="apta-error">Failed to load AptaSelect results: ' + esc(e.message) + '</div>';
        });
    },
    destroy: function () {
      if (_cur && _cur.reader) { try { _cur.reader.cancel(); } catch (e) {} }
      _cur = null;
      state = { root: null, summary: null, curStage: 3, curPage: 0, page: { rows: [], total: 0 }, loading: false, reqId: 0 };
    }
  };
})();
