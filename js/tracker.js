/* ============================================================
 * tracker.js — カラーマーカー追跡
 * バーの端に貼った目印（蛍光テープ等）の色をHSVで判定し、
 * 前フレーム位置まわりの探索窓 → 連結成分の最大塊の重心を追う。
 * 依存なし。グローバル VBT.Tracker に公開する。
 * ============================================================ */
(function (global) {
  'use strict';

  /* ---------- RGB → HSV ---------- */
  function rgb2hsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    var h = 0;
    if (d > 1e-9) {
      if (max === r) h = 60 * (((g - b) / d) % 6);
      else if (max === g) h = 60 * ((b - r) / d + 2);
      else h = 60 * ((r - g) / d + 4);
      if (h < 0) h += 360;
    }
    return { h: h, s: max > 1e-9 ? d / max : 0, v: max };
  }

  function hueDist(a, b) {
    var d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  }

  /* ---------- 1画素がマーカー色か ----------
   * achromatic（白・黒・グレーの目印）の場合は色相を無視し明度で判定する。
   */
  function makeMatcher(c) {
    if (c.achromatic) {
      return function (r, g, b) {
        var hsv = rgb2hsv(r, g, b);
        return hsv.s <= c.satMax && hsv.v >= c.valMin && hsv.v <= c.valMax;
      };
    }
    return function (r, g, b) {
      var hsv = rgb2hsv(r, g, b);
      return hsv.s >= c.satMin && hsv.v >= c.valMin && hueDist(hsv.h, c.hue) <= c.hueTol;
    };
  }

  /* ---------- 探索窓内のマスク生成 ---------- */
  function buildMask(data, w, h, rect, matcher) {
    var mask = new Uint8Array(w * h);
    var count = 0;
    for (var y = rect.y0; y < rect.y1; y++) {
      var row = y * w;
      for (var x = rect.x0; x < rect.x1; x++) {
        var idx = (row + x) * 4;
        if (matcher(data[idx], data[idx + 1], data[idx + 2])) { mask[row + x] = 1; count++; }
      }
    }
    return { mask: mask, count: count };
  }

  /* ---------- 最大連結成分の重心（4近傍・スタック走査） ---------- */
  function largestBlob(mask, w, h, rect) {
    var visited = new Uint8Array(w * h);
    var best = null;
    var stack = new Int32Array(Math.max(1024, (rect.x1 - rect.x0) * (rect.y1 - rect.y0)));

    for (var y = rect.y0; y < rect.y1; y++) {
      for (var x = rect.x0; x < rect.x1; x++) {
        var start = y * w + x;
        if (!mask[start] || visited[start]) continue;
        var sp = 0;
        stack[sp++] = start;
        visited[start] = 1;
        var sx = 0, sy = 0, n = 0;
        var bx0 = x, bx1 = x, by0 = y, by1 = y;
        while (sp > 0) {
          var p = stack[--sp];
          var py = (p / w) | 0, px = p - py * w;
          sx += px; sy += py; n++;
          if (px < bx0) bx0 = px; if (px > bx1) bx1 = px;
          if (py < by0) by0 = py; if (py > by1) by1 = py;
          if (px > rect.x0 && mask[p - 1] && !visited[p - 1]) { visited[p - 1] = 1; if (sp < stack.length) stack[sp++] = p - 1; }
          if (px < rect.x1 - 1 && mask[p + 1] && !visited[p + 1]) { visited[p + 1] = 1; if (sp < stack.length) stack[sp++] = p + 1; }
          if (py > rect.y0 && mask[p - w] && !visited[p - w]) { visited[p - w] = 1; if (sp < stack.length) stack[sp++] = p - w; }
          if (py < rect.y1 - 1 && mask[p + w] && !visited[p + w]) { visited[p + w] = 1; if (sp < stack.length) stack[sp++] = p + w; }
        }
        if (!best || n > best.n) {
          best = { x: sx / n, y: sy / n, n: n, w: bx1 - bx0 + 1, h: by1 - by0 + 1 };
        }
      }
    }
    return best;
  }

  function clampRect(cx, cy, r, w, h) {
    return {
      x0: Math.max(0, Math.floor(cx - r)),
      x1: Math.min(w, Math.ceil(cx + r)),
      y0: Math.max(0, Math.floor(cy - r)),
      y1: Math.min(h, Math.ceil(cy + r))
    };
  }

  /* ---------- 1フレームの位置検出 ---------- */
  function locate(data, w, h, prev, cfg, matcher) {
    var minPx = cfg.minPixels || 12;

    function attempt(rect) {
      var m = buildMask(data, w, h, rect, matcher);
      if (m.count < minPx) return null;
      var blob = largestBlob(m.mask, w, h, rect);
      return (blob && blob.n >= minPx) ? blob : null;
    }

    var blob = null;
    if (prev) {
      var r = cfg.searchRadius;
      blob = attempt(clampRect(prev.x, prev.y, r, w, h));
      if (!blob) blob = attempt(clampRect(prev.x, prev.y, r * 2.2, w, h)); // 見失ったら窓を拡大
    }
    if (!blob) blob = attempt({ x0: 0, x1: w, y0: 0, y1: h });             // 最後は全画面探索
    return blob;
  }

  /* ---------- プレビュー用: 全画面マスクを ImageData で返す ---------- */
  function maskOverlay(data, w, h, cfg) {
    var matcher = makeMatcher(cfg);
    var out = new Uint8ClampedArray(w * h * 4);
    var count = 0;
    for (var i = 0, p = 0; i < w * h; i++, p += 4) {
      if (matcher(data[p], data[p + 1], data[p + 2])) {
        out[p] = 27; out[p + 1] = 175; out[p + 2] = 122; out[p + 3] = 190;
        count++;
      }
    }
    return { pixels: out, count: count };
  }

  /* ---------- 録画データの長さを確定させる ----------
   * MediaRecorder が作る webm は duration が Infinity になることがある。
   * 巨大な位置へシークさせて実長を確定させる（Chromium系の定番の回避策）。 */
  function ensureDuration(video) {
    return new Promise(function (res) {
      if (isFinite(video.duration) && video.duration > 0) return res(video.duration);
      var timer = setTimeout(done, 2000);
      function done() {
        clearTimeout(timer);
        video.removeEventListener('timeupdate', onT);
        try { video.currentTime = 0; } catch (e) { /* noop */ }
        res(video.duration);
      }
      function onT() { if (isFinite(video.duration) && video.duration > 0) done(); }
      video.addEventListener('timeupdate', onT);
      try { video.currentTime = 1e101; } catch (e) { done(); }
    });
  }

  /* ---------- 動画1本の追跡 ----------
   * video : <video>（blob URL 済み・再生可能状態）
   * cfg   : {hue,hueTol,satMin,valMin,achromatic,satMax,valMax,
   *          procWidth, searchRadius, minPixels, playbackRate, fallbackFps}
   * 戻り値: Promise<[{t, x, y, ok, n}]>  x,y は元動画のピクセル座標
   */
  function track(video, cfg, onProgress, cancelRef) {
    var vw = video.videoWidth, vh = video.videoHeight;
    var pw = Math.min(cfg.procWidth || 480, vw);
    var scale = pw / vw;
    var ph = Math.max(1, Math.round(vh * scale));

    var canvas = document.createElement('canvas');
    canvas.width = pw; canvas.height = ph;
    var ctx = canvas.getContext('2d', { willReadFrequently: true });

    var matcher = makeMatcher(cfg);
    var samples = [];
    var prev = null;
    var duration = video.duration || 0;

    function handleFrame(mediaTime) {
      ctx.drawImage(video, 0, 0, pw, ph);
      var img = ctx.getImageData(0, 0, pw, ph);
      var blob = locate(img.data, pw, ph, prev, cfg, matcher);
      if (blob) {
        prev = blob;
        samples.push({ t: mediaTime, x: blob.x / scale, y: blob.y / scale, ok: true, n: blob.n });
      } else {
        samples.push({ t: mediaTime, x: 0, y: 0, ok: false, n: 0 });
      }
      if (onProgress && duration > 0) {
        onProgress(Math.min(1, mediaTime / duration), samples.length, samples[samples.length - 1]);
      }
    }

    var hasRVFC = typeof video.requestVideoFrameCallback === 'function';

    function reset() { samples = []; prev = null; }

    /* --- 経路1: 再生しながら requestVideoFrameCallback で1フレームずつ拾う --- *
     * 速く、フレーム時刻も正確。ただしブラウザが背面タブの無音動画を止めることがあるため、
     * 再開を数回試み、それでも駄目ならシーク方式へ切り替える。                       */
    function playbackPath() {
      return new Promise(function (resolve, reject) {
        var done = false, resumes = 0;
        function finish(reason) {
          if (done) return;
          done = true;
          video.onended = null; video.onerror = null; video.onpause = null;
          video.pause();
          resolve({ samples: samples, path: 'playback', reason: reason });
        }
        function bail() {
          if (done) return;
          done = true;
          video.onended = null; video.onerror = null; video.onpause = null;
          video.pause();
          resolve({ samples: null, path: 'playback' }); // シーク方式へ委譲
        }
        function step(now, meta) {
          if (cancelRef && cancelRef.cancelled) { finish('cancelled'); return; }
          try { handleFrame(meta.mediaTime); } catch (e) { done = true; video.pause(); reject(e); return; }
          if (!video.ended) video.requestVideoFrameCallback(step);
          else finish('ended');
        }
        video.onended = function () { finish('ended'); };
        video.onerror = function () { bail(); };
        video.onpause = function () {
          if (done || video.ended) return;
          if (cancelRef && cancelRef.cancelled) { finish('cancelled'); return; }
          // 省電力等で勝手に止められた場合は再開を試みる。
          // 再開が「拒否された」ときだけ諦める（再開できている限りは続行してよい）。
          if (++resumes > 12) { bail(); return; }
          video.play().catch(function () { bail(); });
        };
        video.muted = true;
        video.playbackRate = cfg.playbackRate || 1;
        video.currentTime = 0;
        video.play().then(function () {
          video.requestVideoFrameCallback(step);
        }, function () { bail(); });
      });
    }

    /* --- 経路2: シークしながら1フレームずつ拾う --- *
     * 再生を伴わないため背面タブでも止まらない。rVFC があれば実フレーム時刻が得られるので、
     * 細かめの刻みでシークして同一フレームは読み飛ばす。                              */
    function seekPath() {
      reset();
      video.pause();

      /* シーク1回で「そのフレームの正確な時刻」が取れるかどうかで動作を変える。
       * ・精密モード: rVFC がシーク後に発火する環境。1/60刻みでシークし、
       *   rVFC の mediaTime を時刻として使う。同じフレームは読み飛ばす。
       * ・粗いモード: rVFC が無い／シークでは発火しない環境。正確な時刻が取れないので、
       *   フレームの中央を狙って一定間隔でシークし、その狙った時刻をそのまま使う。
       *   時間分解能は落ちるが、同じフレームを別時刻として二重に拾う歪みは出ない。 */
      var fine = hasRVFC;
      var GRACE = 60;   // rVFC を待つ猶予(ms)
      var HARD = 350;   // シーク自体のタイムアウト(ms)

      function grab(target) {
        return new Promise(function (res) {
          var settled = false, graceTimer = null;
          var hardTimer = setTimeout(function () { finish(null); }, HARD);
          function finish(mediaTime) {
            if (settled) return;
            settled = true;
            clearTimeout(hardTimer); clearTimeout(graceTimer);
            video.removeEventListener('seeked', onSeeked);
            res(mediaTime);   // null は「正確な時刻が取れなかった」を意味する
          }
          function onSeeked() {
            if (settled) return;
            if (!fine) return finish(null);
            graceTimer = setTimeout(function () { finish(null); }, GRACE);
          }
          video.addEventListener('seeked', onSeeked);
          if (fine) {
            video.requestVideoFrameCallback(function (now, meta) { finish(meta.mediaTime); });
          }
          video.currentTime = target;
        });
      }

      var lastTime = -1, k = 0, probeMiss = 0, probed = 0;

      function nextTarget() {
        return fine ? k / 60 : (k + 0.5) / (cfg.seekFps || 30);
      }

      function loop() {
        if (cancelRef && cancelRef.cancelled) return Promise.resolve({ samples: samples, path: 'seek' });
        var target = nextTarget();
        if (target >= duration - 1e-4) return Promise.resolve({ samples: samples, path: 'seek' });
        return grab(target).then(function (mediaTime) {
          // 精密モードのつもりでも実際には時刻が取れないなら、早めに粗いモードへ切り替える
          if (fine) {
            probed++;
            if (mediaTime == null) probeMiss++;
            if (probed >= 8 && probeMiss > probed / 2) {
              fine = false; reset(); k = 0; lastTime = -1;
              return loop();
            }
          }
          if (mediaTime == null) {
            handleFrame(target);                       // 粗いモード: 狙った時刻を使う
          } else if (mediaTime > lastTime + 1e-4) {    // 精密モード: 同じフレームは数えない
            lastTime = mediaTime;
            handleFrame(mediaTime);
          }
          k++;
          return loop();
        });
      }
      return loop();
    }

    // forceSeek はフォールバック経路を検証するためのもの（セルフテストが使う）
    if (!hasRVFC || cfg.forceSeek) return seekPath().then(function (r) { return r.samples; });

    return playbackPath().then(function (r) {
      if (r.samples && r.samples.length > 3) return r.samples;
      return seekPath().then(function (r2) { return r2.samples; });
    });
  }

  global.VBT = global.VBT || {};
  global.VBT.Tracker = {
    rgb2hsv: rgb2hsv,
    makeMatcher: makeMatcher,
    maskOverlay: maskOverlay,
    locate: locate,             // ライブ追跡から1フレームずつ呼ぶ
    ensureDuration: ensureDuration,
    track: track
  };
})(this);
