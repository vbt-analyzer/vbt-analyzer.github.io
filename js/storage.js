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
  var ROSTER_KEY = 'vbt.roster.v1';
  var CURRENT_KEY = 'vbt.currentAthlete.v1';

  var GRADES = ['1年', '2年', '3年', '4年', 'その他'];
  var SEXES = ['男子', '女子', '回答しない'];

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

  /* ============================================================
   * 選手名簿
   * 端末（ブラウザ）ごとに名簿を持つ。共用のタブレット等で複数人が使う想定で、
   * 初回だけ本人が名前・学年・性別を登録し、以後はプルダウンから選ぶ。
   * ============================================================ */
  function roster() {
    try {
      var raw = global.localStorage.getItem(ROSTER_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }

  function saveRoster(list) {
    try { global.localStorage.setItem(ROSTER_KEY, JSON.stringify(list)); return true; }
    catch (e) { global.alert('選手情報の保存に失敗しました（保存容量の上限の可能性があります）。'); return false; }
  }

  function athleteById(id) {
    var list = roster();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function athleteByName(name) {
    var list = roster(), n = String(name || '').trim();
    for (var i = 0; i < list.length; i++) if (list[i].name === n) return list[i];
    return null;
  }

  function addAthlete(a) {
    var name = String(a.name || '').trim();
    if (!name) throw new Error('名前を入力してください');
    var existing = athleteByName(name);
    if (existing) throw new Error('「' + name + '」はすでに登録されています');
    var list = roster();
    var rec = {
      id: 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: name,
      grade: a.grade || '',
      sex: a.sex || '',
      createdAt: new Date().toISOString()
    };
    list.push(rec);
    saveRoster(list);
    return rec;
  }

  function updateAthlete(id, patch) {
    var list = roster();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id !== id) continue;
      var name = patch.name != null ? String(patch.name).trim() : list[i].name;
      if (!name) throw new Error('名前を入力してください');
      // 改名で他の登録者と衝突しないか確認する
      for (var j = 0; j < list.length; j++) {
        if (j !== i && list[j].name === name) throw new Error('「' + name + '」はすでに登録されています');
      }
      list[i].name = name;
      if (patch.grade != null) list[i].grade = patch.grade;
      if (patch.sex != null) list[i].sex = patch.sex;
      saveRoster(list);
      renameInSessions(id, name);
      return list[i];
    }
    return null;
  }

  function removeAthlete(id) {
    saveRoster(roster().filter(function (a) { return a.id !== id; }));
    if (currentAthleteId() === id) setCurrentAthlete('');
  }

  // 記録側に控えている名前も追随させる（書き出したCSVで名前が食い違わないように）
  function renameInSessions(id, name) {
    var list = load(), touched = false;
    list.forEach(function (r) {
      if (r.athleteId === id && r.athlete !== name) { r.athlete = name; touched = true; }
    });
    if (touched) save(list);
  }

  function currentAthleteId() {
    try { return global.localStorage.getItem(CURRENT_KEY) || ''; } catch (e) { return ''; }
  }

  function setCurrentAthlete(id) {
    try {
      if (id) global.localStorage.setItem(CURRENT_KEY, id);
      else global.localStorage.removeItem(CURRENT_KEY);
    } catch (e) { /* noop */ }
  }

  function currentAthlete() {
    var a = athleteById(currentAthleteId());
    return a || null;
  }

  function athleteLabel(a) {
    if (!a) return '';
    var sub = [a.grade, a.sex].filter(function (x) { return x && x !== '回答しない'; }).join('・');
    return sub ? a.name + '（' + sub + '）' : a.name;
  }

  /* 名簿導入前の記録（athlete が名前の文字列だけ）を名簿に取り込む。
   * 起動時に一度だけ走らせれば、以後は athleteId で紐づく。 */
  function migrateLegacyAthletes() {
    var list = load(), touched = false;
    list.forEach(function (r) {
      if (r.athleteId || !r.athlete) return;
      var a = athleteByName(r.athlete);
      if (!a) {
        try { a = addAthlete({ name: r.athlete, grade: '', sex: '' }); }
        catch (e) { a = athleteByName(r.athlete); }
      }
      if (a) { r.athleteId = a.id; touched = true; }
    });
    if (touched) save(list);
    return touched;
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
    var payload = {
      format: 'vbt-sessions', version: 2, exportedAt: new Date().toISOString(),
      roster: roster(), sessions: load()
    };
    download('vbt-sessions-' + new Date().toISOString().slice(0, 10) + '.json',
      JSON.stringify(payload, null, 2), 'application/json');
  }

  var CSV_COLS = [
    ['date', '日付'], ['athlete', '選手'], ['grade', '学年'], ['sex', '性別'],
    ['exercise', '種目'], ['loadKg', '重量kg'],
    ['extraKg', '追加質量kg'], ['repNo', 'レップ'], ['rom', 'ROM_m'], ['duration', '所要秒'],
    ['meanVelocity', '平均速度_m/s'], ['propulsiveVelocity', '平均推進速度_m/s'],
    ['peakVelocity', '最高速度_m/s'], ['meanForce', '平均力_N'], ['peakForce', '最大力_N'],
    ['meanPower', '平均パワー_W'], ['peakPower', '最大パワー_W'],
    ['barPathDeviation', '左右ブレ_m'], ['note', 'メモ']
  ];

  function exportCSV() {
    var rows = [CSV_COLS.map(function (c) { return c[1]; })];
    load().forEach(function (r) {
      var prof = athleteById(r.athleteId) || {};
      (r.reps || []).forEach(function (m, i) {
        rows.push(CSV_COLS.map(function (c) {
          var k = c[0];
          if (k === 'repNo') return i + 1;
          if (k === 'grade') return prof.grade || '';
          if (k === 'sex') return prof.sex || '';
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

    /* 名簿を先に取り込む。同じ名前の人はこの端末の既存登録に寄せ、
     * 取り込む記録の athleteId を差し替える（IDは端末ごとに別々に振られるため）。 */
    var idMap = {};
    (data.roster || []).forEach(function (a) {
      if (!a || !a.name) return;
      var mine = athleteByName(a.name);
      if (!mine) {
        try { mine = addAthlete({ name: a.name, grade: a.grade, sex: a.sex }); }
        catch (e) { mine = athleteByName(a.name); }
      }
      if (mine) idMap[a.id] = mine.id;
    });

    var list = load();
    var byId = {};
    list.forEach(function (r) { byId[r.id] = 1; });
    var added = 0;
    incoming.forEach(function (r) {
      if (!r || !r.date || !r.exercise) return;
      if (!r.id || byId[r.id]) r.id = uid();
      byId[r.id] = 1;
      if (r.athleteId && idMap[r.athleteId]) r.athleteId = idMap[r.athleteId];
      else if (!r.athleteId && r.athlete) {
        var a = athleteByName(r.athlete);
        if (!a) { try { a = addAthlete({ name: r.athlete }); } catch (e) { a = athleteByName(r.athlete); } }
        if (a) r.athleteId = a.id;
      }
      list.push(r);
      added++;
    });
    list.sort(cmp);
    save(list);
    return added;
  }

  global.VBT = global.VBT || {};
  global.VBT.Store = {
    DEFAULT_MVT: DEFAULT_MVT, GRADES: GRADES, SEXES: SEXES,
    uid: uid, load: load, save: save, add: add, remove: remove, clearAll: clearAll,
    exercises: exercises, athletes: athletes,
    roster: roster, addAthlete: addAthlete, updateAthlete: updateAthlete,
    removeAthlete: removeAthlete, athleteById: athleteById, athleteByName: athleteByName,
    currentAthleteId: currentAthleteId, setCurrentAthlete: setCurrentAthlete,
    currentAthlete: currentAthlete, athleteLabel: athleteLabel,
    migrateLegacyAthletes: migrateLegacyAthletes,
    settings: settings, saveSettings: saveSettings, mvtFor: mvtFor,
    exportJSON: exportJSON, exportCSV: exportCSV, importJSON: importJSON, download: download
  };
})(this);
