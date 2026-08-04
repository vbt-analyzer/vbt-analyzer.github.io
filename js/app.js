/* ============================================================
 * app.js — 画面制御
 * ============================================================ */
(function (global) {
  'use strict';

  var Kin = global.VBT.Kin, Tracker = global.VBT.Tracker,
      Charts = global.VBT.Charts, Store = global.VBT.Store;

  function $(id) { return document.getElementById(id); }
  function fmt(v, d) { return Charts.fmtNum(v, d); }

  var S = {
    url: null,
    ready: false,
    source: 'file',      // 'file' | 'camera'
    mode: null,          // 'calib' | 'pick' | null
    calibPts: [],
    metersPerPixel: null,
    picked: null,        // {hue,sat,val,rgb}
    result: null,
    cancelRef: null,
    fpsEstimate: null,
    // カメラ関連
    stream: null,
    camLive: false,      // プレビュー描画中か
    recorder: null,
    recording: false,
    recChunks: [],
    recBlob: null,
    recUrl: null,
    recSamples: [],
    recStartMs: 0,
    wakeLock: null
  };

  var charts = {};

  /* ================= タブ ================= */
  var TABS = ['analyze', 'history', 'guide'];
  TABS.forEach(function (name) {
    $('tab-' + name).addEventListener('click', function () { showTab(name); });
  });
  function showTab(name) {
    TABS.forEach(function (n) {
      $('tab-' + n).setAttribute('aria-selected', String(n === name));
      $('panel-' + n).hidden = (n !== name);
    });
    if (name === 'history') renderHistory();
    Charts.redrawAll();
  }

  /* ================= テーマ ================= */
  (function () {
    var saved = null;
    try { saved = localStorage.getItem('vbt.theme'); } catch (e) { /* noop */ }
    if (saved) document.documentElement.setAttribute('data-theme', saved);
    $('themeBtn').addEventListener('click', function () {
      var cur = document.documentElement.getAttribute('data-theme');
      var isDark = cur ? cur === 'dark'
        : global.matchMedia('(prefers-color-scheme: dark)').matches;
      var next = isDark ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('vbt.theme', next); } catch (e) { /* noop */ }
      global.dispatchEvent(new Event('vbt:theme'));
      drawOverlay();
    });
  })();

  /* ================= 動画読み込み ================= */
  var videoEl = $('videoEl'), camEl = $('camEl');
  var frameCanvas = $('frameCanvas'), overlay = $('overlayCanvas');
  var fctx = frameCanvas.getContext('2d', { willReadFrequently: true });
  var octx = overlay.getContext('2d');
  var previewCanvas = document.createElement('canvas');
  var pctx = previewCanvas.getContext('2d', { willReadFrequently: true });
  var maskCanvas = document.createElement('canvas');
  var mctx = maskCanvas.getContext('2d');
  var origPerCanvas = 1;

  // プレビューの描画元。カメラ使用中は camEl、それ以外は videoEl。
  function previewEl() { return S.camLive ? camEl : videoEl; }

  // ステージ（表示キャンバス・マスク計算用キャンバス）を映像サイズに合わせる
  function prepareStage(vw, vh) {
    var dispW = Math.min(vw, 1280);
    frameCanvas.width = dispW;
    frameCanvas.height = Math.round(vh * dispW / vw);
    overlay.width = frameCanvas.width;
    overlay.height = frameCanvas.height;
    origPerCanvas = vw / dispW;

    previewCanvas.width = Math.min(480, vw);
    previewCanvas.height = Math.max(1, Math.round(vh * previewCanvas.width / vw));
    maskCanvas.width = previewCanvas.width;
    maskCanvas.height = previewCanvas.height;

    overlay.hidden = false;
    $('stagePlaceholder').hidden = true;
    // ステージの縦横比を映像に合わせる。映像とオーバーレイが同じ箱を満たすので位置がずれない。
    $('stage').style.setProperty('--ar-num', (vw / vh).toFixed(4));
    $('stage').classList.remove('empty');
    showLiveVideo(S.camLive);
  }

  /* カメラ映像は video 要素をそのまま画面に出し、動画ファイルは canvas に描く。
   * 画面に出ていない video はブラウザがフレームを更新せず、canvas へ写しても止まった絵になる。 */
  function showLiveVideo(live) {
    camEl.hidden = !live;
    frameCanvas.hidden = !!live;
  }

  function resetAnalysis() {
    S.ready = false;
    S.calibPts = []; S.metersPerPixel = null; S.picked = null; S.result = null;
    $('results').hidden = true;
    $('calibStatus').textContent = '未較正';
    $('calibStatus').className = 'status-line';
    $('maskStatus').textContent = '未指定';
    $('maskStatus').className = 'status-line';
    $('pickedSwatch').style.background = 'transparent';
  }

  $('videoInput').addEventListener('change', function (e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    resetAnalysis();
    loadVideoBlob(file, file.name);
  });

  // ファイルでも録画データでも同じ経路で読み込む。
  // keepSettings=true のときは較正とマーカー設定を引き継ぐ（カメラを動かしていないため）。
  function loadVideoBlob(blob, name, keepSettings) {
    if (S.url) URL.revokeObjectURL(S.url);
    S.url = URL.createObjectURL(blob);
    S.fileName = name;
    if (!keepSettings) S.ready = false;
    return new Promise(function (resolve, reject) {
      function onLoaded() {
        Tracker.ensureDuration(videoEl).then(function () {
          if (onMeta(keepSettings)) resolve(); else reject(new Error('映像を読み込めませんでした'));
        });
      }
      videoEl.addEventListener('loadedmetadata', onLoaded, { once: true });
      videoEl.onerror = function () { reject(new Error('映像を読み込めませんでした')); };
      videoEl.src = S.url;
      videoEl.load();
    });
  }

  function onMeta(keepSettings) {
    var vw = videoEl.videoWidth, vh = videoEl.videoHeight;
    if (!vw || !vh) {
      $('videoInfo').textContent = 'この動画は読み込めませんでした（形式が非対応の可能性）';
      $('videoInfo').className = 'status-line bad';
      return false;
    }
    // カメラ録画を引き継ぐ場合、解像度が変わっていたら較正が無効になる
    if (keepSettings && S.calibSize && (S.calibSize[0] !== vw || S.calibSize[1] !== vh)) {
      $('calibStatus').textContent =
        '録画の解像度がプレビューと異なるため（' + S.calibSize[0] + '×' + S.calibSize[1] +
        ' → ' + vw + '×' + vh + '）、較正をやり直してください。';
      $('calibStatus').className = 'status-line bad';
      S.metersPerPixel = null; S.calibPts = [];
    }
    prepareStage(vw, vh);

    $('videoInfo').textContent =
      vw + '×' + vh + ' / ' + videoEl.duration.toFixed(2) + '秒 / ' + S.fileName;
    $('videoInfo').className = 'status-line ok';

    $('frameSeekWrap').hidden = false;
    $('frameSeek').disabled = false;
    $('frameSeek').max = String(Math.max(0.1, videoEl.duration));
    $('frameSeek').step = String(Math.max(0.01, videoEl.duration / 400));
    $('frameSeek').value = String(Math.min(videoEl.duration * 0.4, videoEl.duration));
    $('calibBtn').disabled = false;
    $('pickBtn').disabled = false;
    S.ready = true;

    seekTo(Number($('frameSeek').value)).then(function () {
      drawFrame(); drawOverlay(); updateRunButton();
    });
    return true;
  }

  function seekTo(t) {
    return new Promise(function (res) {
      if (Math.abs(videoEl.currentTime - t) < 1e-3 && videoEl.readyState >= 2) return res();
      function on() { videoEl.removeEventListener('seeked', on); res(); }
      videoEl.addEventListener('seeked', on);
      videoEl.currentTime = Math.max(0, Math.min(t, (videoEl.duration || 0) - 0.02));
    });
  }

  var seekTimer = null;
  $('frameSeek').addEventListener('input', function () {
    var t = Number(this.value);
    clearTimeout(seekTimer);
    seekTimer = setTimeout(function () {
      seekTo(t).then(function () { drawFrame(); drawOverlay(); });
    }, 40);
  });

  function drawFrame() {
    if (!S.ready) return;
    fctx.drawImage(previewEl(), 0, 0, frameCanvas.width, frameCanvas.height);
  }

  /* ================= オーバーレイ描画 ================= */
  function markerConfig() {
    if (!S.picked) return null;
    var tol = Number($('hueTol').value);
    if ($('achromatic').checked) {
      var vt = tol / 60 * 0.6;
      return {
        achromatic: true,
        satMax: Number($('satMin').value),
        valMin: Math.max(0, S.picked.val - vt),
        valMax: Math.min(1, S.picked.val + vt)
      };
    }
    return {
      achromatic: false,
      hue: S.picked.hue,
      hueTol: tol,
      satMin: Number($('satMin').value),
      valMin: Number($('valMin').value)
    };
  }

  function drawOverlay() {
    if (!S.ready) return;
    octx.clearRect(0, 0, overlay.width, overlay.height);

    // マーカー判定のプレビュー（縮小して計算し、拡大して重ねる）
    var cfg = markerConfig();
    if (cfg) {
      pctx.drawImage(previewEl(), 0, 0, previewCanvas.width, previewCanvas.height);
      var img = pctx.getImageData(0, 0, previewCanvas.width, previewCanvas.height);
      var res = Tracker.maskOverlay(img.data, previewCanvas.width, previewCanvas.height, cfg);
      var out = mctx.createImageData(previewCanvas.width, previewCanvas.height);
      out.data.set(res.pixels);
      mctx.putImageData(out, 0, 0);
      octx.imageSmoothingEnabled = false;
      octx.drawImage(maskCanvas, 0, 0, overlay.width, overlay.height);

      var total = previewCanvas.width * previewCanvas.height;
      var pct = res.count / total * 100;
      var el = $('maskStatus');
      if (res.count === 0) {
        el.textContent = 'この位置ではマーカーが見つかりません。しきい値をゆるめるか、別のフレームで確認してください。';
        el.className = 'status-line bad';
      } else if (pct > 3) {
        el.textContent = '一致した領域が広すぎます（画面の' + pct.toFixed(1) + '%）。彩度の下限を上げるか色相の幅を狭めてください。';
        el.className = 'status-line bad';
      } else if (pct > 0.8) {
        el.textContent = '一致 ' + pct.toFixed(2) + '%。やや広めです。マーカー以外が緑に染まっていないか確認してください。';
        el.className = 'status-line warn';
      } else {
        el.textContent = '一致 ' + pct.toFixed(2) + '%（' + res.count + 'px）。良好です。';
        el.className = 'status-line ok';
      }
    }

    // 較正の線と点
    var st = getComputedStyle(document.documentElement);
    var c1 = st.getPropertyValue('--series-2').trim() || '#eb6834';
    var surf = st.getPropertyValue('--surface-1').trim() || '#fff';
    if (S.calibPts.length) {
      var pts = S.calibPts.map(function (p) {
        return { x: p.x / origPerCanvas, y: p.y / origPerCanvas };
      });
      if (pts.length === 2) {
        octx.strokeStyle = c1; octx.lineWidth = 3; octx.lineCap = 'round';
        octx.beginPath();
        octx.moveTo(pts[0].x, pts[0].y);
        octx.lineTo(pts[1].x, pts[1].y);
        octx.stroke();
      }
      pts.forEach(function (p) {
        octx.beginPath(); octx.arc(p.x, p.y, 6, 0, Math.PI * 2);
        octx.fillStyle = c1; octx.fill();
        octx.lineWidth = 2; octx.strokeStyle = surf; octx.stroke();
      });
    }
  }

  /* ================= クリック操作 ================= */
  $('calibBtn').addEventListener('click', function () {
    S.mode = S.mode === 'calib' ? null : 'calib';
    S.calibPts = [];
    syncModeButtons();
    drawOverlay();
  });
  $('pickBtn').addEventListener('click', function () {
    S.mode = S.mode === 'pick' ? null : 'pick';
    syncModeButtons();
  });
  function syncModeButtons() {
    $('calibBtn').textContent = S.mode === 'calib'
      ? '較正中… 1点目をクリック' : '2点をクリックして較正';
    $('calibBtn').classList.toggle('primary', S.mode === 'calib');
    $('pickBtn').textContent = S.mode === 'pick'
      ? 'マーカーをクリックしてください' : 'マーカーをクリックして指定';
    $('pickBtn').classList.toggle('primary', S.mode === 'pick');
  }

  overlay.addEventListener('click', function (e) {
    if (!S.ready || !S.mode) return;
    var rect = overlay.getBoundingClientRect();
    var cx = (e.clientX - rect.left) * overlay.width / rect.width;
    var cy = (e.clientY - rect.top) * overlay.height / rect.height;

    if (S.mode === 'calib') {
      S.calibPts.push({ x: cx * origPerCanvas, y: cy * origPerCanvas });
      if (S.calibPts.length === 1) {
        $('calibBtn').textContent = '較正中… 2点目をクリック';
      } else if (S.calibPts.length === 2) {
        finishCalibration();
        S.mode = null; syncModeButtons();
      }
      drawOverlay();
      return;
    }

    if (S.mode === 'pick') {
      var x = Math.round(cx), y = Math.round(cy);
      var half = 2;
      var x0 = Math.max(0, x - half), y0 = Math.max(0, y - half);
      var w = Math.min(frameCanvas.width - x0, half * 2 + 1);
      var h = Math.min(frameCanvas.height - y0, half * 2 + 1);
      var d = fctx.getImageData(x0, y0, w, h).data;
      var r = 0, g = 0, b = 0, n = 0;
      for (var i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
      r = Math.round(r / n); g = Math.round(g / n); b = Math.round(b / n);
      var hsv = Tracker.rgb2hsv(r, g, b);
      S.picked = { hue: hsv.h, sat: hsv.s, val: hsv.v, rgb: [r, g, b] };
      $('pickedSwatch').style.background = 'rgb(' + r + ',' + g + ',' + b + ')';

      // 彩度の低い色を指したら白黒モード、鮮やかな色なら色相モードへ毎回切り替える
      $('achromatic').checked = hsv.s < 0.25;
      if ($('achromatic').checked) {
        $('satMin').value = String(Math.min(0.95, Math.max(0.1, hsv.s + 0.18)));
      } else {
        $('satMin').value = String(Math.max(0.12, Math.min(0.9, hsv.s * 0.55)));
        $('valMin').value = String(Math.max(0.05, Math.min(0.9, hsv.v * 0.5)));
      }
      syncSliderLabels();
      S.mode = null; syncModeButtons();
      drawOverlay();
      updateRunButton();
    }
  });

  function finishCalibration() {
    var p = S.calibPts;
    var dx = p[1].x - p[0].x, dy = p[1].y - p[0].y;
    var dist = Math.sqrt(dx * dx + dy * dy);
    var mm = $('knownPreset').value === 'custom'
      ? Number($('knownLength').value) : Number($('knownPreset').value);
    if (!(dist > 3) || !(mm > 0)) {
      $('calibStatus').textContent = '2点が近すぎます。もう一度クリックしてください。';
      $('calibStatus').className = 'status-line bad';
      S.calibPts = [];
      return;
    }
    S.metersPerPixel = (mm / 1000) / dist;
    var pe = previewEl();
    S.calibSize = [pe.videoWidth, pe.videoHeight]; // 録画に引き継ぐ際の整合性チェック用
    $('calibStatus').textContent =
      '較正済み： ' + dist.toFixed(1) + 'px = ' + mm + 'mm（1px = ' +
      (S.metersPerPixel * 1000).toFixed(2) + 'mm）';
    $('calibStatus').className = 'status-line ok';
    updateRunButton();
  }

  $('knownPreset').addEventListener('change', function () {
    $('customLenWrap').hidden = this.value !== 'custom';
    if (S.calibPts.length === 2) finishCalibration();
  });
  $('knownLength').addEventListener('change', function () {
    if (S.calibPts.length === 2) finishCalibration();
  });

  /* ================= スライダー ================= */
  ['hueTol', 'satMin', 'valMin'].forEach(function (id) {
    $(id).addEventListener('input', function () { syncSliderLabels(); drawOverlay(); });
  });
  $('achromatic').addEventListener('change', function () { syncSliderLabels(); drawOverlay(); });

  function syncSliderLabels() {
    var ach = $('achromatic').checked;
    var tol = Number($('hueTol').value);
    $('hueTolVal').textContent = ach ? (tol / 60 * 0.6).toFixed(2) : tol;
    $('hueTolVal').previousSibling.textContent = ach ? '明度の許容幅 ' : '色相の許容幅 ';
    $('hueTolVal').nextSibling.textContent = ach ? '' : '°';
    $('satMinVal').textContent = Number($('satMin').value).toFixed(2);
    $('satMinVal').previousSibling.textContent = ach ? '彩度の上限 ' : '彩度の下限 ';
    $('valMinVal').textContent = Number($('valMin').value).toFixed(2);
    $('valMin').closest('label').hidden = ach;
  }
  syncSliderLabels();

  /* ================= 映像ソースの切り替え ================= */
  var camSupported = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
    && global.isSecureContext;

  function setSource(kind) {
    S.source = kind;
    $('srcFileBtn').classList.toggle('primary', kind === 'file');
    $('srcCamBtn').classList.toggle('primary', kind === 'camera');
    $('srcFilePane').hidden = kind !== 'file';
    $('srcCamPane').hidden = kind !== 'camera';
    $('runFilePane').hidden = kind !== 'file';
    $('runCamPane').hidden = kind !== 'camera';
    if (kind === 'camera' && !camSupported) {
      $('camStatus').textContent = global.isSecureContext
        ? 'このブラウザはカメラに対応していません。'
        : 'カメラは https で開いたときだけ使えます。ファイルを直接開いた場合（file://）は使えません。GitHub Pages などに公開したURLから開いてください。';
      $('camStatus').className = 'status-line bad';
      $('camStartBtn').disabled = true;
    }
    if (kind === 'file') stopCameraPreview();
    updateRunButton();
  }
  $('srcFileBtn').addEventListener('click', function () { setSource('file'); });
  $('srcCamBtn').addEventListener('click', function () { setSource('camera'); });

  /* ================= カメラ ================= */
  function listCameras() {
    if (!camSupported || !navigator.mediaDevices.enumerateDevices) return;
    navigator.mediaDevices.enumerateDevices().then(function (devs) {
      var sel = $('camDevice');
      var cur = sel.value;
      sel.textContent = '';
      var auto = document.createElement('option');
      auto.value = ''; auto.textContent = '自動（背面カメラ優先）';
      sel.appendChild(auto);
      devs.filter(function (d) { return d.kind === 'videoinput'; })
        .forEach(function (d, i) {
          var o = document.createElement('option');
          o.value = d.deviceId;
          o.textContent = d.label || ('カメラ ' + (i + 1));
          sel.appendChild(o);
        });
      if (cur) sel.value = cur;
    }).catch(function () { /* 権限前はラベルが空になるだけなので無視 */ });
  }

  $('camStartBtn').addEventListener('click', function () {
    if (!camSupported) return;
    var q = $('camQuality').value.split('x');
    var constraints = {
      audio: false,
      video: {
        width: { ideal: Number(q[0]) },
        height: { ideal: Number(q[1]) },
        frameRate: { ideal: Number(q[2]) }
      }
    };
    var dev = $('camDevice').value;
    if (dev) constraints.video.deviceId = { exact: dev };
    else constraints.video.facingMode = { ideal: 'environment' };

    $('camStatus').textContent = 'カメラを起動しています…';
    $('camStatus').className = 'status-line';
    $('camStartBtn').disabled = true;

    navigator.mediaDevices.getUserMedia(constraints).then(function (stream) {
      stopCameraPreview();
      S.stream = stream;
      camEl.srcObject = stream;
      return camEl.play().then(function () { return waitForSize(camEl); });
    }).then(function () {
      resetAnalysis();
      S.camLive = true;
      S.ready = true;
      prepareStage(camEl.videoWidth, camEl.videoHeight);
      $('frameSeekWrap').hidden = true;
      $('calibBtn').disabled = false;
      $('pickBtn').disabled = false;
      $('camStopBtn').hidden = false;
      $('camStartBtn').hidden = true;
      $('camStartBtn').disabled = false;

      var track = S.stream.getVideoTracks()[0];
      var st = track.getSettings ? track.getSettings() : {};
      $('camStatus').textContent = 'カメラ動作中： ' + camEl.videoWidth + '×' + camEl.videoHeight +
        (st.frameRate ? ' / ' + Math.round(st.frameRate) + 'fps' : '') +
        (track.label ? ' / ' + track.label : '');
      $('camStatus').className = 'status-line ok';
      $('videoInfo').textContent = 'カメラ映像を使用中';
      $('videoInfo').className = 'status-line ok';
      listCameras();
      startPreviewLoop();
      updateRunButton();
    }).catch(function (err) {
      $('camStartBtn').disabled = false;
      var msg = err && err.name === 'NotAllowedError'
        ? 'カメラの使用が許可されませんでした。ブラウザのアドレスバーからカメラを許可してください。'
        : (err && err.name === 'NotFoundError'
          ? '使えるカメラが見つかりませんでした。'
          : 'カメラを開けませんでした: ' + (err && err.message ? err.message : err));
      $('camStatus').textContent = msg;
      $('camStatus').className = 'status-line bad';
    });
  });

  function waitForSize(el) {
    return new Promise(function (res) {
      if (el.videoWidth) return res();
      var iv = setInterval(function () {
        if (el.videoWidth) { clearInterval(iv); res(); }
      }, 50);
      setTimeout(function () { clearInterval(iv); res(); }, 4000);
    });
  }

  $('camStopBtn').addEventListener('click', function () {
    if (S.recording) stopRecording();
    stopCameraPreview();
    if (S.stream) { S.stream.getTracks().forEach(function (t) { t.stop(); }); S.stream = null; }
    camEl.srcObject = null;
    $('camStopBtn').hidden = true;
    $('camStartBtn').hidden = false;
    $('camStatus').textContent = 'カメラを閉じました。';
    $('camStatus').className = 'status-line';
    updateRunButton();
  });

  /* カメラのプレビュー中は、映像自体は video 要素が表示している。
   * ここでやるのは (1) マーカー指定用に frameCanvas を最新フレームで保っておくこと、
   * (2) マスクのプレビューと較正線を重ねること、の2つだけなので間引いて回す。 */
  var previewRaf = null, lastMaskAt = 0;
  function startPreviewLoop() {
    if (previewRaf) return;
    (function loop() {
      previewRaf = requestAnimationFrame(loop);
      if (!S.camLive || S.recording) return;   // 録画中は追跡ループ側が重ね描きする
      var now = performance.now();
      if (now - lastMaskAt < 130) return;
      lastMaskAt = now;
      drawFrame();       // 画面表示用ではなく、色を拾うための控え
      drawOverlay();
    })();
  }
  function stopCameraPreview() {
    S.camLive = false;
    showLiveVideo(false);
    if (previewRaf) { cancelAnimationFrame(previewRaf); previewRaf = null; }
  }

  /* ================= 録画＋ライブ追跡 ================= */
  function pickMimeType() {
    if (!global.MediaRecorder) return null;
    var candidates = [
      'video/mp4;codecs=avc1',
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm'
    ];
    for (var i = 0; i < candidates.length; i++) {
      if (MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
    }
    return '';
  }

  $('recBtn').addEventListener('click', startRecording);
  $('recStopBtn').addEventListener('click', stopRecording);
  $('recSaveBtn').addEventListener('click', function () {
    if (!S.recBlob) return;
    var ext = (S.recBlob.type.indexOf('mp4') >= 0) ? 'mp4' : 'webm';
    Store.download('vbt-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.' + ext,
      S.recBlob, S.recBlob.type);
  });

  function startRecording() {
    if (!S.stream || S.recording) return;
    var mime = pickMimeType();
    if (mime === null) {
      $('recStatus').textContent = 'このブラウザは録画に対応していません。';
      $('recStatus').className = 'status-line bad';
      return;
    }
    try {
      S.recorder = new MediaRecorder(S.stream, mime ? { mimeType: mime } : undefined);
    } catch (e) {
      $('recStatus').textContent = '録画を開始できませんでした: ' + e.message;
      $('recStatus').className = 'status-line bad';
      return;
    }
    S.recChunks = [];
    S.recSamples = [];
    S.recBlob = null;
    S.recorder.ondataavailable = function (e) { if (e.data && e.data.size) S.recChunks.push(e.data); };
    S.recorder.onstop = onRecordingStopped;
    S.recorder.start();
    S.recording = true;
    S.recStartMs = performance.now();

    $('recBtn').hidden = true;
    $('recStopBtn').hidden = false;
    $('recSaveBtn').hidden = true;
    $('stage').classList.add('recording');
    $('liveTiles').hidden = false;
    $('results').hidden = true;
    $('liveMpv').textContent = '—';
    $('liveReps').textContent = '0';
    $('liveLoss').textContent = '—';
    $('liveTrack').textContent = '—';
    requestWakeLock();
    startLiveTracking();
  }

  function stopRecording() {
    if (!S.recording) return;
    S.recording = false;
    try { S.recorder.stop(); } catch (e) { /* noop */ }
    releaseWakeLock();
    $('stage').classList.remove('recording');
    $('recStopBtn').hidden = true;
    $('recBtn').hidden = false;
    $('recStatus').textContent = '録画を保存しています…';
    $('recStatus').className = 'status-line';
  }

  function onRecordingStopped() {
    var type = (S.recorder && S.recorder.mimeType) || 'video/webm';
    S.recBlob = new Blob(S.recChunks, { type: type });
    S.recChunks = [];
    $('recSaveBtn').hidden = false;
    var secs = (performance.now() - S.recStartMs) / 1000;
    $('recStatus').textContent = '録画 ' + secs.toFixed(1) + '秒（' +
      (S.recBlob.size / 1048576).toFixed(1) + 'MB）。解析しています…';

    // 録画データを通常の解析経路へ流す。カメラは動かしていないので較正とマーカーは引き継ぐ。
    stopCameraPreview();
    loadVideoBlob(S.recBlob, '録画 ' + new Date().toLocaleTimeString('ja-JP'), true).then(function () {
      $('recStatus').textContent = '録画 ' + secs.toFixed(1) + '秒。解析中…';
      if (S.metersPerPixel && S.picked) runAnalysis();
      else {
        $('recStatus').textContent = '録画しました。較正またはマーカー指定をやり直してから解析してください。';
        $('recStatus').className = 'status-line bad';
      }
    }).catch(function (err) {
      $('recStatus').textContent = '録画データを読み込めませんでした: ' + err.message;
      $('recStatus').className = 'status-line bad';
    });
  }

  /* --- 録画中のリアルタイム追跡 --- */
  function startLiveTracking() {
    var cfg = markerConfig();
    if (!cfg) return;
    var procW = Math.min(Number($('oProcWidth').value), camEl.videoWidth);
    var scale = procW / camEl.videoWidth;
    var procH = Math.max(1, Math.round(camEl.videoHeight * scale));
    var lc = document.createElement('canvas');
    lc.width = procW; lc.height = procH;
    var lctx = lc.getContext('2d', { willReadFrequently: true });
    cfg.searchRadius = Number($('oRadius').value);
    cfg.minPixels = 10;
    var matcher = Tracker.makeMatcher(cfg);
    var prev = null, lastUi = 0, lastFrameAt = 0;

    /* ライブ表示はタイマーで回す。
     * ・requestVideoFrameCallback はカメラ（MediaStream）相手だと環境により発火しない
     * ・requestAnimationFrame は描画に紐づくため、画面が合成されない状況で止まる
     * どちらも止まるとライブ表示が黙って死ぬので、カメラのフレームレートに合わせた
     * タイマーで駆動する。時刻はカメラの実時間そのものなので実時計をそのまま使う。 */
    var track0 = S.stream.getVideoTracks()[0];
    var st0 = (track0 && track0.getSettings) ? track0.getSettings() : {};
    var gap = 1000 / Math.max(15, Math.min(120, st0.frameRate || 30));

    function frame() {
      if (!S.recording) return;
      var wall = performance.now();
      lastFrameAt = wall;
      var t = (wall - S.recStartMs) / 1000;
      lctx.drawImage(camEl, 0, 0, procW, procH);
      var img = lctx.getImageData(0, 0, procW, procH);
      var blob = Tracker.locate(img.data, procW, procH, prev, cfg, matcher);
      if (blob) {
        prev = blob;
        S.recSamples.push({ t: t, x: blob.x / scale, y: blob.y / scale, ok: true, n: blob.n });
      } else {
        S.recSamples.push({ t: t, x: 0, y: 0, ok: false, n: 0 });
      }

      // 映像は video 要素が出しているので、重ねるのは追跡位置の印だけ
      octx.clearRect(0, 0, overlay.width, overlay.height);
      if (blob) {
        var st = getComputedStyle(document.documentElement);
        octx.beginPath();
        octx.arc(blob.x / scale / origPerCanvas, blob.y / scale / origPerCanvas, 9, 0, Math.PI * 2);
        octx.strokeStyle = st.getPropertyValue('--series-3').trim() || '#1baf7a';
        octx.lineWidth = 3; octx.stroke();
      }

      if (wall - lastUi > 250) { lastUi = wall; updateLive(); }
      setTimeout(frame, Math.max(4, gap - (performance.now() - wall)));
    }
    frame();
  }

  function updateLive() {
    var secs = (performance.now() - S.recStartMs) / 1000;
    var okN = 0;
    for (var i = 0; i < S.recSamples.length; i++) if (S.recSamples[i].ok) okN++;
    var rate = S.recSamples.length ? okN / S.recSamples.length : 0;
    $('liveTrack').textContent = (rate * 100).toFixed(0) + '%';
    // 取り込めているフレームレートも出す。低ければライブ表示の値は当てにならない。
    var liveFps = secs > 0.5 ? S.recSamples.length / secs : 0;
    $('recStatus').textContent = '録画中 ' + secs.toFixed(1) + '秒（' + S.recSamples.length +
      'フレーム / ライブ解析 ' + liveFps.toFixed(0) + 'fps）';
    $('recStatus').className = (rate > 0.9 && liveFps >= 15) ? 'status-line ok' : 'status-line bad';

    if (okN < 12) return;
    var out = Kin.analyze(S.recSamples, {
      metersPerPixel: S.metersPerPixel,
      slowFactor: 1,
      smoothWindow: Number($('oSmooth').value),
      velThreshold: Number($('oVelThr').value),
      minRom: Number($('oMinRom').value),
      minDuration: 0.15, mergeGap: 0.10,
      loadKg: Number($('fLoad').value) || 0,
      extraKg: Number($('fExtra').value) || 0
    });
    var m = out.metrics;
    $('liveReps').textContent = String(m.length);
    if (m.length) {
      $('liveMpv').textContent = fmt(m[m.length - 1].propulsiveVelocity, 2) + ' m/s';
      $('liveLoss').textContent = fmt(Kin.velocityLoss(m), 0) + ' %';
    }
  }

  function requestWakeLock() {
    if (!navigator.wakeLock || S.wakeLock) return;
    navigator.wakeLock.request('screen').then(function (w) { S.wakeLock = w; })
      .catch(function () { /* 取れなくても録画自体は続く */ });
  }
  function releaseWakeLock() {
    if (S.wakeLock) { try { S.wakeLock.release(); } catch (e) { /* noop */ } S.wakeLock = null; }
  }

  /* ================= 解析実行 ================= */
  function updateRunButton() {
    var ok = S.ready && S.metersPerPixel && S.picked;
    $('runBtn').disabled = !ok;
    $('recBtn').disabled = !(ok && S.stream && S.camLive);
    if (!S.ready) $('runStatus').textContent = '';
    else if (!S.metersPerPixel) $('runStatus').textContent = 'ステップ2のスケール較正が必要です。';
    else if (!S.picked) $('runStatus').textContent = 'ステップ3でマーカーの色を指定してください。';
    else $('runStatus').textContent = '準備できました。';
  }

  $('runBtn').addEventListener('click', runAnalysis);

  function runAnalysis() {
    var cfg = markerConfig();
    if (!cfg || !S.metersPerPixel) return;
    stopCameraPreview();   // 解析中は videoEl から描画する
    cfg.procWidth = Number($('oProcWidth').value);
    cfg.searchRadius = Number($('oRadius').value);
    cfg.minPixels = 10;
    cfg.playbackRate = Number($('oRate').value);
    cfg.fallbackFps = 30;

    S.cancelRef = { cancelled: false };
    $('runBtn').disabled = true;
    $('cancelBtn').hidden = false;
    $('prog').hidden = false;
    $('prog').value = 0;
    $('runStatus').textContent = '解析中…';
    $('runStatus').className = 'status-line';
    $('results').hidden = true;

    var lastDraw = 0;
    videoEl.currentTime = 0;

    Tracker.track(videoEl, cfg, function (frac, count, last) {
      $('prog').value = frac;
      var now = performance.now();
      if (now - lastDraw > 120) {
        lastDraw = now;
        drawFrame();
        octx.clearRect(0, 0, overlay.width, overlay.height);
        if (last && last.ok) {
          var st = getComputedStyle(document.documentElement);
          octx.beginPath();
          octx.arc(last.x / origPerCanvas, last.y / origPerCanvas, 8, 0, Math.PI * 2);
          octx.strokeStyle = st.getPropertyValue('--series-3').trim() || '#1baf7a';
          octx.lineWidth = 3; octx.stroke();
        }
        $('runStatus').textContent = '解析中… ' + Math.round(frac * 100) + '%（' + count + 'フレーム）';
      }
    }, S.cancelRef).then(function (samples) {
      finishRun(samples);
    }).catch(function (err) {
      $('runStatus').textContent = '解析に失敗しました: ' + (err && err.message ? err.message : err);
      $('runStatus').className = 'status-line bad';
      $('runBtn').disabled = false;
      $('cancelBtn').hidden = true;
      $('prog').hidden = true;
    });
  }

  $('cancelBtn').addEventListener('click', function () {
    if (S.cancelRef) S.cancelRef.cancelled = true;
  });

  function finishRun(samples) {
    $('cancelBtn').hidden = true;
    $('prog').hidden = true;
    $('runBtn').disabled = false;
    videoEl.playbackRate = 1;

    var okCount = samples.filter(function (s) { return s.ok; }).length;
    if (okCount < 10) {
      $('runStatus').textContent =
        'マーカーをほとんど検出できませんでした（' + okCount + '/' + samples.length +
        'フレーム）。ステップ3のしきい値を調整してください。';
      $('runStatus').className = 'status-line bad';
      return;
    }

    // 実効フレームレートの推定（中央値）
    var dts = [];
    for (var i = 1; i < samples.length; i++) {
      var d = samples[i].t - samples[i - 1].t;
      if (d > 1e-4) dts.push(d);
    }
    dts.sort(function (a, b) { return a - b; });
    S.fpsEstimate = dts.length ? 1 / dts[Math.floor(dts.length / 2)] : null;

    // カメラ録画は常に実時間。スロー倍率はファイル読み込みのときだけ意味を持つ。
    var slow = S.source === 'camera' ? 1 : Number($('slowFactor').value);
    var loadKg = Number($('fLoad').value) || 0;
    var extraKg = Number($('fExtra').value) || 0;

    var out = Kin.analyze(samples, {
      metersPerPixel: S.metersPerPixel,
      slowFactor: slow,
      smoothWindow: Number($('oSmooth').value),
      velThreshold: Number($('oVelThr').value),
      minRom: Number($('oMinRom').value),
      minDuration: 0.15,
      mergeGap: 0.10,
      loadKg: loadKg,
      extraKg: extraKg
    });

    S.result = {
      out: out, samples: samples, loadKg: loadKg, extraKg: extraKg,
      slowFactor: slow, trackRate: okCount / samples.length
    };

    var lost = samples.length - okCount;
    $('runStatus').textContent =
      '完了。' + samples.length + 'フレーム（実効 ' +
      (S.fpsEstimate ? S.fpsEstimate.toFixed(0) : '?') + 'fps' +
      (slow > 1 ? ' × スロー' + slow + '倍 → 実時間 ' + (S.fpsEstimate * slow).toFixed(0) + 'fps相当' : '') +
      '）、検出率 ' + (okCount / samples.length * 100).toFixed(1) + '%' +
      (lost ? '、未検出 ' + lost + 'フレーム' : '') +
      '、レップ ' + out.metrics.length + '本。';
    // 追跡が飛ぶと物理的にありえない値になる。捨てずに知らせて、判断は利用者に任せる。
    var odd = out.metrics.filter(function (m) {
      return m.peakVelocity > 4 || m.rom > 1.5 || m.duration > 10;
    }).length;
    if (odd) {
      $('runStatus').textContent += ' ただし ' + odd +
        '本に、ありえない速度や可動域が出ています。マーカーが一瞬隠れて別の物に飛んだ可能性があります' +
        '（ステップ3のしきい値を調整するか、その区間を撮り直してください）。';
      $('runStatus').className = 'status-line bad';
    } else {
      $('runStatus').className = out.metrics.length ? 'status-line ok' : 'status-line warn';
    }

    renderResults();

    // カメラ利用中なら、続けて次のセットを撮れるようプレビューへ戻す
    if (S.source === 'camera' && S.stream) {
      S.camLive = true;
      showLiveVideo(true);
      $('frameSeekWrap').hidden = true;
      startPreviewLoop();
      $('recStatus').textContent = '解析が終わりました。続けて撮る場合はそのまま「録画開始」を押してください。';
      $('recStatus').className = 'status-line ok';
    }
  }

  /* ================= 結果表示 ================= */
  function tile(label, value, unit, hero) {
    var d = document.createElement('div');
    d.className = 'tile' + (hero ? ' hero' : '');
    var l = document.createElement('div'); l.className = 'label'; l.textContent = label;
    var v = document.createElement('div'); v.className = 'value'; v.textContent = value;
    if (unit) { var u = document.createElement('span'); u.className = 'unit'; u.textContent = unit; v.appendChild(u); }
    d.appendChild(l); d.appendChild(v);
    return d;
  }

  function renderResults() {
    var r = S.result;
    if (!r) return;
    var m = r.out.metrics, series = r.out.series;
    $('results').hidden = false;

    /* セットの要約。速度の代表値はMPV基準で揃える（理由は kinematics.js の setSummary 参照）。
     * 「セット平均」だけでは判断材料として弱いので、最速レップと速度低下率を並べて出す。 */
    var sum = Kin.setSummary(m);
    var setT = $('setTiles'), bestT = $('bestTiles');
    setT.textContent = ''; bestT.textContent = '';
    if (sum) {
      setT.appendChild(tile('セット平均 速度', fmt(sum.meanVelocity, 2), ' m/s', true));
      setT.appendChild(tile('レップ数', String(sum.reps), ' 回'));
      setT.appendChild(tile('セット平均 パワー', fmt(sum.meanPower, 0), ' W'));
      setT.appendChild(tile('速度低下率', fmt(sum.velocityLoss, 1), ' %'));
      setT.appendChild(tile('平均可動域', fmt(sum.meanRom * 100, 1), ' cm'));

      /* この欄はすべて「最速レップ1本の中の値」で揃える。
       * セット全体の最大パワーが別のレップだった場合だけ、下に注記を出す。 */
      var b = sum.best;
      $('bestGroupTitle').textContent =
        '最速レップ（' + sum.bestRep + '本目・疲労前の実力）';
      bestT.appendChild(tile('速度 MPV', fmt(b.propulsiveVelocity, 2), ' m/s'));
      bestT.appendChild(tile('最高速度（瞬間）', fmt(b.peakVelocity, 2), ' m/s'));
      bestT.appendChild(tile('パワー', fmt(b.propulsivePower, 0), ' W'));
      bestT.appendChild(tile('最大パワー（瞬間）', fmt(b.peakPower, 0), ' W'));
      bestT.appendChild(tile('最終レップとの差', fmt(sum.bestVelocity - sum.lastVelocity, 2), ' m/s'));

      $('bestNote').textContent = sum.reps < 2 ? ''
        : sum.peakPowerRep === sum.bestRep
          ? 'このセットで最もパワーが出たのも、このレップでした。'
          : 'このセットで最もパワーが出たのは ' + sum.peakPowerRep + '本目（'
            + fmt(sum.peakPower, 0) + ' W）で、最速レップとは別でした。'
            + '立ち上がりの鋭さが違うと、こうなることがあります。';
    }

    var bands = r.out.reps.map(function (rep, i) {
      return { x0: series[rep.s].t, x1: series[rep.e].t, label: String(i + 1) };
    });
    var velPts = series.map(function (p) { return { x: p.t, y: p.vel }; });
    var mass = r.loadKg + r.extraKg;
    var powPts = series.map(function (p) { return { x: p.t, y: mass * (p.acc + Kin.G) * p.vel }; });

    var common = {
      xLabel: '時間 (秒)', bands: bands, zeroLine: true, height: 240,
      xFormat: function (v) { return v.toFixed(1); },
      tipFormat: function (v) { return v.toFixed(2) + ' 秒'; }
    };

    var velCfg = Object.assign({}, common, {
      title: 'バー速度の時間変化',
      subtitle: '網かけが検出したレップ（上向きが挙上）',
      yLabel: '速度 (m/s)', unit: ' m/s', yDecimals: 2,
      series: [{ name: 'バー速度', points: velPts }]
    });
    var powCfg = Object.assign({}, common, {
      title: 'パワーの時間変化',
      subtitle: 'バー重量 ' + fmt(mass, 1) + 'kg で算出',
      yLabel: 'パワー (W)', unit: ' W', yDecimals: 0,
      series: [{ name: 'パワー', points: powPts, color: getComputedStyle(document.documentElement).getPropertyValue('--series-2').trim() }]
    });
    if (!charts.vel) {
      charts.vel = Charts.line($('chartVel'), velCfg);
      charts.pow = Charts.line($('chartPow'), powCfg);
      charts.rep = Charts.bars($('chartRep'), repChartCfg());
    } else {
      charts.vel.update(velCfg); charts.pow.update(powCfg); charts.rep.update(repChartCfg());
    }
    $('pathStage').hidden = true;
    $('pathToggle').textContent = '軌跡を表示';
    $('pathStatus').textContent = '';

    renderRepTable(m);
  }

  /* レップ別の表。速度とパワーを先頭に置き、各列の最大を強調し、
   * 最下段に平均の行を出す。強調は色だけに頼らず太字と印も併用する。 */
  var REP_COLS = [
    { h: '速度 MPV', unit: 'm/s', key: 'propulsiveVelocity', d: 2, hi: true },
    { h: '最高速度', unit: 'm/s', key: 'peakVelocity', d: 2, hi: true },
    { h: 'パワー', unit: 'W', key: 'propulsivePower', d: 0, hi: true },
    { h: '最大パワー', unit: 'W', key: 'peakPower', d: 0, hi: true },
    { h: '可動域', unit: 'cm', key: 'rom', d: 1, scale: 100 },
    { h: '所要', unit: '秒', key: 'duration', d: 2 },
    { h: '平均力', unit: 'N', key: 'meanForce', d: 0 },
    { h: '左右ブレ', unit: 'cm', key: 'barPathDeviation', d: 1, scale: 100 }
  ];

  function renderRepTable(m) {
    var tbl = $('repTable');
    tbl.textContent = '';
    if (!m.length) return;

    var thead = document.createElement('thead'), htr = document.createElement('tr');
    var first = document.createElement('th');
    first.textContent = 'レップ';
    htr.appendChild(first);
    REP_COLS.forEach(function (c) {
      var th = document.createElement('th');
      th.textContent = c.h + ' (' + c.unit + ')';
      htr.appendChild(th);
    });
    thead.appendChild(htr); tbl.appendChild(thead);

    // 各列の最大値がどのレップかを先に求める
    var maxIdx = REP_COLS.map(function (c) {
      if (!c.hi) return -1;
      var k = 0;
      for (var i = 1; i < m.length; i++) if (m[i][c.key] > m[k][c.key]) k = i;
      return k;
    });

    var tb = document.createElement('tbody');
    m.forEach(function (x, i) {
      var row = document.createElement('tr');
      var th = document.createElement('td');
      th.textContent = String(i + 1);
      row.appendChild(th);
      REP_COLS.forEach(function (c, ci) {
        var td = document.createElement('td');
        td.textContent = fmt(x[c.key] * (c.scale || 1), c.d);
        if (maxIdx[ci] === i && m.length > 1) {
          td.className = 'is-max';
          td.title = 'このセットの最大';
        }
        row.appendChild(td);
      });
      tb.appendChild(row);
    });
    tbl.appendChild(tb);

    var tfoot = document.createElement('tfoot'), ftr = document.createElement('tr');
    var flabel = document.createElement('td');
    flabel.textContent = '平均';
    ftr.appendChild(flabel);
    REP_COLS.forEach(function (c) {
      var td = document.createElement('td');
      var avg = m.reduce(function (a, x) { return a + x[c.key]; }, 0) / m.length;
      td.textContent = fmt(avg * (c.scale || 1), c.d);
      ftr.appendChild(td);
    });
    tfoot.appendChild(ftr); tbl.appendChild(tfoot);
  }


  /* ---------- レップ別チャート（見る指標を切り替えられる） ---------- */
  var REP_METRICS = {
    propulsiveVelocity: ['平均推進速度', ' m/s', 2, 1, '押し続けている区間の平均。負荷管理の基準になる値'],
    peakVelocity: ['最高速度', ' m/s', 2, 1, '瞬間の最大。爆発力の目安だが、撮影fpsの影響を受けやすい'],
    propulsivePower: ['パワー', ' W', 0, 1, 'MPVと同じ推進局面での平均。バー重量だけで計算している'],
    peakPower: ['最大パワー', ' W', 0, 1, '瞬間の最大。こちらも撮影fpsの影響を受けやすい'],
    rom: ['可動域', ' cm', 1, 100, 'レップごとの動作範囲。疲れると狭くなりやすい']
  };

  function repChartCfg() {
    var r = S.result;
    var m = (r && r.out.metrics) || [];
    var k = $('repMetric').value;
    var info = REP_METRICS[k] || REP_METRICS.propulsiveVelocity;
    return {
      title: 'レップ別の' + info[0],
      subtitle: info[4],
      yLabel: info[0] + ' (' + info[1].trim() + ')', xLabel: 'レップ',
      unit: info[1], yDecimals: info[2], height: 190,
      bars: m.map(function (x, i) { return { label: String(i + 1), value: x[k] * info[3] }; })
    };
  }

  $('repMetric').addEventListener('change', function () {
    if (charts.rep) charts.rep.update(repChartCfg());
  });

  /* ---------- バーの軌跡 ----------
   * 追跡結果には水平方向の座標も入っているので、映像の上に道すじを重ねて描ける。
   * レップごとの色分けは順序のある量なので、カテゴリ配色ではなく
   * 明→暗の単一色ランプを使う（1本目が明るく、最終レップが暗い）。 */
  var BLUE_RAMP_LIGHT = ['#86b6ef', '#6da7ec', '#5598e7', '#3987e5', '#2a78d6',
                         '#256abf', '#1c5cab', '#184f95', '#104281', '#0d366b'];
  var BLUE_RAMP_DARK = ['#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec',
                        '#5598e7', '#3987e5', '#2a78d6', '#256abf', '#184f95'];

  function isDarkTheme() {
    var s = getComputedStyle(document.documentElement).getPropertyValue('--surface-1').trim();
    var m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(s.replace('#', '#'));
    if (!m) return false;
    var lum = 0.2126 * parseInt(m[1], 16) + 0.7152 * parseInt(m[2], 16) + 0.0722 * parseInt(m[3], 16);
    return lum < 128;
  }

  function rampColor(i, n) {
    var ramp = isDarkTheme() ? BLUE_RAMP_DARK : BLUE_RAMP_LIGHT;
    if (n <= 1) return ramp[Math.floor(ramp.length / 2)];
    return ramp[Math.round(i / (n - 1) * (ramp.length - 1))];
  }

  function renderBarPath() {
    var r = S.result;
    if (!r || !r.out.series.length) { $('pathStatus').textContent = '軌跡を描けるデータがありません。'; return; }
    var series = r.out.series, reps = r.out.reps;
    var mpp = S.metersPerPixel;
    var cv = $('pathCanvas');
    cv.width = frameCanvas.width; cv.height = frameCanvas.height;
    var ctx = cv.getContext('2d');

    // 代表フレーム（セットの中ほど）を背景に敷く。動画時間はスロー倍率をかけ戻す。
    var midT = series[Math.floor(series.length / 2)].t * (r.slowFactor || 1);
    return seekTo(midT).then(function () {
      ctx.drawImage(videoEl, 0, 0, cv.width, cv.height);
      ctx.fillStyle = 'rgba(0,0,0,0.30)';        // 線を見やすくするため映像を少し沈める
      ctx.fillRect(0, 0, cv.width, cv.height);

      function cx(p) { return (p.x / mpp) / origPerCanvas; }
      function cy(p) { return (-p.pos / mpp) / origPerCanvas; }

      // 全体の道すじ（下ろす局面を含む）
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 1.5; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.beginPath();
      series.forEach(function (p, i) {
        if (i === 0) ctx.moveTo(cx(p), cy(p)); else ctx.lineTo(cx(p), cy(p));
      });
      ctx.stroke();

      // 挙上局面を濃く重ねる
      var byRep = $('pathRepColors').checked;
      var flat = getComputedStyle(document.documentElement).getPropertyValue('--series-1').trim() || '#2a78d6';
      reps.forEach(function (rep, i) {
        ctx.strokeStyle = byRep ? rampColor(i, reps.length) : flat;
        ctx.lineWidth = 3;
        ctx.beginPath();
        for (var k = rep.s; k <= rep.e; k++) {
          var p = series[k];
          if (k === rep.s) ctx.moveTo(cx(p), cy(p)); else ctx.lineTo(cx(p), cy(p));
        }
        ctx.stroke();
        // 開始点（下）と終了点（上）
        [series[rep.s], series[rep.e]].forEach(function (p, j) {
          ctx.beginPath();
          ctx.arc(cx(p), cy(p), 4.5, 0, Math.PI * 2);
          ctx.fillStyle = j === 0 ? 'rgba(255,255,255,0.9)' : (byRep ? rampColor(i, reps.length) : flat);
          ctx.fill();
          ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.stroke();
        });
      });

      var dev = r.out.metrics.map(function (x) { return x.barPathDeviation * 100; });
      var maxDev = dev.length ? Math.max.apply(null, dev) : 0;
      var avgDev = dev.length ? dev.reduce(function (a, b) { return a + b; }, 0) / dev.length : 0;
      $('pathStatus').textContent = '左右のブレ： 平均 ' + fmt(avgDev, 1) + ' cm ／ 最大 ' + fmt(maxDev, 1) + ' cm。'
        + (byRep ? ' 色が薄いほど早いレップ、濃いほど後のレップです。' : '')
        + ' カメラが正対していないと、ブレが実際より大きく見えることがあります。';
      $('pathStatus').className = 'status-line';
    });
  }

  $('pathToggle').addEventListener('click', function () {
    var stage = $('pathStage');
    if (stage.hidden) {
      stage.hidden = false;
      this.textContent = '軌跡を隠す';
      renderBarPath();
    } else {
      stage.hidden = true;
      this.textContent = '軌跡を表示';
      $('pathStatus').textContent = '';
    }
  });

  $('pathRepColors').addEventListener('change', function () {
    if (!$('pathStage').hidden) renderBarPath();
  });

  $('discardBtn').addEventListener('click', function () {
    S.result = null; $('results').hidden = true; $('saveStatus').textContent = '';
  });

  $('saveBtn').addEventListener('click', function () {
    var r = S.result;
    if (!r || !r.out.metrics.length) {
      $('saveStatus').textContent = 'レップが検出されていないため保存できません。';
      $('saveStatus').className = 'status-line bad';
      return;
    }
    var who = Store.athleteById($('fAthlete').value);
    if (!who || !isAuthed(who.id)) {
      $('saveStatus').textContent = !Store.roster().length
        ? '先に「＋ 初めての人はここで登録」から選手を登録してください。'
        : (who ? '本人確認がまだです。選手を選び直してPINを入れてください。'
               : '「選手」を選んでから保存してください。誰の記録か分からなくなります。');
      $('saveStatus').className = 'status-line bad';
      $('fAthlete').scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    var rec = {
      date: $('fDate').value || new Date().toISOString().slice(0, 10),
      time: $('fTime').value || nowHHMM(),
      athleteId: who.id,
      athlete: who.name,
      exercise: $('fExercise').value || 'その他',
      loadKg: Number($('fLoad').value) || 0,
      extraKg: Number($('fExtra').value) || 0,
      note: $('fNote').value.trim(),
      videoName: S.fileName || '',
      fps: S.fpsEstimate ? Math.round(S.fpsEstimate * r.slowFactor) : null,
      slowFactor: r.slowFactor,
      metersPerPixel: S.metersPerPixel,
      trackRate: r.trackRate,
      // 長期の推移用に、セット単位の平均・最速・最大をそのまま持たせておく
      summary: (function () {
        var s = Kin.setSummary(r.out.metrics);
        if (!s) return null;
        function rd(v, d) { return Math.round(v * Math.pow(10, d)) / Math.pow(10, d); }
        return {
          reps: s.reps,
          meanVelocity: rd(s.meanVelocity, 4),
          bestVelocity: rd(s.bestVelocity, 4),
          lastVelocity: rd(s.lastVelocity, 4),
          velocityLoss: rd(s.velocityLoss, 2),
          meanPower: rd(s.meanPower, 1),
          peakPower: rd(s.peakPower, 1),
          bestRep: s.bestRep,
          peakPowerRep: s.peakPowerRep,
          meanRom: rd(s.meanRom, 4)
        };
      })(),
      reps: r.out.metrics.map(function (x) {
        var o = {};
        Object.keys(x).forEach(function (k) {
          o[k] = typeof x[k] === 'number' ? Math.round(x[k] * 100000) / 100000 : x[k];
        });
        return o;
      })
    };
    Store.add(rec);
    $('saveStatus').textContent = '保存しました（' + rec.athlete + '／' + rec.date + ' ' + rec.time + ' '
      + rec.exercise + ' ' + rec.loadKg + 'kg）。「履歴と推移」タブで確認できます。';
    $('saveStatus').className = 'status-line ok';
    // 続けて次のセットを撮ることが多いので、時刻は「いま」に進めておく
    $('fTime').value = nowHHMM();
  });

  /* ================= 選手（名簿） =================
   * 端末ごとに名簿を持つ。初めての人だけ登録し、以後はプルダウンで選ぶ。
   * 人数が増えても探しやすいよう、選択肢は学年でグループ分けする。 */

  function gradeGroups(list) {
    var order = Store.GRADES.slice();
    var groups = {}, extras = [];
    list.forEach(function (a) {
      var g = a.grade || '';
      if (!groups[g]) { groups[g] = []; if (order.indexOf(g) < 0) extras.push(g); }
      groups[g].push(a);
    });
    return order.concat(extras).filter(function (g) { return groups[g]; })
      .map(function (g) { return { label: g || '学年なし', items: groups[g] }; });
  }

  function renderAthleteSelect() {
    var sel = $('fAthlete');
    var list = Store.roster();
    var cur = Store.currentAthleteId();
    sel.textContent = '';

    if (!list.length) {
      var none = document.createElement('option');
      none.value = ''; none.textContent = '（まだ誰も登録されていません）';
      sel.appendChild(none);
    } else {
      var ph = document.createElement('option');
      ph.value = ''; ph.textContent = '— 選んでください —';
      sel.appendChild(ph);
      gradeGroups(list).forEach(function (grp) {
        var og = document.createElement('optgroup');
        og.label = grp.label;
        grp.items.forEach(function (a) {
          var o = document.createElement('option');
          o.value = a.id;
          o.textContent = a.sex && a.sex !== '回答しない' ? a.name + '（' + a.sex + '）' : a.name;
          og.appendChild(o);
        });
        sel.appendChild(og);
      });
      if (Store.athleteById(cur)) sel.value = cur;
    }
    $('editAthleteBtn').disabled = !isAuthed(sel.value);
    updateWho();
  }

  /* ---------- 種目（選手ごとに追加できる） ---------- */
  function renderExerciseSelect() {
    var sel = $('fExercise');
    var id = Store.currentAthleteId();
    var cur = sel.value;
    var list = Store.exercisesFor(id);
    sel.textContent = '';
    list.forEach(function (n) {
      var o = document.createElement('option');
      o.value = n; o.textContent = n;
      if (!Store.isPresetExercise(n)) o.textContent = n + '（追加）';
      sel.appendChild(o);
    });
    sel.value = list.indexOf(cur) >= 0 ? cur : list[0];
    $('addExerciseBtn').disabled = !isAuthed(id);
  }

  function exSay(msg, cls) {
    $('exerciseStatus').textContent = msg || '';
    $('exerciseStatus').className = 'status-line ' + (cls || '');
  }

  $('addExerciseBtn').addEventListener('click', function () {
    $('addExerciseRow').hidden = false;
    $('newExerciseName').value = '';
    exSay('');
    $('newExerciseName').focus();
  });
  $('addExerciseCancel').addEventListener('click', function () {
    $('addExerciseRow').hidden = true; exSay('');
  });
  $('newExerciseName').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); $('addExerciseOk').click(); }
  });
  $('addExerciseOk').addEventListener('click', function () {
    try {
      var n = Store.addExerciseFor(Store.currentAthleteId(), $('newExerciseName').value);
      $('addExerciseRow').hidden = true;
      renderExerciseSelect();
      $('fExercise').value = n;
      exSay('「' + n + '」を追加しました。次回からプルダウンに出ます。', 'ok');
      renderHistory();
    } catch (err) { exSay(err.message, 'bad'); }
  });

  function nowHHMM() {
    var d = new Date();
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }

  function updateWho() {
    var a = Store.currentAthlete();
    var btn = $('whoBtn');
    var ok = !!a && isAuthed(a.id);
    $('whoName').textContent = a ? Store.athleteLabel(a) : '選手を選ぶ';
    btn.classList.toggle('unset', !ok);
  }

  // 本人確認が取れていないと、書き出しも保存もできない
  function updateIoButtons() {
    var ok = isAuthed(Store.currentAthleteId());
    $('expCsv').disabled = !ok;
    $('expJson').disabled = !ok;
  }

  /* ---------- 本人確認 ----------
   * サーバーが無いので、これは「鍵」ではなく取り違え・軽いなりすましを防ぐ仕組み。
   * authedId は、このページを開いてから本人確認が取れている選手。 */
  var authedId = '';

  function isAuthed(id) { return !!id && authedId === id; }

  function afterAuthChange() {
    var id = Store.currentAthleteId();
    if (!Store.athleteById(id)) id = '';
    $('fAthlete').value = id;
    $('editAthleteBtn').disabled = !isAuthed(id);
    renderExerciseSelect();   // 種目は選手ごとに違うので、切り替えのたびに組み直す
    updateWho();
    updateIoButtons();
  }

  // 選手を選ぶ＝その人として記録できる状態にすること。必要ならPINを聞く。
  function selectAthlete(id, done) {
    if (!id) {
      authedId = ''; Store.setCurrentAthlete(''); afterAuthChange();
      if (done) done(false);
      return;
    }
    if (authedId === id || !Store.hasPin(id) || Store.isTrusted(id)) {
      authedId = id; Store.setCurrentAthlete(id); afterAuthChange();
      if (done) done(true);
      return;
    }
    askPin(id, function (ok) {
      if (ok) { authedId = id; Store.setCurrentAthlete(id); }
      afterAuthChange();
      if (done) done(ok);
    });
  }

  $('fAthlete').addEventListener('change', function () { selectAthlete(this.value); });

  // ヘッダーの名前を押したら、選手の欄まで連れて行く
  $('whoBtn').addEventListener('click', function () {
    if (!Store.roster().length) { openAthleteModal(null); return; }
    showTab('analyze');
    $('fAthlete').scrollIntoView({ block: 'center', behavior: 'smooth' });
    $('fAthlete').focus();
  });

  /* ---------- PIN入力モーダル（選手PIN・管理PIN 兼用） ---------- */
  var pmCtx = null;

  function closePinModal() { $('pinModal').hidden = true; pmCtx = null; }

  function pmFail(msg) { $('pmError').textContent = msg; $('pmError').hidden = false; }

  function askPin(id, cb) {
    var a = Store.athleteById(id);
    if (!a) { cb(false); return; }
    pmCtx = { mode: 'athlete', id: id, cb: cb };
    $('pmTitle').textContent = a.name + ' のPIN';
    $('pmHint').textContent = 'この人として記録するには、本人のPINを入れてください。';
    $('pmPin').value = '';
    $('pmError').hidden = true;
    $('pmTrust').checked = Store.isTrusted(id);
    $('pmTrustWrap').hidden = false;
    $('pmForgot').hidden = false;
    $('pinModal').hidden = false;
    setTimeout(function () { $('pmPin').focus(); }, 30);
  }

  /* 管理PIN。設定されていなければ、警告つきの確認だけで通す。 */
  function askAdminPin(reason, cb) {
    if (!Store.hasAdminPin()) {
      cb(confirm(reason + '\n\nこの端末には管理PINが設定されていません。'
        + 'いまは誰でもこの操作ができる状態です。\n続けますか？'));
      return;
    }
    pmCtx = { mode: 'admin', cb: cb };
    $('pmTitle').textContent = '管理PIN';
    $('pmHint').textContent = reason;
    $('pmPin').value = '';
    $('pmError').hidden = true;
    $('pmTrustWrap').hidden = true;
    $('pmForgot').hidden = true;
    $('pinModal').hidden = false;
    setTimeout(function () { $('pmPin').focus(); }, 30);
  }

  $('pmOk').addEventListener('click', function () {
    if (!pmCtx) return;
    var ctx = pmCtx, pin = $('pmPin').value;
    var check = ctx.mode === 'admin' ? Store.verifyAdminPin(pin) : Store.verifyPin(ctx.id, pin);
    check.then(function (ok) {
      if (!ok) { pmFail('PINが違います。'); $('pmPin').value = ''; $('pmPin').focus(); return; }
      if (ctx.mode === 'athlete') Store.setTrusted(ctx.id, $('pmTrust').checked);
      closePinModal();
      ctx.cb(true);
    });
  });

  $('pmPin').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); $('pmOk').click(); }
  });

  $('pmCancel').addEventListener('click', function () {
    var ctx = pmCtx;
    closePinModal();
    if (ctx) ctx.cb(false);
  });

  $('pinModal').addEventListener('click', function (e) {
    if (e.target === this) $('pmCancel').click();
  });

  // PINを忘れたときは、管理PINを通したうえで本人に再設定してもらう
  $('pmForgot').addEventListener('click', function () {
    var ctx = pmCtx;
    if (!ctx || ctx.mode !== 'athlete') return;
    var a = Store.athleteById(ctx.id);
    closePinModal();
    if (ctx.cb) ctx.cb(false);
    askAdminPin((a ? a.name : 'この選手') + ' のPINを再設定します。', function (ok) {
      if (ok) openAthleteModal(a.id, { resetPin: true });
    });
  });

  /* ---------- 登録・編集モーダル ---------- */
  var amEditingId = null;
  var amPinRequired = false;

  function fillOptions(sel, values, includeBlank) {
    sel.textContent = '';
    if (includeBlank) {
      var b = document.createElement('option');
      b.value = ''; b.textContent = '未設定';
      sel.appendChild(b);
    }
    values.forEach(function (v) {
      var o = document.createElement('option'); o.value = v; o.textContent = v; sel.appendChild(o);
    });
  }

  function showPinFields(on) {
    amPinRequired = on;
    $('amPinBlock').hidden = !on;
    $('amPin').value = ''; $('amPin2').value = '';
  }

  function openAthleteModal(id, opts) {
    opts = opts || {};
    amEditingId = id || null;
    fillOptions($('amGrade'), Store.GRADES, true);
    fillOptions($('amSex'), Store.SEXES, true);
    var a = id ? Store.athleteById(id) : null;

    $('amTitle').textContent = !a ? '選手を登録' : (opts.resetPin ? 'PINを再設定' : '選手の情報を直す');
    $('amHint').textContent = opts.firstRun
      ? 'はじめまして。記録を誰のものか区別するため、最初に一度だけ入力してください。次回からはプルダウンで選ぶだけです。'
      : opts.resetPin
        ? '新しいPINを決めてください。古いPINは使えなくなります。'
        : (a ? '学年が上がったときなどに変更してください。過去の記録は消えません。'
             : '名前・学年・性別とPINを入力してください。次回からはプルダウンで選ぶだけです。');
    $('amName').value = a ? a.name : '';
    $('amGrade').value = a ? (a.grade || '') : '';
    $('amSex').value = a ? (a.sex || '') : '';
    $('amTrust').checked = a ? Store.isTrusted(a.id) : true;
    showPinFields(!a || !!opts.resetPin);
    $('amChangePin').hidden = !a || !!opts.resetPin;
    $('amDelete').hidden = !a;
    $('amError').hidden = true;
    $('athleteModal').hidden = false;
    setTimeout(function () { $(a && !opts.resetPin ? 'amName' : (a ? 'amPin' : 'amName')).focus(); }, 30);
  }

  function closeAthleteModal() { $('athleteModal').hidden = true; amEditingId = null; }

  function amFail(msg) {
    $('amError').textContent = msg;
    $('amError').hidden = false;
  }

  $('newAthleteBtn').addEventListener('click', function () { openAthleteModal(null); });
  $('editAthleteBtn').addEventListener('click', function () {
    var id = $('fAthlete').value;
    if (id && isAuthed(id)) openAthleteModal(id);
  });
  $('amChangePin').addEventListener('click', function () {
    showPinFields(true);
    $('amChangePin').hidden = true;
    $('amHint').textContent = '新しいPINを決めてください。古いPINは使えなくなります。';
    $('amPin').focus();
  });
  $('amCancel').addEventListener('click', closeAthleteModal);
  $('athleteModal').addEventListener('click', function (e) {
    if (e.target === this) closeAthleteModal();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (!$('pinModal').hidden) { $('pmCancel').click(); return; }
    if (!$('adminModal').hidden) { $('adminModal').hidden = true; return; }
    if (!$('athleteModal').hidden) closeAthleteModal();
  });
  ['amName', 'amPin', 'amPin2'].forEach(function (id) {
    $(id).addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); $('amSave').click(); }
    });
  });

  $('amSave').addEventListener('click', function () {
    var name = $('amName').value.trim();
    if (!name) { amFail('名前を入力してください。'); return; }
    var pin = $('amPin').value.trim(), pin2 = $('amPin2').value.trim();
    if (amPinRequired) {
      if (!/^\d{4}$/.test(pin)) { amFail('PINは数字4桁で入力してください。'); return; }
      if (pin !== pin2) { amFail('PINが一致しません。もう一度入力してください。'); return; }
    }
    var a;
    try {
      a = amEditingId
        ? Store.updateAthlete(amEditingId, { name: name, grade: $('amGrade').value, sex: $('amSex').value })
        : Store.addAthlete({ name: name, grade: $('amGrade').value, sex: $('amSex').value });
    } catch (err) { amFail(err.message); return; }

    (amPinRequired ? Store.setPin(a.id, pin) : Promise.resolve()).then(function () {
      Store.setTrusted(a.id, $('amTrust').checked);
      authedId = a.id;
      Store.setCurrentAthlete(a.id);
      closeAthleteModal();
      renderAthleteSelect();
      afterAuthChange();
      renderHistory();
    }, function (err) { amFail(err.message); });
  });

  $('amDelete').addEventListener('click', function () {
    var a = amEditingId ? Store.athleteById(amEditingId) : null;
    if (!a) return;
    var n = Store.load().filter(function (r) { return r.athleteId === a.id; }).length;
    askAdminPin(a.name + ' を名簿から削除します。'
      + (n ? '記録 ' + n + '件はそのまま残ります（選手なしの扱いになります）。' : ''), function (ok) {
      if (!ok) return;
      Store.removeAthlete(a.id);
      if (authedId === a.id) authedId = '';
      closeAthleteModal();
      renderAthleteSelect();
      afterAuthChange();
      renderHistory();
    });
  });

  /* ---------- 管理PINの設定 ---------- */
  function updateAdminStatus() {
    var on = Store.hasAdminPin();
    $('adminStatus').textContent = on
      ? '管理PINは設定済みです。PINのリセット・名簿からの削除・記録の一括削除・読み込みに必要になります。'
      : '管理PINは未設定です。いまは誰でもPINのリセットや削除ができます。';
    $('adminStatus').className = 'status-line ' + (on ? 'ok' : 'warn');
    $('adminPinBtn').textContent = on ? '管理PINを変える／解除する' : '管理PINを設定する';
  }

  $('adminPinBtn').addEventListener('click', function () {
    var on = Store.hasAdminPin();
    $('apHint').textContent = on
      ? 'いまの管理PINを入れてから、新しいPINを決めてください。'
      : '共用端末で使うなら設定しておくことをおすすめします。忘れると解除できないので注意してください。';
    $('apOldWrap').hidden = !on;
    $('apOld').value = ''; $('apNew').value = ''; $('apNew2').value = '';
    $('apError').hidden = true;
    $('adminModal').hidden = false;
    setTimeout(function () { $(on ? 'apOld' : 'apNew').focus(); }, 30);
  });

  $('apCancel').addEventListener('click', function () { $('adminModal').hidden = true; });
  $('adminModal').addEventListener('click', function (e) {
    if (e.target === this) $('adminModal').hidden = true;
  });

  $('apSave').addEventListener('click', function () {
    var neu = $('apNew').value.trim(), neu2 = $('apNew2').value.trim();
    if (neu && !/^\d{4}$/.test(neu)) {
      $('apError').textContent = '管理PINは数字4桁で入力してください。';
      $('apError').hidden = false; return;
    }
    if (neu !== neu2) {
      $('apError').textContent = 'PINが一致しません。';
      $('apError').hidden = false; return;
    }
    if (!neu && !confirm('管理PINを解除します。誰でもPINのリセットや削除ができる状態に戻ります。よろしいですか？')) return;
    Store.verifyAdminPin($('apOld').value).then(function (ok) {
      if (!ok) {
        $('apError').textContent = 'いまの管理PINが違います。';
        $('apError').hidden = false; return;
      }
      return Store.setAdminPin(neu).then(function () {
        $('adminModal').hidden = true;
        updateAdminStatus();
      });
    }, function (err) {
      $('apError').textContent = err.message;
      $('apError').hidden = false;
    });
  });

  /* ================= 履歴 ================= */

  function fillSelect(sel, values, keep) {
    var cur = keep ? sel.value : '';
    sel.textContent = '';
    var all = document.createElement('option');
    all.value = ''; all.textContent = 'すべて';
    sel.appendChild(all);
    values.forEach(function (v) {
      var o = document.createElement('option'); o.value = v; o.textContent = v; sel.appendChild(o);
    });
    if (values.indexOf(cur) >= 0) sel.value = cur;
  }

  ['hRange', 'hGrade', 'hSex', 'hAthlete', 'hExercise', 'hMetric'].forEach(function (id) {
    $(id).addEventListener('change', renderHistory);
  });

  var UNSET = '（未設定）';

  // 学年・性別の絞り込みは名簿の「いまの」情報で判定する（記録時点の値ではない）
  function rosterMatching() {
    var g = $('hGrade').value, s = $('hSex').value;
    return Store.roster().filter(function (a) {
      if (g && (a.grade || UNSET) !== g) return false;
      if (s && (a.sex || UNSET) !== s) return false;
      return true;
    });
  }

  // 未記入の人が絞り込みで見えなくならないよう、いる場合だけ「（未設定）」を出す
  function filterValues(base, key) {
    var hasBlank = Store.roster().some(function (a) { return !a[key]; });
    return hasBlank ? base.concat([UNSET]) : base;
  }

  function filtered() {
    var days = Number($('hRange').value);
    var ath = $('hAthlete').value, ex = $('hExercise').value;
    var cutoff = null;
    if (days) {
      var d = new Date(); d.setDate(d.getDate() - days);
      cutoff = d.toISOString().slice(0, 10);
    }
    var allowed = null;
    if ($('hGrade').value || $('hSex').value) {
      allowed = {};
      rosterMatching().forEach(function (a) { allowed[a.id] = 1; });
    }
    return Store.load().filter(function (r) {
      if (cutoff && r.date < cutoff) return false;
      if (allowed && !allowed[r.athleteId]) return false;
      if (ath && r.athleteId !== ath) return false;
      if (ex && r.exercise !== ex) return false;
      return true;
    });
  }

  function bestOf(rec, key) {
    if (!rec.reps || !rec.reps.length) return null;
    return Math.max.apply(null, rec.reps.map(function (x) { return x[key]; }));
  }

  /* セット単位の要約。保存済みならそれを使い、
   * 要約を持たない古い記録はレップから計算し直す。 */
  function summaryOf(rec) {
    if (rec.summary) return rec.summary;
    if (!rec.reps || !rec.reps.length) return null;
    return Kin.setSummary(rec.reps);
  }

  // 選手のプルダウンは値がID・表示が名前なので、汎用の fillSelect とは別に組む
  function fillAthleteFilter() {
    var sel = $('hAthlete');
    var cur = sel.value;
    sel.textContent = '';
    var all = document.createElement('option');
    all.value = ''; all.textContent = 'すべて';
    sel.appendChild(all);
    var list = rosterMatching();
    var found = false;
    gradeGroups(list).forEach(function (grp) {
      var og = document.createElement('optgroup');
      og.label = grp.label;
      grp.items.forEach(function (a) {
        var o = document.createElement('option');
        o.value = a.id; o.textContent = a.name;
        if (a.id === cur) found = true;
        og.appendChild(o);
      });
      sel.appendChild(og);
    });
    sel.value = found ? cur : ''; // 学年・性別の絞り込みで消えた選手は「すべて」に戻す
  }

  function renderHistory() {
    var all = Store.load();
    fillSelect($('hGrade'), filterValues(Store.GRADES, 'grade'), true);
    fillSelect($('hSex'), filterValues(Store.SEXES, 'sex'), true);
    fillAthleteFilter();
    fillSelect($('hExercise'), Store.exercises(), true);

    var list = filtered();
    var metric = $('hMetric').value;
    var exSel = $('hExercise').value;

    /* --- 荷重-速度プロファイル --- */
    var lvPoints = [], profile = null, mvt = null;
    if (exSel) {
      mvt = Store.mvtFor(exSel);
      lvPoints = list.map(function (r) {
        var s = summaryOf(r);
        return { load: r.loadKg, velocity: s && s.bestVelocity, rec: r };
      }).filter(function (p) { return p.velocity != null && p.load > 0; });
      profile = Kin.loadVelocityProfile(lvPoints, mvt);
    }

    /* --- タイル --- */
    var tl = $('historyTiles');
    tl.textContent = '';
    var totalReps = list.reduce(function (a, r) { return a + (r.reps ? r.reps.length : 0); }, 0);
    var bestV = list.length ? Math.max.apply(null, list.map(function (r) { var s = summaryOf(r); return (s && s.bestVelocity) || 0; })) : 0;
    var bestP = list.length ? Math.max.apply(null, list.map(function (r) { var s = summaryOf(r); return (s && s.peakPower) || 0; })) : 0;
    if (profile && profile.e1rm) {
      tl.appendChild(tile('推定1RM', fmt(profile.e1rm, 1), ' kg', true));
    } else {
      tl.appendChild(tile('最高 平均推進速度', fmt(bestV, 2), ' m/s', true));
    }
    tl.appendChild(tile('セット数', String(list.length), ''));
    tl.appendChild(tile('総レップ数', String(totalReps), ' 回'));
    tl.appendChild(tile('最大パワー', fmt(bestP, 0), ' W'));

    /* --- 推移チャート --- */
    renderTrend(list, metric, profile, mvt, exSel);

    /* --- 荷重-速度チャート --- */
    renderLV(exSel, lvPoints, profile, mvt);

    /* --- MVT 設定 --- */
    renderMvtGrid();

    renderSessionTable(list, all, exSel);
  }

  /* セット単位の一覧。グラフと同じ「平均と最大」を、日時と並べて数値で読む。 */
  function renderSessionTable(list, all, exSel) {
    $('sessionTitle').textContent = exSel ? exSel + ' の記録' : '記録一覧';
    $('sessionHint').textContent = exSel
      ? '新しいものが上です。上のグラフと同じ値を数値で並べています。'
      : '種目を1つ選ぶと、その種目だけの一覧になります。';

    var tbl = $('sessionTable');
    tbl.textContent = '';
    if (!list.length) {
      var p = document.createElement('tbody'), tr0 = document.createElement('tr'), td0 = document.createElement('td');
      td0.textContent = all.length ? '条件に合う記録がありません。' : 'まだ記録がありません。「解析」タブから追加してください。';
      tr0.appendChild(td0); p.appendChild(tr0); tbl.appendChild(p);
      return;
    }

    var multiAthlete = !$('hAthlete').value;
    var cols = [{ h: '日時', f: function (r) { return r.date.slice(5) + ' ' + (r.time || '--:--'); } }];
    if (multiAthlete) cols.push({ h: '選手', f: function (r) { return r.athlete || ''; } });
    if (!exSel) cols.push({ h: '種目', f: function (r) { return r.exercise; } });
    cols = cols.concat([
      { h: '重量 (kg)', f: function (r) { return fmt(r.loadKg, 1); } },
      { h: 'レップ', f: function (r) { return String((r.reps || []).length); } },
      { h: '平均速度 (m/s)', f: function (r, s) { return fmt(s && s.meanVelocity, 2); }, hi: 'meanVelocity', avg: 'meanVelocity', d: 2 },
      { h: '最速 (m/s)', f: function (r, s) { return fmt(s && s.bestVelocity, 2); }, hi: 'bestVelocity', avg: 'bestVelocity', d: 2 },
      { h: '平均パワー (W)', f: function (r, s) { return fmt(s && s.meanPower, 0); }, hi: 'meanPower', avg: 'meanPower', d: 0 },
      { h: '最大パワー (W)', f: function (r, s) { return fmt(s && s.peakPower, 0); }, hi: 'peakPower', avg: 'peakPower', d: 0 },
      // 低下率は「大きいほど良い」ではないので、平均は出すが最大の強調はしない
      { h: '低下率 (%)', f: function (r, s) { return fmt(s && s.velocityLoss, 1); }, avg: 'velocityLoss', d: 1 },
      { h: '', f: null }
    ]);

    var rows = list.slice().reverse().map(function (r) { return { r: r, s: summaryOf(r) }; });

    // 期間内の最高値を強調する（種目を絞っていないと種目間の比較になるので出さない）
    var best = {};
    if (exSel) {
      cols.forEach(function (c) {
        if (!c.hi) return;
        var m = -Infinity;
        rows.forEach(function (row) { if (row.s && row.s[c.hi] > m) m = row.s[c.hi]; });
        best[c.hi] = m;
      });
    }

    var thead = document.createElement('thead'), htr = document.createElement('tr');
    cols.forEach(function (c) { var th = document.createElement('th'); th.textContent = c.h; htr.appendChild(th); });
    thead.appendChild(htr); tbl.appendChild(thead);

    var tb = document.createElement('tbody');
    rows.forEach(function (row) {
      var tr = document.createElement('tr');
      cols.forEach(function (c) {
        var td = document.createElement('td');
        if (!c.f) {
          var del = document.createElement('button');
          del.className = 'btn danger'; del.type = 'button'; del.textContent = '削除';
          del.addEventListener('click', function () {
            if (!confirm(row.r.date + ' ' + (row.r.time || '') + ' ' + row.r.exercise + ' '
              + row.r.loadKg + 'kg の記録を削除します。よろしいですか？')) return;
            Store.remove(row.r.id);
            renderHistory();
          });
          td.appendChild(del);
        } else {
          td.textContent = c.f(row.r, row.s);
          if (c.hi && row.s && best[c.hi] != null && row.s[c.hi] === best[c.hi] && rows.length > 1) {
            td.className = 'is-max';
            td.title = 'この期間の最高';
          }
        }
        tr.appendChild(td);
      });
      tb.appendChild(tr);
    });
    tbl.appendChild(tb);

    // 最下段に平均
    var tfoot = document.createElement('tfoot'), ftr = document.createElement('tr');
    cols.forEach(function (c, i) {
      var td = document.createElement('td');
      if (i === 0) td.textContent = '平均（' + rows.length + 'セット）';
      else if (c.avg) {
        var vals = rows.map(function (x) { return x.s && x.s[c.avg]; })
          .filter(function (v) { return v != null && isFinite(v); });
        td.textContent = vals.length
          ? fmt(vals.reduce(function (a, b) { return a + b; }, 0) / vals.length, c.d)
          : '—';
      }
      ftr.appendChild(td);
    });
    tfoot.appendChild(ftr); tbl.appendChild(tfoot);
  }


  /* 種目を1つ選んで、その種目の推移を見る。
   * 「平均」と「最大」を同じ単位・同じ軸で並べるので、2本の線の開きが
   * そのままセット内でのばらつき（＝疲労の乗り方）を表す。
   * x軸は日付ではなく日時。同じ日に複数セットあれば別々の点になる。 */
  var TREND_SPECS = {
    velocity: {
      unit: ' m/s', d: 2, axis: '速度 (m/s)', title: '速度',
      sub: 'セット平均と、そのセットで最も速かったレップ（どちらも平均推進速度）',
      series: [{ name: 'セット平均', key: 'meanVelocity' }, { name: '最速レップ', key: 'bestVelocity' }]
    },
    power: {
      unit: ' W', d: 0, axis: 'パワー (W)', title: 'パワー',
      sub: 'セット平均（推進局面の平均）と、セット中の瞬間最大',
      series: [{ name: 'セット平均', key: 'meanPower' }, { name: '最大・瞬間', key: 'peakPower' }]
    },
    velocityLoss: {
      unit: ' %', d: 1, axis: '速度低下率 (%)', title: '速度低下率',
      sub: '最速レップに対する最終レップの落ち幅。追い込み度合いの目安',
      series: [{ name: '速度低下率', key: 'velocityLoss' }]
    },
    e1rm: {
      unit: ' kg', d: 1, axis: '推定1RM (kg)', title: '推定1RM',
      sub: '荷重-速度直線の傾きから各セットを1RM換算した推定値',
      series: [{ name: '推定1RM', key: 'e1rm' }]
    }
  };

  function fmtDateTime(ts, withTime) {
    var d = new Date(ts);
    var s = (d.getMonth() + 1) + '/' + d.getDate();
    if (!withTime) return s;
    return s + ' ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }

  function renderTrend(list, metric, profile, mvt, exSel) {
    var spec = TREND_SPECS[metric] || TREND_SPECS.velocity;
    var st = getComputedStyle(document.documentElement);
    var palette = [st.getPropertyValue('--series-1').trim(), st.getPropertyValue('--series-2').trim()];

    var rows = [];
    if (exSel) {
      list.forEach(function (r) {
        var s = summaryOf(r);
        if (!s) return;
        rows.push({ x: Store.recordAt(r), s: s, rec: r });
      });
      rows.sort(function (a, b) { return a.x - b.x; });
    }

    var series = spec.series.map(function (sp, i) {
      var pts = [];
      rows.forEach(function (row) {
        var v;
        if (sp.key === 'e1rm') {
          if (!profile || !profile.slope || profile.slope >= -1e-6) return;
          v = row.rec.loadKg + (row.s.bestVelocity - mvt) / (-profile.slope);
        } else {
          v = row.s[sp.key];
        }
        if (v == null || !isFinite(v)) return;
        pts.push({ x: row.x, y: v });
      });
      return {
        name: sp.name, color: palette[i % 2], dots: true, points: pts,
        endLabel: pts.length ? fmt(pts[pts.length - 1].y, spec.d) : ''
      };
    }).filter(function (s) { return s.points.length; });

    // 目盛りは実際に記録がある日時から等間隔に選ぶ（丸め数値では日時にならないため）
    var xs = {};
    series.forEach(function (s) { s.points.forEach(function (p) { xs[p.x] = 1; }); });
    var xList = Object.keys(xs).map(Number).sort(function (a, b) { return a - b; });
    var stride = Math.max(1, Math.ceil(xList.length / 5));
    var xTicks = [];
    for (var i = 0; i < xList.length; i += stride) xTicks.push(xList[i]);
    if (xList.length && xTicks[xTicks.length - 1] !== xList[xList.length - 1]) {
      xTicks.push(xList[xList.length - 1]);
    }

    var cfg = {
      title: (exSel || '種目') + ' — ' + spec.title + 'の推移',
      subtitle: exSel ? spec.sub + '（点1つが1セット）' : '上の絞り込みで種目を1つ選んでください',
      emptyText: exSel ? 'この条件では記録がありません' : '種目を1つ選んでください',
      xLabel: '', yLabel: spec.axis, xTicks: xTicks,
      unit: spec.unit, yDecimals: spec.d, includeZero: false, height: 250,
      xFormat: function (v) { return fmtDateTime(v, false); },
      xTableFormat: function (v) { return fmtDateTime(v, true); },
      xLabelName: '日時',
      tipFormat: function (v) { return new Date(v).getFullYear() + '/' + fmtDateTime(v, true); },
      series: exSel ? series : []
    };
    if (!charts.trend) charts.trend = Charts.line($('chartTrend'), cfg);
    else charts.trend.update(cfg);
  }

  function renderLV(exSel, lvPoints, profile, mvt) {
    var pts = lvPoints.map(function (p) {
      return { x: p.load, y: p.velocity, label: p.rec.date + ' ' + p.load + 'kg' };
    });
    var fit = null;
    if (profile) {
      var x0 = Math.min(profile.minLoad, profile.e1rm || profile.minLoad) * 0.95;
      var x1 = Math.max(profile.maxLoad, profile.e1rm || profile.maxLoad) * 1.02;
      fit = {
        x0: x0, y0: profile.intercept + profile.slope * x0,
        x1: x1, y1: profile.intercept + profile.slope * x1
      };
    }
    var cfg = {
      title: '荷重-速度プロファイル' + (exSel ? '（' + exSel + '）' : ''),
      subtitle: exSel ? 'セットごとの最速レップ。直線が回帰、横線が最小速度閾値。'
                      : '種目を1つ選ぶと表示されます',
      emptyText: exSel ? 'この条件では2つ以上の重量のセットが必要です' : '上の絞り込みで種目を1つ選んでください',
      xLabel: '重量 (kg)', yLabel: '平均推進速度 (m/s)', pointLabel: 'セット',
      xDecimals: 0, yDecimals: 2,
      height: 260, points: exSel ? pts : [], fit: fit,
      marks: (exSel && mvt != null) ? [{ y: mvt, label: '最小速度閾値 ' + mvt.toFixed(2) + ' m/s' }] : []
    };
    if (!charts.lv) charts.lv = Charts.scatter($('chartLV'), cfg);
    else charts.lv.update(cfg);

    var note = $('lvNote');
    if (profile && profile.e1rm) {
      note.textContent = '推定1RM ' + profile.e1rm.toFixed(1) + ' kg（決定係数 R² = ' + profile.r2.toFixed(3) +
        '、' + profile.n + 'セット、重量域 ' + profile.minLoad + '〜' + profile.maxLoad + 'kg）。' +
        (profile.r2 < 0.9 ? ' R²が低いため信頼性は限定的です。重量域を広げて再測定してください。' : '') +
        ' 実測1RMの代わりにはなりません。';
    } else if (exSel) {
      note.textContent = '推定1RMには、異なる重量のセットが2つ以上必要です（重量域は広いほど精度が上がります）。';
    } else {
      note.textContent = '';
    }
  }

  function renderMvtGrid() {
    var grid = $('mvtGrid');
    grid.textContent = '';
    var s = Store.settings();
    // 主要種目 → その選手が追加した種目 → 記録に出てくる種目、の順で並べる
    var names = Store.exercisesFor(Store.currentAthleteId())
      .concat(Store.exercises()).concat(Object.keys(s.mvt))
      .filter(function (e, i, a) { return e && a.indexOf(e) === i; });
    names.forEach(function (name) {
      var lab = document.createElement('label');
      lab.className = 'field';
      lab.appendChild(document.createTextNode(name));
      var inp = document.createElement('input');
      inp.type = 'number'; inp.step = '0.01'; inp.min = '0.05'; inp.max = '2';
      inp.value = String(s.mvt[name] != null ? s.mvt[name] : 0.30);
      inp.addEventListener('change', function () {
        var cur = Store.settings();
        cur.mvt[name] = Number(inp.value) || 0.30;
        Store.saveSettings(cur);
        renderHistory();
      });
      lab.appendChild(inp);
      grid.appendChild(lab);
    });
  }

  /* ================= 入出力 ================= */
  function ioSay(msg, cls) {
    $('ioStatus').textContent = msg || '';
    $('ioStatus').className = 'status-line ' + (cls || '');
  }

  // 書き出せるのは本人確認が取れている選手の分だけ
  function exportOwn(kind) {
    var id = Store.currentAthleteId();
    if (!isAuthed(id)) {
      ioSay('先に「解析」タブで選手を選び、PINを入れてください。', 'bad');
      return;
    }
    var a = Store.athleteById(id);
    var n = Store.ownRecords(id).length;
    if (!n) { ioSay(a.name + ' の記録はまだありません。', 'warn'); return; }
    try {
      if (kind === 'csv') Store.exportCSV(id); else Store.exportJSON(id);
      ioSay(a.name + ' の記録 ' + n + '件を書き出しました。', 'ok');
    } catch (err) { ioSay(err.message, 'bad'); }
  }

  $('expCsv').addEventListener('click', function () { exportOwn('csv'); });
  $('expJson').addEventListener('click', function () { exportOwn('json'); });

  // 読み込みは他人の名前で記録を足せてしまうので、管理PINで守る
  $('impBtn').addEventListener('click', function () {
    askAdminPin('JSONファイルを読み込みます。ファイルに入っている選手の記録がこの端末に追加されます。', function (ok) {
      if (ok) $('impInput').click();
    });
  });

  $('impInput').addEventListener('change', function (e) {
    var f = e.target.files && e.target.files[0];
    if (!f) return;
    var fr = new FileReader();
    fr.onload = function () {
      try {
        var n = Store.importJSON(String(fr.result));
        ioSay(n + '件を読み込みました。', 'ok');
        renderAthleteSelect();
        afterAuthChange();
        renderHistory();
      } catch (err) {
        ioSay('読み込めませんでした: ' + err.message, 'bad');
      }
    };
    fr.readAsText(f);
    e.target.value = '';
  });

  $('clearBtn').addEventListener('click', function () {
    askAdminPin('この端末に保存されているすべての記録を削除します。取り消せません。', function (ok) {
      if (!ok) return;
      if (!confirm('本当に削除しますか？　全員分の記録が消えます。')) return;
      Store.clearAll();
      ioSay('記録をすべて削除しました。', 'ok');
      renderHistory();
    });
  });

  /* ================= PWA ================= */
  (function () {
    // Service Worker は https（または localhost）でのみ登録できる。
    // ファイルを直接開いた場合は何もしない。
    if ('serviceWorker' in navigator && location.protocol === 'https:') {
      /* updateViaCache:'none' が要る。これが無いと sw.js 自体がブラウザのHTTPキャッシュから
       * 返され、VERSION を上げても更新が数分〜数十分届かないことがある。 */
      navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(function (reg) {
        reg.update();                                   // 起動のたびに更新を確認する
        setInterval(function () { reg.update(); }, 60 * 60 * 1000);
      }, function () { /* 失敗しても本体は動く */ });
    }
    var deferred = null;
    global.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      deferred = e;
      $('installBtn').hidden = false;
    });
    $('installBtn').addEventListener('click', function () {
      if (!deferred) return;
      deferred.prompt();
      deferred.userChoice.then(function () { deferred = null; $('installBtn').hidden = true; });
    });
    global.addEventListener('appinstalled', function () {
      deferred = null;
      $('installBtn').hidden = true;
    });
  })();

  /* ================= 初期化 ================= */
  $('fDate').value = new Date().toISOString().slice(0, 10);
  $('fTime').value = nowHHMM();
  Store.migrateLegacyAthletes();   // 名簿導入前の記録を名簿に取り込む
  renderAthleteSelect();
  updateAdminStatus();
  // 前回選ばれていた人は、PIN不要（信頼済み・PIN未設定）なら自動で復帰する
  (function () {
    var last = Store.currentAthleteId();
    if (last && Store.athleteById(last) && (!Store.hasPin(last) || Store.isTrusted(last))) {
      authedId = last;
    }
    afterAuthChange();
  })();
  // この端末で誰も登録されていなければ、最初に一度だけ登録してもらう
  if (!Store.roster().length) setTimeout(function () { openAthleteModal(null, { firstRun: true }); }, 400);
  syncModeButtons();
  setSource('file');
  if (camSupported) {
    listCameras();
    if (navigator.mediaDevices.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', listCameras);
    }
  } else {
    $('srcCamBtn').title = 'カメラは https で開いたときだけ使えます';
  }
  // 画面がスリープから戻ったとき、録画中なら画面ロック解除を取り直す
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && S.recording) requestWakeLock();
  });
  updateRunButton();
})(this);
