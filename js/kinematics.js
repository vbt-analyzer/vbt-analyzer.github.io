/* ============================================================
 * kinematics.js — 軌跡から速度・加速度・パワーを算出し、レップを切り出す
 * 依存なし。グローバル VBT.Kin に公開する。
 * ============================================================ */
(function (global) {
  'use strict';

  var G = 9.80665; // m/s^2

  /* ---------- 3x3 / 2x2 線形方程式（部分ピボット付きガウス消去） ---------- */
  function solve(M, b, n) {
    var i, j, k, p, tmp, f;
    var A = [];
    for (i = 0; i < n; i++) { A.push(M[i].slice()); A[i].push(b[i]); }
    for (i = 0; i < n; i++) {
      p = i;
      for (j = i + 1; j < n; j++) if (Math.abs(A[j][i]) > Math.abs(A[p][i])) p = j;
      if (Math.abs(A[p][i]) < 1e-12) return null; // 特異
      tmp = A[i]; A[i] = A[p]; A[p] = tmp;
      for (j = i + 1; j < n; j++) {
        f = A[j][i] / A[i][i];
        for (k = i; k <= n; k++) A[j][k] -= f * A[i][k];
      }
    }
    var x = new Array(n);
    for (i = n - 1; i >= 0; i--) {
      var s = A[i][n];
      for (j = i + 1; j < n; j++) s -= A[i][j] * x[j];
      x[i] = s / A[i][i];
    }
    return x;
  }

  /* ---------- 局所2次フィットによる平滑化＋微分 ----------
   * サンプル間隔が不均一（フレーム落ち・可変フレームレート）でも成立するよう、
   * 各点まわりの時間窓で重み付き最小二乗フィットを行い、係数から速度・加速度を得る。
   *   t : 時刻の配列 [s]（昇順）
   *   y : 位置の配列 [m]
   *   h : 片側の窓幅 [s]
   * 戻り値: [{t, pos, vel, acc}]
   */
  function localFit(t, y, h, minPts) {
    var n = t.length;
    var out = new Array(n);
    if (n === 0) return out;
    if (n < 3) {
      for (var q = 0; q < n; q++) out[q] = { t: t[q], pos: y[q], vel: 0, acc: 0 };
      return out;
    }
    minPts = minPts || 5;

    for (var i = 0; i < n; i++) {
      var a = i, b = i;
      while (a > 0 && t[i] - t[a - 1] <= h) a--;
      while (b < n - 1 && t[b + 1] - t[i] <= h) b++;
      // 点数が足りなければ時間窓を無視して両側に広げる
      while ((b - a + 1) < minPts && (a > 0 || b < n - 1)) {
        if (a === 0) b++;
        else if (b === n - 1) a--;
        else if ((t[i] - t[a - 1]) <= (t[b + 1] - t[i])) a--;
        else b++;
      }

      var m = b - a + 1;
      var hmax = Math.max(t[b] - t[i], t[i] - t[a], 1e-9);
      var S0 = 0, S1 = 0, S2 = 0, S3 = 0, S4 = 0, T0 = 0, T1 = 0, T2 = 0;
      for (var j = a; j <= b; j++) {
        var tau = t[j] - t[i];
        var u = Math.abs(tau) / hmax;
        var w = Math.pow(1 - Math.min(1, u) * Math.min(1, u) * Math.min(1, u), 3);
        if (w < 1e-6) w = 1e-6; // 端点も最低限は効かせる
        var t1 = tau, t2 = tau * tau, t3 = t2 * tau, t4 = t2 * t2;
        S0 += w; S1 += w * t1; S2 += w * t2; S3 += w * t3; S4 += w * t4;
        T0 += w * y[j]; T1 += w * t1 * y[j]; T2 += w * t2 * y[j];
      }

      var c = null;
      if (m >= 4) {
        c = solve([[S0, S1, S2], [S1, S2, S3], [S2, S3, S4]], [T0, T1, T2], 3);
      }
      if (c) {
        out[i] = { t: t[i], pos: c[0], vel: c[1], acc: 2 * c[2] };
      } else {
        var c2 = solve([[S0, S1], [S1, S2]], [T0, T1], 2);
        out[i] = c2
          ? { t: t[i], pos: c2[0], vel: c2[1], acc: 0 }
          : { t: t[i], pos: y[i], vel: 0, acc: 0 };
      }
    }
    return out;
  }

  /* 加速度は位置ノイズの2階微分にあたり、速度よりはるかに荒れる。
   * そこで速度は狭い窓、加速度は広い窓と、別々の窓幅でフィットする。 */
  function smoothDifferentiate(t, y, h, minPts, hAcc) {
    var base = localFit(t, y, h, minPts);
    if (!hAcc || hAcc <= h || base.length < 3) return base;
    var wide = localFit(t, y, hAcc, Math.max(minPts || 5, 7));
    for (var i = 0; i < base.length; i++) base[i].acc = wide[i].acc;
    return base;
  }

  /* ---------- 追跡結果 → 時系列 ----------
   * samples: [{t, x, y, ok}]  x,y は元動画のピクセル座標（yは下向き正）
   * opts: {metersPerPixel, slowFactor, smoothWindow}
   */
  function buildSeries(samples, opts) {
    var mpp = opts.metersPerPixel;
    var slow = opts.slowFactor || 1;
    var t = [], y = [], x = [];
    for (var i = 0; i < samples.length; i++) {
      var s = samples[i];
      if (!s.ok) continue;
      t.push(s.t / slow);
      y.push(-s.y * mpp);  // 画像座標は下向き正 → 上向き正に反転
      x.push(s.x * mpp);
    }
    // 時刻の重複・逆行を除去（seek方式のフォールバックで起こりうる）
    var ct = [], cy = [], cx = [];
    for (var k = 0; k < t.length; k++) {
      if (k > 0 && t[k] - ct[ct.length - 1] < 1e-6) continue;
      ct.push(t[k]); cy.push(y[k]); cx.push(x[k]);
    }
    // 微分の前に外れ値を落とす。1フレームの誤検出は速度・加速度で大きく増幅されるため。
    var my = median3(cy), mx = median3(cx);
    var sw = opts.smoothWindow || 0.08;
    var series = smoothDifferentiate(ct, my, sw, 5, opts.accWindow || sw * 1.8);
    for (var p = 0; p < series.length; p++) series[p].x = mx[p];
    return series;
  }

  /* ---------- レップ（挙上局面）の切り出し ---------- */
  function detectReps(series, opt) {
    opt = opt || {};
    var vThr = opt.velThreshold != null ? opt.velThreshold : 0.15; // m/s
    var minRom = opt.minRom != null ? opt.minRom : 0.12;           // m
    var minDur = opt.minDuration != null ? opt.minDuration : 0.15; // s
    var mergeGap = opt.mergeGap != null ? opt.mergeGap : 0.10;     // s

    var n = series.length, i;
    if (n < 5) return [];

    // 1) vel > 閾値 の連続区間
    var runs = [], cur = null;
    for (i = 0; i < n; i++) {
      if (series[i].vel > vThr) {
        if (!cur) cur = { s: i, e: i }; else cur.e = i;
      } else if (cur) { runs.push(cur); cur = null; }
    }
    if (cur) runs.push(cur);
    if (!runs.length) return [];

    // 2) 短い途切れは同一レップとして結合
    var merged = [runs[0]];
    for (i = 1; i < runs.length; i++) {
      var prev = merged[merged.length - 1];
      if (series[runs[i].s].t - series[prev.e].t <= mergeGap) prev.e = runs[i].e;
      else merged.push(runs[i]);
    }

    // 3) 速度ゼロ交差まで区間を広げる（挙上の真の開始・終了）
    var reps = [];
    for (i = 0; i < merged.length; i++) {
      var s = merged[i].s, e = merged[i].e;
      while (s > 0 && series[s - 1].vel > 0) s--;
      while (e < n - 1 && series[e + 1].vel > 0) e++;
      // 前のレップと重なったら、捨てずに境界をずらす。
      // 切り返しでノイズにより速度が0を割らないと重なるため、
      // 捨ててしまうとレップを数え落とす（休みなく繋げる挙上で起こる）。
      if (reps.length && s <= reps[reps.length - 1].e) s = reps[reps.length - 1].e + 1;
      if (s >= e) continue;
      var rom = series[e].pos - series[s].pos;
      var dur = series[e].t - series[s].t;
      if (rom >= minRom && dur >= minDur) reps.push({ s: s, e: e });
    }
    return reps;
  }

  /* 3点メディアンフィルタ。
   * 1フレームだけ飛んだ誤検出を完全に取り除く（平均と違い、外れ値に引きずられない）。
   * 単調に動いている区間では中央の値がそのまま残るため、軌跡はほぼ変わらない。 */
  function median3(arr) {
    var n = arr.length;
    if (n < 3) return arr.slice();
    var out = new Array(n);
    out[0] = arr[0]; out[n - 1] = arr[n - 1];
    for (var i = 1; i < n - 1; i++) {
      var a = arr[i - 1], b = arr[i], c = arr[i + 1];
      out[i] = a < b ? (b < c ? b : (a < c ? c : a)) : (a < c ? a : (b < c ? c : b));
    }
    return out;
  }

  function smooth3(arr) {
    var n = arr.length, out = new Array(n);
    for (var i = 0; i < n; i++) {
      var a = i > 0 ? i - 1 : 0, b = i < n - 1 ? i + 1 : n - 1;
      var s = 0;
      for (var j = a; j <= b; j++) s += arr[j];
      out[i] = s / (b - a + 1);
    }
    return out;
  }

  function argMax(arr) {
    var k = 0;
    for (var i = 1; i < arr.length; i++) if (arr[i] > arr[k]) k = i;
    return k;
  }

  /* ---------- レップごとの指標 ----------
   * massKg: バーベル重量 + 追加システム質量（体重の一部を足したい場合など）
   */
  function repMetrics(series, rep, massKg) {
    var s = rep.s, e = rep.e, i;
    var n = series.length;

    /* レップの開始・終了は「速度が0を横切る瞬間」。サンプルはその手前と後ろにしか無いので、
     * そのまま端のサンプル時刻を使うと区間が内側に寄り、所要時間が短く＝平均速度が高く出る。
     * フレームレートが低いほど効くため、線形補間で横切る時刻を求める。
     * 横切る点では速度がほぼ0なので、可動域（位置の差）はそのままでよい。 */
    var t0 = series[s].t, t1 = series[e].t;
    if (s > 0) {
      var dv0 = series[s].vel - series[s - 1].vel;
      if (dv0 > 1e-9) {
        var f0 = -series[s - 1].vel / dv0;
        if (f0 > 0 && f0 < 1) t0 = series[s - 1].t + f0 * (series[s].t - series[s - 1].t);
      }
    }
    if (e < n - 1) {
      var dv1 = series[e + 1].vel - series[e].vel;
      if (dv1 < -1e-9) {
        var f1 = -series[e].vel / dv1;
        if (f1 > 0 && f1 < 1) t1 = series[e].t + f1 * (series[e + 1].t - series[e].t);
      }
    }
    var duration = t1 - t0;
    var rom = series[e].pos - series[s].pos;

    var xMin = Infinity, xMax = -Infinity;

    // 推進局面（加速度が -g を下回るまで）。
    // 端では局所フィットの支持が片側しかなく加速度が荒れるため、
    // 極端に短い推進局面は信用せず、後段で平均速度に置き換える。
    var propEnd = e;
    for (i = s; i <= e; i++) {
      if (series[i].acc < -G) { propEnd = Math.max(s, i - 1); break; }
    }
    if (propEnd < s + 1) propEnd = Math.min(e, s + 1);

    var powSum = 0, forceSum = 0, velSum = 0, wsum = 0;
    var propVelSum = 0, propPowSum = 0, propForceSum = 0, propW = 0;
    var vArr = [], fArr = [], pArr = [], tArr = [];

    for (i = s; i <= e; i++) {
      var v = series[i].vel;
      var f = massKg * (series[i].acc + G);
      var p = f * v;
      vArr.push(v); fArr.push(f); pArr.push(p); tArr.push(series[i].t);
      if (series[i].x < xMin) xMin = series[i].x;
      if (series[i].x > xMax) xMax = series[i].x;
      // 台形積分の重み
      var dt = 0;
      if (i > s) dt += (series[i].t - series[i - 1].t) / 2;
      if (i < e) dt += (series[i + 1].t - series[i].t) / 2;
      powSum += p * dt; forceSum += f * dt; velSum += v * dt; wsum += dt;
      if (i <= propEnd) { propVelSum += v * dt; propPowSum += p * dt; propForceSum += f * dt; propW += dt; }
    }

    // ピーク値は単発のノイズを拾いやすいので、3点移動平均から取る。
    // 平均値は積分でならされるため素の値のままでよい。
    var vS = smooth3(vArr), fS = smooth3(fArr), pS = smooth3(pArr);
    var vi = argMax(vS), pi = argMax(pS);
    var peakVel = vS[vi], peakVelT = tArr[vi];
    var peakPow = pS[pi], peakPowT = tArr[pi];
    var peakForce = fS[argMax(fS)];

    var meanVel = duration > 0 ? rom / duration : 0;          // MCV
    // MPV。推進局面が短すぎるときは値が信用できないので平均速度で代用し、
    // 定義上ありえない「最高速度を超えるMPV」も出さない。
    var mpv = (propW >= 0.05) ? propVelSum / propW : meanVel;
    if (mpv > peakVel) mpv = peakVel;

    return {
      startT: t0,
      endT: t1,
      duration: duration,
      rom: rom,
      meanVelocity: meanVel,
      propulsiveVelocity: mpv,
      peakVelocity: peakVel,
      peakVelocityT: peakVelT,
      /* 速度をMPV（推進局面の平均）で見るなら、パワーも同じ区間で平均しないと
       * 区間が食い違う。propulsivePower がその値（平均推進パワー）。
       * 「平均力 × MPV」では平均の積になってしまい、力と速度が相関する以上
       * 積の平均とは一致しないので、時間平均をそのまま取る。 */
      propulsivePower: propW > 0 ? propPowSum / propW : (wsum > 0 ? powSum / wsum : 0),
      propulsiveForce: propW > 0 ? propForceSum / propW : 0,
      propulsiveDuration: propW,
      meanForce: wsum > 0 ? forceSum / wsum : 0,
      peakForce: peakForce,
      meanPower: wsum > 0 ? powSum / wsum : 0,
      peakPower: peakPow,
      peakPowerT: peakPowT,
      barPathDeviation: (isFinite(xMax) && isFinite(xMin)) ? (xMax - xMin) : 0
    };
  }

  /* ---------- 一括処理 ---------- */
  function analyze(samples, opts) {
    var series = buildSeries(samples, opts);
    var reps = detectReps(series, opts);
    var mass = (opts.loadKg || 0) + (opts.extraKg || 0);
    var metrics = reps.map(function (r) { return repMetrics(series, r, mass); });
    return { series: series, reps: reps, metrics: metrics };
  }

  /* ---------- セット内の速度低下率（疲労指標） ---------- */
  function velocityLoss(metrics, key) {
    key = key || 'propulsiveVelocity';
    if (!metrics.length) return 0;
    var best = -Infinity, last = metrics[metrics.length - 1][key];
    for (var i = 0; i < metrics.length; i++) if (metrics[i][key] > best) best = metrics[i][key];
    if (best <= 0) return 0;
    return (best - last) / best * 100;
  }

  /* ---------- セット全体の要約 ----------
   * 平均はすべて「各レップの値の単純平均」。
   * 速度の代表値に MPV（平均推進速度）を使うのは、
   *  ・最大値は単一サンプルなのでノイズに弱く、しかも上振れ方向に偏る
   *  ・MCV（可動域÷時間）は軽い重量ほど減速区間の割合が増えて平均を押し下げ、
   *    その度合いが重量ごとに違うため荷重-速度の関係が歪む
   * という2点を避けるため。高重量域では減速区間がほぼ無くMPVとMCVは一致するので、
   * MPVを使って不利になる場面は無い。
   */
  function setSummary(metrics) {
    var n = metrics.length;
    if (!n) return null;
    function mean(k) {
      return metrics.reduce(function (a, x) { return a + x[k]; }, 0) / n;
    }
    /* 代表レップは MPV で選ぶ。最高速度で選ぶと単一サンプルの当たり外れで
     * 代表が入れ替わってしまうため。
     * なお「最速のレップ」と「最もパワーが出たレップ」は一致するとは限らない。
     * パワー = 質量 ×（加速度 + g）× 速度 なので、MPVがわずかに低くても
     * 立ち上がりの鋭いレップが瞬間パワーで上回ることがある。両方を返す。 */
    var bestIdx = 0, worstIdx = 0, powIdx = 0;
    for (var i = 1; i < n; i++) {
      if (metrics[i].propulsiveVelocity > metrics[bestIdx].propulsiveVelocity) bestIdx = i;
      if (metrics[i].propulsiveVelocity < metrics[worstIdx].propulsiveVelocity) worstIdx = i;
      if (metrics[i].peakPower > metrics[powIdx].peakPower) powIdx = i;
    }
    return {
      reps: n,
      meanVelocity: mean('propulsiveVelocity'),   // セット平均（MPV基準）
      meanConcentric: mean('meanVelocity'),       // 参考: 上昇局面まるごとの平均
      meanPeakVelocity: mean('peakVelocity'),     // 参考: 各レップの最高速度の平均
      bestVelocity: metrics[bestIdx].propulsiveVelocity,
      bestRep: bestIdx + 1,
      best: metrics[bestIdx],            // 最速レップの全指標（瞬間値もここから取る）
      peakPowerRep: powIdx + 1,          // セット中で最もパワーが出たレップ（最速とは限らない）
      lastVelocity: metrics[n - 1].propulsiveVelocity,
      slowestVelocity: metrics[worstIdx].propulsiveVelocity,
      velocityLoss: velocityLoss(metrics),
      meanPower: mean('propulsivePower'),          // 速度(MPV)と同じ区間で揃えた平均
      meanConcentricPower: mean('meanPower'),      // 参考: 挙上局面まるごとの平均
      bestMeanPower: Math.max.apply(null, metrics.map(function (x) { return x.propulsivePower; })),
      peakPower: Math.max.apply(null, metrics.map(function (x) { return x.peakPower; })),
      meanRom: mean('rom'),
      totalTime: metrics[n - 1].endT - metrics[0].startT
    };
  }

  /* ---------- 荷重-速度プロファイルと推定1RM ----------
   * points: [{load, velocity}] （1セット1点、通常はそのセットの最速レップ）
   * mvt: 最小速度閾値 [m/s]
   */
  function loadVelocityProfile(points, mvt) {
    var n = points.length;
    if (n < 2) return null;
    var sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0, i;
    for (i = 0; i < n; i++) {
      sx += points[i].load; sy += points[i].velocity;
      sxx += points[i].load * points[i].load;
      sxy += points[i].load * points[i].velocity;
      syy += points[i].velocity * points[i].velocity;
    }
    var den = n * sxx - sx * sx;
    if (Math.abs(den) < 1e-9) return null;
    var slope = (n * sxy - sx * sy) / den;
    var intercept = (sy - slope * sx) / n;
    var rden = Math.sqrt(den * (n * syy - sy * sy));
    var r2 = rden > 1e-12 ? Math.pow((n * sxy - sx * sy) / rden, 2) : 0;
    var e1rm = slope < -1e-6 ? (mvt - intercept) / slope : null;
    var loads = points.map(function (p) { return p.load; });
    return {
      slope: slope,
      intercept: intercept,
      r2: r2,
      e1rm: e1rm,
      v0: intercept,                       // 無負荷での推定速度
      l0: slope < -1e-6 ? -intercept / slope : null, // 速度ゼロ切片（理論最大荷重）
      minLoad: Math.min.apply(null, loads),
      maxLoad: Math.max.apply(null, loads),
      n: n
    };
  }

  global.VBT = global.VBT || {};
  global.VBT.Kin = {
    G: G,
    localFit: localFit,
    smoothDifferentiate: smoothDifferentiate,
    buildSeries: buildSeries,
    detectReps: detectReps,
    repMetrics: repMetrics,
    analyze: analyze,
    velocityLoss: velocityLoss,
    setSummary: setSummary,
    loadVelocityProfile: loadVelocityProfile
  };
})(this);
