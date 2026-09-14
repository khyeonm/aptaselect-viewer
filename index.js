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
    { file: 'stage0_raw.ranked.tsv',           label: 'Raw',      sub: 'Stage 0' },
    { file: 'stage1_matching.ranked.tsv',      label: 'Matching', sub: 'Stage 1' },
    { file: 'stage2_flanking.ranked.tsv',      label: 'Flanking', sub: 'Stage 2' },
    { file: 'stage3_random_region.ranked.tsv', label: 'N region', sub: 'Stage 3' }
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
    chartH: 0,         // user-chosen graph-panel height (px), preserved across renders
    topView: 'seq',    // 'seq' (chart + tables) | 'motif' (MEME results)
    hasSeq: false,     // sorting outputs present (summary.txt / stage tables)
    hasMeme: false,    // meme_out/ present → show the Motif tab
    memeMotifs: null,  // parsed motifs from meme.xml
    memeBase: 'meme_out/'  // where meme files live: 'meme_out/' (run folder) or '' (meme_out opened directly)
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
  // Sub-path variant that keeps '/' so nested files (e.g. meme_out/meme.xml) resolve.
  function subUrl(path) { return '/file/' + path.split('/').map(encodeURIComponent).join('/'); }
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
    var names = STAGES.map(function (s) { return s.file; }).concat(['survival_summary.tsv']);
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
  // never loaded: we read forward, skip the header + earlier pages, take
  // PAGE_SIZE lines, then stop. Small files stream whole; large files (which the
  // server only serves via Range) are stitched from CHUNK-sized byte windows,
  // fetching the next window on demand so paging can go arbitrarily deep. A
  // cursor is reused when paging forward (Next); Prev/jump reopens from the top.
  // Visited pages are cached so re-visits (back/forward) render instantly.
  var _cur = null;         // { name, page, reader, dec, buf, eof, any, ranged, off, total }
  var _pageCache = {};     // name + '#' + page -> { rows, total }
  var CHUNK = 65536;       // 64KB per Range window for large files

  function _fetchChunk(name, start, total) {
    // Fetch bytes [start, end] (end clamped to the file size). Returns
    // { reader, total } or null past EOF.
    var end = start + CHUNK - 1;
    if (total != null && total > 0 && end > total - 1) end = total - 1;
    if (total != null && total > 0 && start > end) return Promise.resolve(null);
    return fetch(fileUrl(name), { headers: { Range: 'bytes=' + start + '-' + end } }).then(function (r) {
      if (r.status === 416) return null;
      if (!r.ok || !r.body) throw new Error(name + ' HTTP ' + (r.status || '?'));
      var t = null, cr = r.headers.get('Content-Range');
      if (cr) { var mm = cr.match(/\/(\d+)\s*$/); if (mm) t = +mm[1]; }
      return { reader: r.body.getReader(), total: t };
    });
  }

  function _open(name) {
    // Learn the file size from a 1-byte Range probe. This works for any size and
    // never touches the "empty body + huge Content-Length" response the server
    // sends for large files (which can surface as a stream error, not a clean
    // EOF). With the size known we stream fixed windows clamped to it, so small
    // and multi-GB files use the same safe path.
    return fetch(fileUrl(name), { headers: { Range: 'bytes=0-0' } }).then(function (r) {
      var total = null, cr = r.headers.get('Content-Range');
      if (cr) { var mm = cr.match(/\/(\d+)\s*$/); if (mm) total = +mm[1]; }
      if (r.body) { try { r.body.cancel(); } catch (e) {} } // discard the probe byte
      if (total != null) {
        return { name: name, page: -1, dec: new TextDecoder(), buf: '', eof: false,
                 reader: null, any: false, ranged: true, off: 0, total: total };
      }
      // Fallback (server gave no Content-Range): stream a plain GET whole.
      return fetch(fileUrl(name)).then(function (r2) {
        if (!r2.ok || !r2.body) throw new Error(name + ' HTTP ' + (r2.status || '?'));
        return { name: name, page: -1, dec: new TextDecoder(), buf: '', eof: false,
                 reader: r2.body.getReader(), any: false, ranged: false, off: 0, total: null };
      });
    });
  }
  function _line(c) {
    return new Promise(function (resolve) {
      (function pump() {
        var nl = c.buf.indexOf('\n');
        if (nl >= 0) { var l = c.buf.slice(0, nl); c.buf = c.buf.slice(nl + 1); resolve(l); return; }
        if (c.eof) { if (c.buf.length) { var t = c.buf; c.buf = ''; resolve(t); } else resolve(null); return; }
        if (!c.reader) {
          // Ranged mode: pull the next byte window, or finish.
          if (!c.ranged || (c.total != null && c.off >= c.total)) { c.eof = true; pump(); return; }
          _fetchChunk(c.name, c.off, c.total).then(function (ch) {
            if (!ch) { c.eof = true; pump(); return; }
            c.reader = ch.reader; if (ch.total != null) c.total = ch.total; c.off += CHUNK; pump();
          }).catch(function () { c.eof = true; pump(); });
          return;
        }
        c.reader.read().then(function (res) {
          if (res.done) {
            if (!c.any && !c.ranged && c.total > 0) {
              // Empty body for a non-empty file → large file served only via
              // Range. Switch to windowed streaming from the top.
              c.ranged = true; c.off = 0; c.reader = null; pump(); return;
            }
            if (c.ranged) { c.reader = null; pump(); return; } // window done → next
            c.eof = true; pump(); return;                      // small file done
          }
          c.any = true;
          c.buf += c.dec.decode(res.value, { stream: true }); pump();
        }).catch(function () { c.reader = null; c.eof = true; pump(); });
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
    var key = name + '#' + page;
    if (_pageCache[key]) return Promise.resolve(_pageCache[key]); // instant re-visit
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
        var rows = lines.map(function (ln, idx) { var x = ln.split('\t'); return { rank: page * PAGE_SIZE + idx + 1, count: +x[1], seq: x[0] }; })
          .filter(function (r) { return r.seq && !isNaN(r.count); });
        var result = { rows: rows, total: null }; // total comes from summary.txt
        _pageCache[key] = result;                  // cache for instant back/forward
        return result;
      });
    }).catch(function () { return { rows: [], total: null }; });
  }

  function parseSummary(text) {
    // survival_summary.tsv is a two-column "metric<TAB>value" table:
    //   total_reads_processed        <N>
    //   stage1_matching_survivors    <N>
    //   stage2_flanking_survivors    <N>
    //   stage3_random_region_survivors <N>
    //   derived_insert_length        <N>
    // The pipeline does not emit per-stage unique counts, so uniq stays null and
    // the per-stage % is derived from the survivor counts vs the raw total.
    var out = { total: 0, stages: [] };
    var pass = {}, rawUniq = null;
    text.split(/\r?\n/).forEach(function (ln) {
      var x = ln.split('\t');
      if (x.length < 2) return;
      var k = x[0].trim(), v = parseInt(x[1], 10);
      if (isNaN(v)) return;
      if (k === 'total_reads_processed' || k === 'total_input' || k === 'total_input_reads' || k === 'total_reads' || k === 'raw_reads') out.total = v;
      else if (k === 'raw_unique_sequences' || k === 'raw_unique' || k === 'stage0_raw_unique' || k === 'raw_unique_count' || k === 'unique_raw_sequences') rawUniq = v;
      else if (k === 'stage1_matching_survivors' || k === 'stage1_matching') pass[1] = v;
      else if (k === 'stage2_flanking_survivors' || k === 'stage2_flanking') pass[2] = v;
      else if (k === 'stage3_random_region_survivors' || k === 'stage3_random_region' || k === 'stage3_n_extraction') pass[3] = v;
    });
    // Stage 0 = raw: pass = total reads (non-deduplicated), uniq = deduplicated raw count.
    out.stages.push({ pass: out.total || null, pct: (out.total ? 100 : null), uniq: rawUniq });
    for (var i = 1; i <= 3; i++) {
      var p = pass[i] != null ? pass[i] : null;
      out.stages.push({ pass: p, pct: (p != null && out.total) ? (100 * p / out.total) : null, uniq: null });
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

  // ── Trend-line chart ──
  // The SVG is drawn at the panel's ACTUAL pixel size (viewBox == element size,
  // so scaling is 1:1 — no distortion of shapes or text) and redrawn on resize.
  // Dragging the divider grows the panel, which grows the graph proportionally.
  function buildChart() {
    var haveData = STAGES.some(function (_, i) { return (stagePass(i) || 0) > 0; });
    var head = '<div class="apta-chart-head"><b>Reads passing each stage</b>' +
      (state.summary && state.summary.total ? '<span class="apta-total"> · ' + fmt(state.summary.total) + ' read pairs</span>' : '') +
      '<button class="apta-dl" id="apta-dl-all" title="Download all stage tables + summary as a .zip">↓ Download all (.zip)</button>' +
      '</div>';
    var box = document.createElement('div');
    box.className = 'apta-chart';
    box.innerHTML = head;
    var holder = document.createElement('div');
    holder.className = 'apta-svg-holder';
    if (!haveData) holder.innerHTML = '<div class="apta-chart-empty">survival_summary.tsv not found — trend unavailable</div>';
    box.appendChild(holder);
    state._chartHolder = holder;
    return box;
  }

  function drawChart() {
    var holder = state._chartHolder;
    if (!holder || !holder.isConnected) return;
    var W = holder.clientWidth, H = holder.clientHeight;
    if (W < 40 || H < 40) return;
    // Chart points follow STAGES (Raw · Matching · Flanking · N). Raw's value is
    // the total read count (non-deduplicated); the other stages use survivor counts.
    var chartPoints = STAGES.map(function (s, i) { var p = stagePass(i); return { val: p != null ? p : 0, label: s.label, sub: s.sub }; });
    var vals = chartPoints.map(function (p) { return p.val; });
    if (!vals.some(function (v) { return v > 0; })) return;

    var padL = 56, padR = 20, padT = 22, padB = 40;
    function niceStep(v) { v = Math.abs(v) || 1; var mag = Math.pow(10, Math.floor(Math.log10(v))); return Math.max(1, mag / 10); }
    function roundUp(v) { var s = niceStep(v); return Math.ceil(v / s) * s; }
    function roundDown(v) { var s = niceStep(v); return Math.floor(v / s) * s; }
    var dataMax = Math.max.apply(null, vals);
    var pos = vals.filter(function (v) { return v > 0; });
    var dataMin = pos.length ? Math.min.apply(null, pos) : 0;
    var span = dataMax - dataMin;
    var broken = false, yMin = 0, yMax = roundUp((dataMax * 1.1) || 1);
    if (span > 0 && dataMin > 0.45 * dataMax) {
      var lo = roundDown(dataMin - span * 0.35);
      if (lo > 0) { broken = true; yMin = lo; yMax = roundUp(dataMax + span * 0.15); }
    }
    if (yMax <= yMin) yMax = yMin + 1;

    var innerW = W - padL - padR, innerH = H - padT - padB;
    function x(i) { return chartPoints.length > 1 ? padL + innerW * i / (chartPoints.length - 1) : padL + innerW / 2; }
    function y(v) { return padT + innerH * (1 - (v - yMin) / (yMax - yMin)); }

    // viewBox matches the pixel box → 1:1, so text keeps its CSS px size.
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="apta-svg" preserveAspectRatio="none">';
    [yMin, (yMin + yMax) / 2, yMax].forEach(function (v) {
      var yy = y(v);
      svg += '<line class="apta-grid" x1="' + padL + '" y1="' + yy + '" x2="' + (W - padR) + '" y2="' + yy + '"/>';
      svg += '<text class="apta-ylab" x="' + (padL - 8) + '" y="' + (yy + 4) + '">' + fmt(Math.round(v)) + '</text>';
    });
    if (broken) {
      var by = padT + innerH;
      svg += '<path class="apta-break" d="M' + (padL - 5) + ',' + (by - 1) + ' l9,-5 M' + (padL - 5) + ',' + (by + 4) + ' l9,-5"/>';
    }
    var pts = vals.map(function (v, i) { return x(i) + ',' + y(v); }).join(' ');
    svg += '<polyline class="apta-line" points="' + pts + '"/>';
    vals.forEach(function (v, i) {
      // Anchor the edge labels inward so "Join" / "2nd Sort" don't clip at the
      // panel edges (style attr overrides the CSS text-anchor).
      var anc = i === 0 ? 'start' : (i === chartPoints.length - 1 ? 'end' : 'middle');
      svg += '<circle class="apta-dot" cx="' + x(i) + '" cy="' + y(v) + '" r="4"/>';
      svg += '<text class="apta-val" style="text-anchor:' + anc + '" x="' + x(i) + '" y="' + (y(v) - 10) + '">' + fmt(v) + '</text>';
      svg += '<text class="apta-xlab" style="text-anchor:' + anc + '" x="' + x(i) + '" y="' + (H - 16) + '">' + chartPoints[i].label + '</text>';
      svg += '<text class="apta-xsub" style="text-anchor:' + anc + '" x="' + x(i) + '" y="' + (H - 3) + '">' + chartPoints[i].sub + '</text>';
    });
    svg += '</svg>';
    holder.innerHTML = svg;
  }

  // ── Tabs fused to the table + pager ──
  function buildBody() {
    var body = document.createElement('div');
    body.className = 'apta-body';

    var tabs = '<div class="apta-tabs" role="tablist">';
    STAGES.forEach(function (s, i) {
      // Show the non-deduplicated read count (survivors), matching the top chart,
      // on every stage tab — not the unique-sequence count.
      var pass = stagePass(i);
      tabs += '<button class="apta-tab' + (i === state.curStage ? ' active' : '') + '" data-stage="' + i + '" role="tab">' +
        '<span class="apta-tab-name">' + s.label + '</span>' +
        (pass != null ? '<span class="apta-tab-uniq">' + fmt(pass) + ' seq</span>' : '') +
        '</button>';
    });
    tabs += '</div>';

    var total = stageTotalRows(state.curStage);
    var totalKnown = total > 0;
    var totalPages = totalKnown ? Math.max(1, Math.ceil(total / PAGE_SIZE)) : null;
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

    var shownFrom = state.page.rows.length ? (start + 1) : 0;
    var shownTo = start + state.page.rows.length;
    // With a known total, cap paging at the last page. Without one (the survivor
    // summary has no unique count), keep Next enabled while the page is full —
    // a short page means we've reached the end.
    var canNext = state.loading ? false : (totalKnown ? (state.curPage < totalPages - 1) : (state.page.rows.length >= PAGE_SIZE));
    var pageInfo = totalKnown
      ? ('Page ' + (state.curPage + 1) + ' / ' + totalPages + ' · ranks ' + shownFrom + '–' + shownTo + ' of ' + fmt(total))
      : ('Page ' + (state.curPage + 1) + ' · ranks ' + shownFrom + '–' + shownTo);
    var pager = '<div class="apta-pager">' +
      '<button class="apta-pg" data-pg="prev"' + (state.curPage <= 0 || state.loading ? ' disabled' : '') + '>&laquo; Prev</button>' +
      '<span class="apta-pg-info">' + pageInfo + '</span>' +
      '<button class="apta-pg" data-pg="next"' + (canNext ? '' : ' disabled') + '>Next &raquo;</button>' +
      '</div>';
    tbl += pager + '</div>';

    body.innerHTML = tabs + tbl;
    return body;
  }

  // ── Motif (MEME) view ──────────────────────────────────────────────
  // meme_out/ is optional. If meme.xml is present the Motif tab appears and
  // shows one card per motif (logo + consensus + width/sites/E-value), parsed
  // from meme.xml. A link to the full MEME html report is always offered.
  function loadMeme() {
    // meme.xml can live under two layouts depending on what was opened:
    //   'meme_out/'  → the whole RUN folder was opened (meme_out is a subfolder)
    //   ''           → the meme_out folder itself was opened (files at the root)
    // Try the subfolder layout first, then fall back to the root layout, and
    // remember the base that worked so logos/report resolve from the same place.
    var bases = ['meme_out/', ''];
    function tryBase(idx) {
      if (idx >= bases.length) return Promise.resolve(false);
      var base = bases[idx];
      return fetch(subUrl(base + 'meme.xml')).then(function (r) {
        if (!r.ok) return tryBase(idx + 1);
        return r.text().then(function (xml) {
          state.memeBase = base;
          try {
            var doc = new DOMParser().parseFromString(xml, 'text/xml');
            var ms = doc.getElementsByTagName('motif'), out = [];
            for (var i = 0; i < ms.length; i++) {
              var m = ms[i];
              out.push({
                consensus: m.getAttribute('name') || m.getAttribute('id') || ('motif ' + (i + 1)),
                width: m.getAttribute('width') || '?',
                sites: m.getAttribute('sites') || '?',
                evalue: m.getAttribute('e_value') || m.getAttribute('evalue') || '?',
                logo: subUrl(base + 'logo' + (i + 1) + '.png')
              });
            }
            state.memeMotifs = out;
          } catch (e) { state.memeMotifs = null; }
          return true; // meme.xml exists → show the tab even if parsing was thin
        });
      }).catch(function () { return tryBase(idx + 1); });
    }
    return tryBase(0);
  }

  function buildViewTabs() {
    var t = document.createElement('div');
    t.className = 'apta-viewtabs';
    t.innerHTML =
      '<button class="apta-vtab' + (state.topView === 'seq' ? ' active' : '') + '" data-view="seq">Sequences</button>' +
      '<button class="apta-vtab' + (state.topView === 'motif' ? ' active' : '') + '" data-view="motif">Motif (MEME)</button>';
    return t;
  }

  function buildMotif() {
    var box = document.createElement('div');
    box.className = 'apta-motif';
    // memeBase is '' when the meme_out folder was opened directly; a falsy-OR
    // would wrongly rewrite that back to 'meme_out/', so use it as-is.
    var base = typeof state.memeBase === 'string' ? state.memeBase : 'meme_out/';
    var report = subUrl(base + 'meme.html');
    var head = '<div class="apta-motif-head">' +
      '<a class="apta-dl apta-motif-full" href="' + report + '" target="_blank" rel="noopener">View full report ↗</a></div>';
    var list = '';
    if (state.memeMotifs && state.memeMotifs.length) {
      state.memeMotifs.forEach(function (m, i) {
        // Logo image intentionally omitted from the cards: the PNGs are slow to
        // load and the same logos appear in the full MEME report anyway. The
        // "View full report" link (above) still shows them.
        list += '<div class="apta-motif-card">' +
          '<div class="apta-motif-meta">' +
            '<div class="apta-motif-rank">Motif ' + (i + 1) + '</div>' +
            '<div class="apta-motif-consensus"><code>' + esc(m.consensus) + '</code></div>' +
            '<div class="apta-motif-stats">' +
              '<span>width <b>' + esc(m.width) + '</b></span>' +
              '<span>sites <b>' + esc(m.sites) + '</b></span>' +
              '<span>E-value <b>' + esc(m.evalue) + '</b></span>' +
            '</div>' +
          '</div>' +
        '</div>';
      });
    } else {
      list = '<div class="apta-motif-empty">Motif details couldn\'t be parsed here. ' +
        '<a href="' + report + '" target="_blank" rel="noopener">Open the MEME report</a> to view the full results.</div>';
    }
    box.innerHTML = head + '<div class="apta-motif-list">' + list + '</div>';
    return box;
  }

  // View-tab clicks via delegation on the (persistent) root element. render()
  // rebuilds root.innerHTML on every change, so per-button listeners are fragile;
  // one delegated listener on root survives all rebuilds and is bound just once.
  function setupViewDelegation() {
    if (state._viewBound) return;
    state._viewBound = true;
    state.root.addEventListener('click', function (e) {
      if (!e.target || !e.target.closest) return;
      // View tab switch. (The per-card "Open report" link handles itself.)
      var vt = e.target.closest('.apta-vtab');
      if (vt && state.root.contains(vt)) {
        var v = vt.getAttribute('data-view');
        if (v !== state.topView) { state.topView = v; render(); }
      }
    });
  }

  function render() {
    var el = state.root;
    el.innerHTML = '';
    var wrap = document.createElement('div');
    wrap.className = 'apta';

    // meme-only mode: MEME results but no sorting outputs (e.g. meme_out opened
    // directly) → show just the Motif view, no top-level tabs.
    if (state.hasMeme && !state.hasSeq) {
      wrap.appendChild(buildMotif());
      el.appendChild(wrap);
      return;
    }

    // Both present → top-level view tabs (Sequences | Motif).
    if (state.hasMeme && state.hasSeq) wrap.appendChild(buildViewTabs());

    // Motif (MEME) view is separate from the sequence chart/tables.
    if (state.topView === 'motif') {
      wrap.appendChild(buildMotif());
      el.appendChild(wrap);
      return;
    }

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
    // Draw the chart at its real pixel size, and redraw whenever the panel
    // resizes (e.g. the user drags the divider) so the graph scales 1:1.
    requestAnimationFrame(drawChart);
    if (state._ro) { state._ro.disconnect(); state._ro = null; }
    if (window.ResizeObserver && state._chartHolder) {
      state._ro = new ResizeObserver(function () { drawChart(); });
      state._ro.observe(state._chartHolder);
    }
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
        var totalKnown = total > 0;
        var totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
        // Mirror the render-time canNext logic: when the total is unknown
        // (large streamed stages have no summary unique count), allow Next as
        // long as the current page came back full.
        var canNext = totalKnown
          ? (state.curPage < totalPages - 1)
          : (state.page.rows.length >= PAGE_SIZE);
        var pg = this.getAttribute('data-pg');
        if (pg === 'prev' && state.curPage > 0) loadStage(state.curStage, state.curPage - 1);
        else if (pg === 'next' && canNext) loadStage(state.curStage, state.curPage + 1);
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
      state.topView = 'seq';
      state.hasSeq = false;
      state.hasMeme = false;
      state.memeMotifs = null;
      // Fresh streaming state + page cache for this run.
      if (_cur && _cur.reader) { try { _cur.reader.cancel(); } catch (e) {} }
      _cur = null;
      _pageCache = {};
      setupViewDelegation();
      container.innerHTML = '<div class="apta-loading">Loading AptaSelect results…</div>';

      Promise.all([
        fetchText('survival_summary.tsv').then(function (t) { return parseSummary(t); }, function () { return null; }),
        loadMeme()
      ])
        .then(function (res) {
          state.summary = res[0];
          state.hasMeme = res[1];
          // Default to the final stage (N region); if it's empty, fall back to
          // the deepest stage that has rows.
          return fetchPage(STAGES[3].file, 0).then(function (pg) {
            state.hasSeq = !!state.summary || pg.rows.length > 0;
            // meme-only: MEME results present but no sorting outputs (meme_out
            // opened directly) → show the Motif view only, skip stage probing.
            if (!state.hasSeq && state.hasMeme) {
              state.topView = 'motif'; state.loading = false; render(); return;
            }
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
      _pageCache = {};
      if (state._ro) { try { state._ro.disconnect(); } catch (e) {} }
      state = { root: null, summary: null, curStage: 3, curPage: 0, page: { rows: [], total: 0 }, loading: false, reqId: 0, chartH: 0, topView: 'seq', hasSeq: false, hasMeme: false, memeMotifs: null, memeBase: 'meme_out/' };
    }
  };
})();
