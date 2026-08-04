/* ============================================================
 * charts.js — 依存ゼロの Canvas チャート（折れ線 / 散布 / 縦棒）
 * ・DPR対応、ライト/ダーク両対応（色はCSSカスタムプロパティから取得）
 * ・ホバー時のクロスヘア＋ツールチップ、キーボードフォーカス対応
 * ・すべてのチャートに「表として見る」フォールバックを併設
 * グローバル VBT.Charts に公開する。
 * ============================================================ */
(function (global) {
  'use strict';

  var registry = [];

  function css(el, name, fallback) {
    var v = getComputedStyle(el).getPropertyValue(name).trim();
    return v || fallback;
  }

  function tokens(el) {
    return {
      surface: css(el, '--surface-1', '#fcfcfb'),
      primary: css(el, '--text-primary', '#0b0b0b'),
      secondary: css(el, '--text-secondary', '#52514e'),
      muted: css(el, '--text-muted', '#898781'),
      grid: css(el, '--grid', '#e1e0d9'),
      axis: css(el, '--axis', '#c3c2b7'),
      series: [
        css(el, '--series-1', '#2a78d6'),
        css(el, '--series-2', '#eb6834'),
        css(el, '--series-3', '#1baf7a')
      ]
    };
  }

  function niceTicks(min, max, count) {
    if (!isFinite(min) || !isFinite(max)) { min = 0; max = 1; }
    if (max - min < 1e-9) { min -= 0.5; max += 0.5; }
    var span = max - min;
    var step = Math.pow(10, Math.floor(Math.log(span / count) / Math.LN10));
    var err = span / count / step;
    if (err >= 7.5) step *= 10; else if (err >= 3) step *= 5; else if (err >= 1.5) step *= 2;
    var ticks = [];
    var start = Math.ceil(min / step - 1e-9) * step;
    for (var v = start; v <= max + step * 1e-6; v += step) ticks.push(Math.abs(v) < step * 1e-6 ? 0 : v);
    return ticks;
  }

  function fmtNum(v, d) {
    if (v == null || !isFinite(v)) return '—';
    var s = Math.abs(v) >= 1000
      ? Math.round(v).toLocaleString('ja-JP')
      : v.toFixed(d == null ? 2 : d);
    return s;
  }

  /* ---------- 共通の描画フレーム ---------- */
  function setupCanvas(canvas, cssW, cssH) {
    var dpr = global.devicePixelRatio || 1;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    return ctx;
  }

  function drawFrame(ctx, T, box, xTicks, yTicks, cfg) {
    ctx.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.lineWidth = 1;

    // 横グリッド（ヘアライン・実線・後退色）
    ctx.strokeStyle = T.grid;
    ctx.fillStyle = T.muted;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    yTicks.forEach(function (v) {
      var y = Math.round(box.py(v)) + 0.5;
      if (y < box.top - 1 || y > box.bottom + 1) return;
      ctx.beginPath(); ctx.moveTo(box.left, y); ctx.lineTo(box.right, y); ctx.stroke();
      ctx.fillText(cfg.yFormat ? cfg.yFormat(v) : fmtNum(v, cfg.yDecimals), box.left - 8, y);
    });

    // 基線
    ctx.strokeStyle = T.axis;
    var yb = Math.round(box.bottom) + 0.5;
    ctx.beginPath(); ctx.moveTo(box.left, yb); ctx.lineTo(box.right, yb); ctx.stroke();

    // x軸ラベル
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = T.muted;
    xTicks.forEach(function (v) {
      var x = box.px(v);
      if (x < box.left - 1 || x > box.right + 1) return;
      ctx.fillText(cfg.xFormat ? cfg.xFormat(v) : fmtNum(v, cfg.xDecimals), x, box.bottom + 7);
    });

    // 軸タイトル
    ctx.fillStyle = T.secondary;
    if (cfg.yLabel) {
      ctx.save();
      ctx.translate(12, (box.top + box.bottom) / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(cfg.yLabel, 0, 0);
      ctx.restore();
    }
    if (cfg.xLabel) {
      ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillText(cfg.xLabel, (box.left + box.right) / 2, box.h - 2);
    }
  }

  /* ---------- DOM 組み立て ---------- */
  function buildShell(container, cfg) {
    container.textContent = '';
    container.classList.add('chart');

    // タイトルと説明は update() のたびに書き換わるので、常に用意しておく
    var h = document.createElement('h3');
    h.className = 'chart-title';
    container.appendChild(h);
    var st = document.createElement('p');
    st.className = 'chart-sub';
    container.appendChild(st);

    var legend = document.createElement('div');
    legend.className = 'chart-legend';
    container.appendChild(legend);

    var frame = document.createElement('div');
    frame.className = 'chart-frame';
    var canvas = document.createElement('canvas');
    canvas.tabIndex = 0;
    canvas.setAttribute('role', 'img');
    frame.appendChild(canvas);
    var tip = document.createElement('div');
    tip.className = 'chart-tip';
    tip.hidden = true;
    frame.appendChild(tip);
    container.appendChild(frame);

    var det = document.createElement('details');
    det.className = 'chart-table';
    var sum = document.createElement('summary');
    sum.textContent = 'データを表で見る';
    det.appendChild(sum);
    var tblWrap = document.createElement('div');
    tblWrap.className = 'table-scroll';
    det.appendChild(tblWrap);
    container.appendChild(det);

    return {
      legend: legend, frame: frame, canvas: canvas, tip: tip, table: tblWrap,
      setHeader: function (c) {
        h.textContent = c.title || ''; h.hidden = !c.title;
        st.textContent = c.subtitle || ''; st.hidden = !c.subtitle;
      }
    };
  }

  // 幅が狭いほど目盛りを減らし、ラベルの重なりを防ぐ
  function tickCount(width) { return Math.max(3, Math.min(6, Math.floor(width / 95))); }

  // y軸ラベルの実寸を測って左マージンを決める（軸タイトルと目盛りの衝突を防ぐ）
  function leftMargin(ctx, yTicks, cfg) {
    ctx.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';
    var maxW = 0;
    yTicks.forEach(function (v) {
      var s = cfg.yFormat ? cfg.yFormat(v) : fmtNum(v, cfg.yDecimals);
      maxW = Math.max(maxW, ctx.measureText(s).width);
    });
    return Math.ceil((cfg.yLabel ? 22 : 6) + maxW + 8);
  }

  function renderLegend(el, series, T, markType) {
    el.textContent = '';
    if (series.length < 2) return; // 単系列は凡例なし（タイトルが何を示すか語る）
    series.forEach(function (s, i) {
      var item = document.createElement('span');
      item.className = 'legend-item';
      var key = document.createElement('span');
      key.className = markType === 'rect' ? 'legend-rect' : 'legend-line';
      key.style.background = s.color || T.series[i % 3];
      var label = document.createElement('span');
      label.textContent = s.name;
      item.appendChild(key); item.appendChild(label);
      el.appendChild(item);
    });
  }

  function renderTable(wrap, headers, rows) {
    wrap.textContent = '';
    var t = document.createElement('table');
    var thead = document.createElement('thead');
    var tr = document.createElement('tr');
    headers.forEach(function (h) {
      var th = document.createElement('th');
      th.textContent = h; tr.appendChild(th);
    });
    thead.appendChild(tr); t.appendChild(thead);
    var tb = document.createElement('tbody');
    rows.forEach(function (r) {
      var row = document.createElement('tr');
      r.forEach(function (c) {
        var td = document.createElement('td');
        td.textContent = c; row.appendChild(td);
      });
      tb.appendChild(row);
    });
    t.appendChild(tb);
    wrap.appendChild(t);
  }

  function placeTip(tip, frame, x, y) {
    tip.hidden = false;
    var fw = frame.clientWidth;
    var tw = tip.offsetWidth;
    var left = x + 14;
    if (left + tw > fw - 4) left = x - tw - 14;
    if (left < 4) left = 4;
    tip.style.left = left + 'px';
    tip.style.top = Math.max(4, y - tip.offsetHeight - 10) + 'px';
  }

  function tipRow(tip, color, name, value) {
    var row = document.createElement('div');
    row.className = 'tip-row';
    if (color) {
      var k = document.createElement('span');
      k.className = 'tip-key';
      k.style.background = color;
      row.appendChild(k);
    }
    var v = document.createElement('strong');
    v.textContent = value;
    var n = document.createElement('span');
    n.className = 'tip-name';
    n.textContent = name;
    row.appendChild(v); row.appendChild(n);
    tip.appendChild(row);
  }

  /* ============================================================
   * 折れ線チャート
   * cfg: {title, subtitle, xLabel, yLabel, xFormat, yFormat,
   *       series:[{name,color,points:[{x,y}], endLabel}],
   *       bands:[{x0,x1,label}], zeroLine:bool, height,
   *       tipFormat(x) -> string}
   * ============================================================ */
  function line(container, cfg) {
    var dom = buildShell(container, cfg);
    var state = { cfg: cfg, hover: null };

    function draw() {
      var c = state.cfg;
      var T = tokens(container);
      var cssW = dom.frame.clientWidth || 320;
      var cssH = c.height || 240;
      var ctx = setupCanvas(dom.canvas, cssW, cssH);

      var box = { left: 52, right: cssW - 14, top: 12, bottom: cssH - (c.xLabel ? 38 : 24), w: cssW, h: cssH };
      var pts = [];
      c.series.forEach(function (s) { pts = pts.concat(s.points); });
      if (!pts.length) {
        ctx.fillStyle = T.muted;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.font = '12px system-ui, sans-serif';
        ctx.fillText('データがありません', cssW / 2, cssH / 2);
        return;
      }
      var xs = pts.map(function (p) { return p.x; }), ys = pts.map(function (p) { return p.y; });
      var xmin = c.xMin != null ? c.xMin : Math.min.apply(null, xs);
      var xmax = c.xMax != null ? c.xMax : Math.max.apply(null, xs);
      if (xmax - xmin < 1e-9) { var xpad = Math.abs(xmin) > 1e6 ? 43200000 : 0.5; xmin -= xpad; xmax += xpad; }
      var ymin = c.yMin != null ? c.yMin : Math.min.apply(null, ys);
      var ymax = c.yMax != null ? c.yMax : Math.max.apply(null, ys);
      var pad = (ymax - ymin) * 0.12 || 0.5;
      ymin -= pad; ymax += pad;
      if (c.includeZero && ymin > 0) ymin = 0;

      var yTicks = niceTicks(ymin, ymax, 5);
      box.left = leftMargin(ctx, yTicks, c);
      box.px = function (v) { return box.left + (v - xmin) / (xmax - xmin || 1) * (box.right - box.left); };
      box.py = function (v) { return box.bottom - (v - ymin) / (ymax - ymin || 1) * (box.bottom - box.top); };
      state.box = box; state.xmin = xmin; state.xmax = xmax;

      // レップ帯（データより先に、最も奥へ）
      (c.bands || []).forEach(function (b) {
        ctx.fillStyle = (b.color || T.series[0]);
        ctx.globalAlpha = 0.10;
        var x0 = box.px(b.x0), x1 = box.px(b.x1);
        ctx.fillRect(x0, box.top, Math.max(1, x1 - x0), box.bottom - box.top);
        ctx.globalAlpha = 1;
        if (b.label) {
          ctx.fillStyle = T.muted;
          ctx.font = '10px system-ui, sans-serif';
          ctx.textAlign = 'center'; ctx.textBaseline = 'top';
          ctx.fillText(b.label, (x0 + x1) / 2, box.top + 2);
        }
      });

      var xTicks = c.xTicks || niceTicks(xmin, xmax, tickCount(box.right - box.left));
      drawFrame(ctx, T, box, xTicks, yTicks, c);

      // ゼロ線
      if (c.zeroLine && ymin < 0 && ymax > 0) {
        ctx.strokeStyle = T.axis; ctx.lineWidth = 1;
        var y0 = Math.round(box.py(0)) + 0.5;
        ctx.beginPath(); ctx.moveTo(box.left, y0); ctx.lineTo(box.right, y0); ctx.stroke();
      }

      // 系列
      c.series.forEach(function (s, i) {
        var color = s.color || T.series[i % 3];
        if (!s.points.length) return;
        if (s.area) {
          ctx.fillStyle = color; ctx.globalAlpha = 0.10;
          ctx.beginPath();
          ctx.moveTo(box.px(s.points[0].x), box.py(Math.max(ymin, 0)));
          s.points.forEach(function (p) { ctx.lineTo(box.px(p.x), box.py(p.y)); });
          ctx.lineTo(box.px(s.points[s.points.length - 1].x), box.py(Math.max(ymin, 0)));
          ctx.closePath(); ctx.fill();
          ctx.globalAlpha = 1;
        }
        ctx.strokeStyle = color;
        ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        ctx.beginPath();
        s.points.forEach(function (p, k) {
          var X = box.px(p.x), Y = box.py(p.y);
          if (k === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
        });
        ctx.stroke();

        if (s.dots) {
          s.points.forEach(function (p) {
            var X = box.px(p.x), Y = box.py(p.y);
            ctx.beginPath(); ctx.arc(X, Y, 4.5, 0, Math.PI * 2);
            ctx.fillStyle = color; ctx.fill();
            ctx.lineWidth = 2; ctx.strokeStyle = T.surface; ctx.stroke();
          });
        }
        // 終端ドット＋直接ラベル（点ごとの数値は付けない）
        var last = s.points[s.points.length - 1];
        var lx = box.px(last.x), ly = box.py(last.y);
        ctx.beginPath(); ctx.arc(lx, ly, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = color; ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = T.surface; ctx.stroke();
        if (s.endLabel) {
          ctx.fillStyle = T.secondary;
          ctx.font = '11px system-ui, sans-serif';
          ctx.textAlign = lx > box.right - 44 ? 'right' : 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(s.endLabel, lx > box.right - 44 ? lx - 9 : lx + 9, ly);
        }
      });

      // クロスヘア
      if (state.hover != null) {
        var hx = box.px(state.hover);
        if (hx >= box.left && hx <= box.right) {
          ctx.strokeStyle = T.axis; ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(Math.round(hx) + 0.5, box.top);
          ctx.lineTo(Math.round(hx) + 0.5, box.bottom);
          ctx.stroke();
          c.series.forEach(function (s, i) {
            var p = nearest(s.points, state.hover);
            if (!p) return;
            ctx.beginPath();
            ctx.arc(box.px(p.x), box.py(p.y), 5, 0, Math.PI * 2);
            ctx.fillStyle = s.color || T.series[i % 3]; ctx.fill();
            ctx.lineWidth = 2; ctx.strokeStyle = T.surface; ctx.stroke();
          });
        }
      }

      dom.canvas.setAttribute('aria-label',
        (c.title || 'グラフ') + '。詳細は下の「データを表で見る」を開いてください。');
      renderLegend(dom.legend, c.series, T, 'line');
    }

    function nearest(points, x) {
      if (!points.length) return null;
      var lo = 0, hi = points.length - 1;
      while (lo < hi) {
        var mid = (lo + hi) >> 1;
        if (points[mid].x < x) lo = mid + 1; else hi = mid;
      }
      var a = points[Math.max(0, lo - 1)], b = points[lo];
      return Math.abs(a.x - x) <= Math.abs(b.x - x) ? a : b;
    }

    function showTip(clientX, clientY) {
      var c = state.cfg, box = state.box;
      if (!box || !c.series.length || !c.series[0].points.length) return;
      var rect = dom.frame.getBoundingClientRect();
      var mx = clientX - rect.left;
      if (mx < box.left - 8 || mx > box.right + 8) { hideTip(); return; }
      var xval = state.xmin + (mx - box.left) / (box.right - box.left) * (state.xmax - state.xmin);
      state.hover = xval;
      draw();

      dom.tip.textContent = '';
      var head = document.createElement('div');
      head.className = 'tip-head';
      var snap = nearest(c.series[0].points, xval);
      head.textContent = c.tipFormat ? c.tipFormat(snap ? snap.x : xval) : fmtNum(xval, 2);
      dom.tip.appendChild(head);
      var T = tokens(container);
      c.series.forEach(function (s, i) {
        var p = nearest(s.points, xval);
        if (!p) return;
        tipRow(dom.tip, s.color || T.series[i % 3], s.name,
          (c.yFormat ? c.yFormat(p.y) : fmtNum(p.y, c.yDecimals)) + (c.unit || ''));
      });
      placeTip(dom.tip, dom.frame, mx, clientY - rect.top);
    }

    function hideTip() { dom.tip.hidden = true; state.hover = null; draw(); }

    dom.frame.addEventListener('pointermove', function (e) { showTip(e.clientX, e.clientY); });
    dom.frame.addEventListener('pointerleave', hideTip);
    dom.canvas.addEventListener('focus', function () {
      var box = state.box; if (!box) return;
      var r = dom.frame.getBoundingClientRect();
      showTip(r.left + (box.left + box.right) / 2, r.top + box.top + 20);
    });
    dom.canvas.addEventListener('blur', hideTip);

    function update(next) {
      state.cfg = next || state.cfg;
      var c = state.cfg;
      dom.setHeader(c);
      var headers = [c.xLabelName || c.xLabel || 'x'].concat(c.series.map(function (s) { return s.name; }));
      var xsAll = {};
      c.series.forEach(function (s) { s.points.forEach(function (p) { xsAll[p.x] = 1; }); });
      var keys = Object.keys(xsAll).map(Number).sort(function (a, b) { return a - b; });
      var stride = Math.max(1, Math.ceil(keys.length / 300)); // 表は最大300行に間引く
      var rows = [];
      for (var i = 0; i < keys.length; i += stride) {
        var x = keys[i];
        // 表では軸より詳しく書ける（軸は「7/5」、表は「7/5 10:00」など）
        var xf = c.xTableFormat || c.xFormat;
        rows.push([xf ? xf(x) : fmtNum(x, 2)].concat(
          c.series.map(function (s) {
            var p = nearest(s.points, x);
            return p && Math.abs(p.x - x) < 1e-6
              ? (c.yFormat ? c.yFormat(p.y) : fmtNum(p.y, c.yDecimals))
              : '—';
          })));
      }
      renderTable(dom.table, headers, rows);
      draw();
    }

    update(cfg);
    registry.push(draw);
    return { update: update, redraw: draw };
  }

  /* ============================================================
   * 散布図（荷重-速度プロファイル用）＋回帰直線
   * cfg: {title, subtitle, xLabel, yLabel, points:[{x,y,label}],
   *       fit:{slope,intercept,x0,x1}, marks:[{y,label}], color}
   * ============================================================ */
  function scatter(container, cfg) {
    var dom = buildShell(container, cfg);
    var state = { cfg: cfg, hi: -1 };

    function draw() {
      var c = state.cfg;
      var T = tokens(container);
      var cssW = dom.frame.clientWidth || 320;
      var cssH = c.height || 260;
      var ctx = setupCanvas(dom.canvas, cssW, cssH);
      var box = { left: 52, right: cssW - 18, top: 14, bottom: cssH - 38, w: cssW, h: cssH };

      if (!c.points.length) {
        ctx.fillStyle = T.muted; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.font = '12px system-ui, sans-serif';
        ctx.fillText(c.emptyText || 'データがありません', cssW / 2, cssH / 2);
        renderTable(dom.table, [], []);
        return;
      }

      var xs = c.points.map(function (p) { return p.x; });
      var ys = c.points.map(function (p) { return p.y; });
      if (c.fit) { xs.push(c.fit.x0, c.fit.x1); ys.push(c.fit.y0, c.fit.y1); }
      (c.marks || []).forEach(function (m) { ys.push(m.y); });

      var xmin = Math.min.apply(null, xs), xmax = Math.max.apply(null, xs);
      var ymin = Math.min.apply(null, ys), ymax = Math.max.apply(null, ys);
      var xp = (xmax - xmin) * 0.10 || 5, yp = (ymax - ymin) * 0.14 || 0.1;
      xmin -= xp; xmax += xp; ymin = Math.max(0, ymin - yp); ymax += yp;

      var yTicks = niceTicks(ymin, ymax, 5);
      box.left = leftMargin(ctx, yTicks, c);
      box.px = function (v) { return box.left + (v - xmin) / (xmax - xmin || 1) * (box.right - box.left); };
      box.py = function (v) { return box.bottom - (v - ymin) / (ymax - ymin || 1) * (box.bottom - box.top); };
      state.box = box;

      drawFrame(ctx, T, box, niceTicks(xmin, xmax, tickCount(box.right - box.left)), yTicks, c);

      // 目安ライン（最小速度閾値など）— 注釈なので中立色
      (c.marks || []).forEach(function (m) {
        var y = Math.round(box.py(m.y)) + 0.5;
        if (y < box.top || y > box.bottom) return;
        ctx.strokeStyle = T.axis; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(box.left, y); ctx.lineTo(box.right, y); ctx.stroke();
        ctx.fillStyle = T.muted; ctx.font = '10px system-ui, sans-serif';
        ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
        ctx.fillText(m.label, box.left + 4, y - 2);
      });

      // 回帰直線（データ系列ではなく注釈として中立色）
      if (c.fit) {
        ctx.strokeStyle = T.muted; ctx.lineWidth = 2; ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(box.px(c.fit.x0), box.py(c.fit.y0));
        ctx.lineTo(box.px(c.fit.x1), box.py(c.fit.y1));
        ctx.stroke();
      }

      var color = c.color || T.series[0];
      c.points.forEach(function (p, i) {
        var X = box.px(p.x), Y = box.py(p.y);
        ctx.beginPath(); ctx.arc(X, Y, i === state.hi ? 6.5 : 5, 0, Math.PI * 2);
        ctx.fillStyle = color; ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = T.surface; ctx.stroke();
      });

      dom.canvas.setAttribute('aria-label',
        (c.title || '散布図') + '。詳細は下の「データを表で見る」を開いてください。');
      renderLegend(dom.legend, [], T, 'line');
    }

    dom.frame.addEventListener('pointermove', function (e) {
      var c = state.cfg, box = state.box;
      if (!box || !c.points.length) return;
      var r = dom.frame.getBoundingClientRect();
      var mx = e.clientX - r.left, my = e.clientY - r.top;
      var best = -1, bd = 24 * 24; // 24px の当たり判定（最近傍方式）
      c.points.forEach(function (p, i) {
        var dx = box.px(p.x) - mx, dy = box.py(p.y) - my;
        var d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = i; }
      });
      if (best === state.hi && best === -1) return;
      state.hi = best;
      draw();
      if (best < 0) { dom.tip.hidden = true; return; }
      var p = c.points[best];
      dom.tip.textContent = '';
      var head = document.createElement('div');
      head.className = 'tip-head';
      head.textContent = p.label || '';
      dom.tip.appendChild(head);
      tipRow(dom.tip, null, c.yLabel || 'y', fmtNum(p.y, 2));
      tipRow(dom.tip, null, c.xLabel || 'x', fmtNum(p.x, 1));
      placeTip(dom.tip, dom.frame, box.px(p.x), box.py(p.y));
    });
    dom.frame.addEventListener('pointerleave', function () {
      state.hi = -1; dom.tip.hidden = true; draw();
    });

    function update(next) {
      state.cfg = next || state.cfg;
      var c = state.cfg;
      dom.setHeader(c);
      renderTable(dom.table,
        [c.pointLabel || '項目', c.xLabel || 'x', c.yLabel || 'y'],
        c.points.map(function (p) { return [p.label || '', fmtNum(p.x, 1), fmtNum(p.y, 2)]; }));
      draw();
    }

    update(cfg);
    registry.push(draw);
    return { update: update, redraw: draw };
  }

  /* ============================================================
   * 縦棒チャート（レップごとの指標）
   * cfg: {title, subtitle, yLabel, bars:[{label,value}], color, unit}
   * ============================================================ */
  function bars(container, cfg) {
    var dom = buildShell(container, cfg);
    var state = { cfg: cfg, hi: -1 };

    function draw() {
      var c = state.cfg;
      var T = tokens(container);
      var cssW = dom.frame.clientWidth || 320;
      var cssH = c.height || 200;
      var ctx = setupCanvas(dom.canvas, cssW, cssH);
      var box = { left: 52, right: cssW - 14, top: 16, bottom: cssH - 30, w: cssW, h: cssH };

      if (!c.bars.length) {
        ctx.fillStyle = T.muted; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.font = '12px system-ui, sans-serif';
        ctx.fillText('データがありません', cssW / 2, cssH / 2);
        return;
      }
      var vals = c.bars.map(function (b) { return b.value; });
      var ymax = Math.max.apply(null, vals) * 1.18;
      var ymin = Math.min(0, Math.min.apply(null, vals));
      var yTicks = niceTicks(ymin, ymax, 4);
      box.left = leftMargin(ctx, yTicks, c);
      box.px = function (i) { return box.left + (i + 0.5) * (box.right - box.left) / c.bars.length; };
      box.py = function (v) { return box.bottom - (v - ymin) / (ymax - ymin || 1) * (box.bottom - box.top); };
      state.box = box;

      ctx.font = '11px system-ui, sans-serif';
      ctx.strokeStyle = T.grid; ctx.lineWidth = 1;
      ctx.fillStyle = T.muted; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      yTicks.forEach(function (v) {
        var y = Math.round(box.py(v)) + 0.5;
        if (y < box.top - 1 || y > box.bottom + 1) return;
        ctx.beginPath(); ctx.moveTo(box.left, y); ctx.lineTo(box.right, y); ctx.stroke();
        ctx.fillText(fmtNum(v, c.yDecimals == null ? 2 : c.yDecimals), box.left - 8, y);
      });
      ctx.strokeStyle = T.axis;
      var yb = Math.round(box.py(Math.max(0, ymin))) + 0.5;
      ctx.beginPath(); ctx.moveTo(box.left, yb); ctx.lineTo(box.right, yb); ctx.stroke();

      var slot = (box.right - box.left) / c.bars.length;
      var bw = Math.min(24, Math.max(6, slot - 12)); // 24px上限・スロットは埋めない
      var color = c.color || T.series[0];
      var r = 4;

      c.bars.forEach(function (b, i) {
        var cx = box.px(i), y = box.py(b.value), base = box.py(Math.max(0, ymin));
        var top = Math.min(y, base), hgt = Math.max(2, Math.abs(base - y));
        ctx.fillStyle = color;
        ctx.globalAlpha = (state.hi === -1 || state.hi === i) ? 1 : 0.55;
        ctx.beginPath();
        // 上端は4px角丸、基線側は角なし
        ctx.moveTo(cx - bw / 2, top + hgt);
        ctx.lineTo(cx - bw / 2, top + r);
        ctx.quadraticCurveTo(cx - bw / 2, top, cx - bw / 2 + r, top);
        ctx.lineTo(cx + bw / 2 - r, top);
        ctx.quadraticCurveTo(cx + bw / 2, top, cx + bw / 2, top + r);
        ctx.lineTo(cx + bw / 2, top + hgt);
        ctx.closePath(); ctx.fill();
        ctx.globalAlpha = 1;

        ctx.fillStyle = T.muted;
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        ctx.fillText(b.label, cx, box.bottom + 6);
      });

      // 直接ラベルは最大値のみ（全点に数値は置かない）
      var maxI = vals.indexOf(Math.max.apply(null, vals));
      ctx.fillStyle = T.secondary;
      ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillText(fmtNum(c.bars[maxI].value, c.yDecimals == null ? 2 : c.yDecimals) + (c.unit || ''),
        box.px(maxI), box.py(c.bars[maxI].value) - 5);

      if (c.yLabel) {
        ctx.save();
        ctx.translate(12, (box.top + box.bottom) / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.fillStyle = T.secondary;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(c.yLabel, 0, 0);
        ctx.restore();
      }
      dom.canvas.setAttribute('aria-label',
        (c.title || '棒グラフ') + '。詳細は下の「データを表で見る」を開いてください。');
    }

    dom.frame.addEventListener('pointermove', function (e) {
      var c = state.cfg, box = state.box;
      if (!box || !c.bars.length) return;
      var r = dom.frame.getBoundingClientRect();
      var mx = e.clientX - r.left;
      var slot = (box.right - box.left) / c.bars.length;
      var i = Math.floor((mx - box.left) / slot);
      if (i < 0 || i >= c.bars.length) { state.hi = -1; dom.tip.hidden = true; draw(); return; }
      state.hi = i; draw();
      dom.tip.textContent = '';
      var head = document.createElement('div');
      head.className = 'tip-head';
      head.textContent = c.bars[i].label;
      dom.tip.appendChild(head);
      tipRow(dom.tip, c.color || tokens(container).series[0], c.title || '値',
        fmtNum(c.bars[i].value, c.yDecimals == null ? 2 : c.yDecimals) + (c.unit || ''));
      placeTip(dom.tip, dom.frame, box.px(i), box.py(c.bars[i].value));
    });
    dom.frame.addEventListener('pointerleave', function () {
      state.hi = -1; dom.tip.hidden = true; draw();
    });

    function update(next) {
      state.cfg = next || state.cfg;
      var c = state.cfg;
      dom.setHeader(c);
      renderTable(dom.table, [c.xLabel || '項目', (c.yLabel || '値')],
        c.bars.map(function (b) {
          return [b.label, fmtNum(b.value, c.yDecimals == null ? 2 : c.yDecimals)];
        }));
      draw();
    }

    update(cfg);
    registry.push(draw);
    return { update: update, redraw: draw };
  }

  function redrawAll() { registry.forEach(function (f) { try { f(); } catch (e) { /* noop */ } }); }
  var resizeTimer = null;
  global.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(redrawAll, 120);
  });
  if (global.matchMedia) {
    var mq = global.matchMedia('(prefers-color-scheme: dark)');
    if (mq.addEventListener) mq.addEventListener('change', redrawAll);
  }
  global.addEventListener('vbt:theme', redrawAll);

  global.VBT = global.VBT || {};
  global.VBT.Charts = {
    line: line, scatter: scatter, bars: bars,
    redrawAll: redrawAll, fmtNum: fmtNum
  };
})(this);
