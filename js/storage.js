/* ============================================================
 * storage.js — セット記録の保存（localStorage）と入出力
 * データは端末内にのみ保存される。チームで共有するときは
 * JSON書き出し → 相手が読み込み、という手動同期を使う。
 * グローバル VBT.Store に公開する。
 * ============================================================ */
(function (global) {
  'use strict';

  var KEY = 'vbt.sessions.v1';
  var SETTINGS_KEY = 'vbt.settings.v1';

  var DEFAULT_MVT = {
    'バックスクワット': 0.30,
    'フロントスクワット': 0.30,
    'ベンチプレス': 0.17,
    'デッドリフト': 0.15,
    'ショルダープレス': 0.19,
    'パワークリーン': 0.70,
    'スナッチ': 0.75
  };

  function uid() {
    return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function load() {
    try {
      var raw = global.localStorage.getItem(KEY);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }

  function save(list) {
    try {
      global.localStorage.setItem(KEY, JSON.stringify(list));
      return true;
    } catch (e) {
      global.alert('保存に失敗しました（保存容量の上限の可能性があります）。JSONで書き出してから古い記録を削除してください。');
      return false;
    }
  }

  function add(record) {
    var list = load();
    record.id = record.id || uid();
    record.createdAt = record.createdAt || new Date().toISOString();
    list.push(record);
    list.sort(cmp);
    save(list);
    return record;
  }

  function remove(id) {
    var list = load().filter(function (r) { return r.id !== id; });
    save(list);
    return list;
  }

  function clearAll() { save([]); }

  function cmp(a, b) {
    if (a.date === b.date) return (a.createdAt || '') < (b.createdAt || '') ? -1 : 1;
    return a.date < b.date ? -1 : 1;
  }

  function exercises() {
    var seen = {};
    load().forEach(function (r) { seen[r.exercise] = 1; });
    return Object.keys(seen).sort();
  }

  function athletes() {
    var seen = {};
    load().forEach(function (r) { if (r.athlete) seen[r.athlete] = 1; });
    return Object.keys(seen).sort();
  }

  /* ---------- 設定（最小速度閾値など） ---------- */
  function settings() {
    try {
      var raw = global.localStorage.getItem(SETTINGS_KEY);
      var s = raw ? JSON.parse(raw) : {};
      s.mvt = Object.assign({}, DEFAULT_MVT, s.mvt || {});
      return s;
    } catch (e) { return { mvt: Object.assign({}, DEFAULT_MVT) }; }
  }

  function saveSettings(s) {
    try { global.localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) { /* noop */ }
  }

  function mvtFor(exercise) {
    var s = settings();
    return s.mvt[exercise] != null ? s.mvt[exercise] : 0.30;
  }

  /* ---------- 書き出し / 読み込み ---------- */
  function download(filename, data, mime) {
    var blob = (data instanceof Blob)
      ? data
      : new Blob([data], { type: (mime || 'text/plain') + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function exportJSON() {
    var payload = { format: 'vbt-sessions', version: 1, exportedAt: new Date().toISOString(), sessions: load() };
    download('vbt-sessions-' + new Date().toISOString().slice(0, 10) + '.json',
      JSON.stringify(payload, null, 2), 'application/json');
  }

  var CSV_COLS = [
    ['date', '日付'], ['athlete', '選手'], ['exercise', '種目'], ['loadKg', '重量kg'],
    ['extraKg', '追加質量kg'], ['repNo', 'レップ'], ['rom', 'ROM_m'], ['duration', '所要秒'],
    ['meanVelocity', '平均速度_m/s'], ['propulsiveVelocity', '平均推進速度_m/s'],
    ['peakVelocity', '最高速度_m/s'], ['meanForce', '平均力_N'], ['peakForce', '最大力_N'],
    ['meanPower', '平均パワー_W'], ['peakPower', '最大パワー_W'],
    ['barPathDeviation', '左右ブレ_m'], ['note', 'メモ']
  ];

  function exportCSV() {
    var rows = [CSV_COLS.map(function (c) { return c[1]; })];
    load().forEach(function (r) {
      (r.reps || []).forEach(function (m, i) {
        rows.push(CSV_COLS.map(function (c) {
          var k = c[0];
          if (k === 'repNo') return i + 1;
          if (k in r) return r[k] == null ? '' : r[k];
          var v = m[k];
          return v == null ? '' : (typeof v === 'number' ? Math.round(v * 10000) / 10000 : v);
        }));
      });
    });
    var csv = rows.map(function (r) {
      return r.map(function (c) {
        var s = String(c);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(',');
    }).join('\r\n');
    // Excel が UTF-8 と判別できるよう BOM を付ける
    download('vbt-reps-' + new Date().toISOString().slice(0, 10) + '.csv', '﻿' + csv, 'text/csv');
  }

  function importJSON(text) {
    var data = JSON.parse(text);
    var incoming = Array.isArray(data) ? data : (data.sessions || []);
    if (!Array.isArray(incoming)) throw new Error('形式が違います');
    var list = load();
    var byId = {};
    list.forEach(function (r) { byId[r.id] = 1; });
    var added = 0;
    incoming.forEach(function (r) {
      if (!r || !r.date || !r.exercise) return;
      if (!r.id || byId[r.id]) r.id = uid();
      byId[r.id] = 1;
      list.push(r);
      added++;
    });
    list.sort(cmp);
    save(list);
    return added;
  }

  global.VBT = global.VBT || {};
  global.VBT.Store = {
    DEFAULT_MVT: DEFAULT_MVT,
    uid: uid, load: load, save: save, add: add, remove: remove, clearAll: clearAll,
    exercises: exercises, athletes: athletes,
    settings: settings, saveSettings: saveSettings, mvtFor: mvtFor,
    exportJSON: exportJSON, exportCSV: exportCSV, importJSON: importJSON, download: download
  };
})(this);
