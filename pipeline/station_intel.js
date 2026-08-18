'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Station Intelligence 빌더
   rail_network.json(그래프) + job_centers.json + config →
     data/station_intelligence.json (역별 Station Value·컴포넌트·순위)
     data/line_intelligence.json    (노선별 황금노선 지수)

   원칙:
   - 역별 점수 하드코딩 금지 — 모든 값은 그래프 이동시간과 config 가중치로 계산
   - Station Value(가격모델 사용 가능)와 Station Wealth(콘텐츠 전용)를 분리
   - 주변 주택가격(areaPriceLevel)은 콘텐츠 전용 — Station Value에 넣지 않는다 (순환참조 금지)
   사용: node pipeline/station_intel.js
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const R = p => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

const NET = R('data/rail_network.json');
const JOBS = R('config/job_centers.json');
const CFG = R('config/valuation-parameters.json').station;

/* ── 그래프 구축: (역,노선구간) 확장 정점 + 환승 간선 ── */
const vids = new Map(); const vlist = [];
const vid = (s, l) => { const k = s + '§' + l; if (!vids.has(k)) { vids.set(k, vlist.length); vlist.push({ s, l }); } return vids.get(k); };
const adj = [];
const addEdge = (a, b, w) => { (adj[a] = adj[a] || []).push([b, w]); (adj[b] = adj[b] || []).push([a, w]); };

const stationLines = new Map();   // 역 → 노선 표시명 집합
const stationExpress = new Map();
for (const line of NET.lines) {
  const st = line.stations;
  for (let i = 0; i < st.length; i++) {
    const v = vid(st[i], line.id);
    adj[v] = adj[v] || [];
    const nm = line.name;
    if (!stationLines.has(st[i])) stationLines.set(st[i], new Set());
    if (!line.overlay) stationLines.get(st[i]).add(nm);
    if (line.express) stationExpress.set(st[i], true);
    if (i > 0) addEdge(vid(st[i - 1], line.id), v, line.hopMin);
  }
  if (line.loop) addEdge(vid(st[st.length - 1], line.id), vid(st[0], line.id), line.hopMin);
}
// 같은 역의 노선구간 간 환승 간선
const byStation = new Map();
for (let i = 0; i < vlist.length; i++) {
  if (!byStation.has(vlist[i].s)) byStation.set(vlist[i].s, []);
  byStation.get(vlist[i].s).push(i);
}
for (const arr of byStation.values())
  for (let i = 0; i < arr.length; i++)
    for (let j = i + 1; j < arr.length; j++) addEdge(arr[i], arr[j], CFG.transferPenaltyMin);

/* ── 다익스트라 (출발역 → 전 역 최단분) ── */
function shortestFrom(station) {
  const dist = new Float64Array(vlist.length).fill(Infinity);
  const starts = byStation.get(station) || [];
  const pq = [];   // [d, v]
  for (const v of starts) { dist[v] = 0; pq.push([0, v]); }
  while (pq.length) {
    let bi = 0;
    for (let i = 1; i < pq.length; i++) if (pq[i][0] < pq[bi][0]) bi = i;
    const [d, u] = pq.splice(bi, 1)[0];
    if (d > dist[u]) continue;
    for (const [v, w] of (adj[u] || [])) {
      const nd = d + w;
      if (nd < dist[v] - 1e-9) { dist[v] = nd; pq.push([nd, v]); }
    }
  }
  const out = new Map();
  for (let i = 0; i < vlist.length; i++) {
    const s = vlist[i].s;
    const cur = out.get(s);
    if (cur === undefined || dist[i] < cur) out.set(s, dist[i]);
  }
  return out;
}

const interp = (x, pts) => {
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) if (x <= pts[i][0]) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
    return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
  }
  return pts[pts.length - 1][1];
};
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

/* ── 업무지별 최단시간: 각 업무지 도착역들에서 역방향 다익스트라 ── */
const centerDist = {};   // centerId → Map(station → min)
for (const c of JOBS.centers) {
  let best = null;
  for (const cs of c.stations) {
    if (!byStation.has(cs)) continue;
    const m = shortestFrom(cs);
    if (!best) best = m;
    else for (const [k, v] of m) if (v < best.get(k)) best.set(k, v);
  }
  centerDist[c.id] = best || new Map();
}
const totalImp = JOBS.centers.reduce((s, c) => s + c.importance, 0);

/* ── 역별 계산 ── */
const allStations = [...byStation.keys()];
const rows = {};
let jobRawMax = 0;
const rawJob = {};
for (const s of allStations) {
  let raw = 0;
  const jm = {};
  for (const c of JOBS.centers) {
    const t = Math.min(CFG.maxTravelMin, centerDist[c.id].get(s) ?? CFG.maxTravelMin);
    jm[c.id] = Math.round(t);
    raw += c.importance * Math.exp(-t / CFG.jobDecayTauMin);
  }
  rawJob[s] = { raw, jm };
  jobRawMax = Math.max(jobRawMax, raw);
}

for (const s of allStations) {
  const info = NET.stations[s] || {};
  const d = Object.assign({}, NET.defaults.dest, info.d || {});
  const wl = info.w ?? NET.defaults.wealth;
  const { raw, jm } = rawJob[s];

  const job = clamp(100 * raw / jobRawMax, 0, 100);
  const gangnamMin = Math.min(...JOBS.centers.filter(c => c.gangnamCore).map(c => jm[c.id] ?? 999));
  const gangnam = interp(gangnamMin, CFG.gangnamCurve.map(p => [p.min, p.score]));

  const DW = CFG.destWeights;
  const dest = clamp(100 * (DW.emp * d.emp + DW.comm * d.comm + DW.cult * d.cult + DW.med * d.med + DW.tour * d.tour) / 5, 0, 100);

  const NW = CFG.network;
  let covered = 0, wsum = 0;
  for (const c of JOBS.centers) { wsum += c.importance * jm[c.id]; if (jm[c.id] <= NW.directReachMin) covered += c.importance; }
  const coverage = covered / totalImp;
  const meanMin = wsum / totalImp;
  const hubProx = clamp(100 * Math.exp(-Math.max(0, meanMin - 10) / NW.hubProximityTau), 0, 100);
  const lineCount = (stationLines.get(s) || new Set()).size;
  const lcScore = NW.lineCountScore[String(Math.min(4, Math.max(1, lineCount)))] ?? 55;
  const express = !!stationExpress.get(s);
  const network = clamp(
    NW.weights.directJobCoverage * coverage * 100 + NW.weights.hubProximity * hubProx +
    NW.weights.lineCount * lcScore + NW.weights.express * (express ? 100 : 40), 0, 100);

  const econ = clamp(100 * (0.55 * d.emp + 0.45 * d.comm) / 5, 0, 100);
  const wealth = [null, 25, 45, 65, 85, 97][wl] ?? 65;

  const W = CFG.svWeights;
  const sv = clamp(W.jobAccess * job + W.destination * dest + W.network * network + W.economy * econ, 0, 100);
  const WT = CFG.svForTransportReweight;
  const svT = clamp(WT.jobAccess * job + WT.destination * dest + WT.network * network + WT.economy * econ, 0, 100);

  rows[s] = {
    sv: Math.round(sv * 10) / 10, svT: Math.round(svT * 10) / 10,
    comps: { job: Math.round(job), gangnam: Math.round(gangnam), dest: Math.round(dest), net: Math.round(network), econ: Math.round(econ) },
    wealth, gangnamMin, jobMinutes: jm, lines: [...(stationLines.get(s) || [])], express,
    c: info.c || null
  };
}

/* 순위·백분위 */
const sorted = allStations.slice().sort((a, b) => rows[b].sv - rows[a].sv);
sorted.forEach((s, i) => {
  rows[s].rank = i + 1;
  rows[s].rankPct = Math.max(1, Math.ceil((i + 1) / sorted.length * 100));
});

/* ── 주변 주택가격 수준 (콘텐츠 전용 — SV에 사용 금지) ── */
try {
  const DONG = R('data/dong_stations.json');
  const stationDongs = new Map();
  for (const [dong, links] of Object.entries(DONG.map)) {
    for (const l of links) {
      if (!stationDongs.has(l.st)) stationDongs.set(l.st, []);
      stationDongs.get(l.st).push(dong);
    }
  }
  const dongPrice = new Map();   // dong → [₩/㎡...]
  const liveDir = path.join(ROOT, 'data', 'live');
  if (fs.existsSync(liveDir)) {
    for (const f of fs.readdirSync(liveDir).filter(x => /^\d{5}\.json$/.test(x))) {
      const sh = JSON.parse(fs.readFileSync(path.join(liveDir, f), 'utf8'));
      for (const cx of Object.values(sh.complexes)) {
        for (const ar of Object.values(cx.areas)) {
          if (!ar.trades || !ar.trades.length || !ar.m2) continue;
          const ppm = ar.trades[0].price / ar.m2;   // 억/㎡
          if (!dongPrice.has(cx.dong)) dongPrice.set(cx.dong, []);
          dongPrice.get(cx.dong).push(ppm);
        }
      }
    }
  }
  const stationPpm = [];
  for (const [st, dongs] of stationDongs) {
    const vals = dongs.flatMap(d => dongPrice.get(d) || []);
    if (vals.length >= 3 && rows[st]) {
      vals.sort((a, b) => a - b);
      stationPpm.push([st, vals[Math.floor(vals.length / 2)]]);
    }
  }
  stationPpm.sort((a, b) => a[1] - b[1]);
  stationPpm.forEach(([st, v], i) => { rows[st].areaPriceLevel = Math.round((i + 1) / stationPpm.length * 100); });
  console.log(`주변가격 수준 산출: ${stationPpm.length}개 역 (콘텐츠 전용)`);
} catch (e) { console.log('주변가격 수준 생략:', e.message); }

/* ── 노선 집계 (황금노선 지수) ── */
const lineGroups = new Map();
for (const line of NET.lines) {
  const nm = line.name.replace(' 급행', '');
  if (!lineGroups.has(nm)) lineGroups.set(nm, { color: line.color, st: new Set() });
  line.stations.forEach(s => lineGroups.get(nm).st.add(s));
}
const lines = [];
for (const [nm, g] of lineGroups) {
  const svs = [...g.st].map(s => rows[s].sv).sort((a, b) => b - a);
  const avg = svs.reduce((a, b) => a + b, 0) / svs.length;
  const topN = Math.max(1, Math.round(svs.length * 0.2));
  const top20 = svs.slice(0, topN).reduce((a, b) => a + b, 0) / topN;
  const util = [...g.st].map(s => rows[s].comps.net).reduce((a, b) => a + b, 0) / g.st.size;
  const L = CFG.lineScore;
  const golden = Math.round(L.avgAll * avg + L.top20 * top20 + L.networkUtility * util);
  const mean = avg, sd = Math.sqrt(svs.reduce((a, b) => a + (b - mean) ** 2, 0) / svs.length);
  const topStations = [...g.st].sort((a, b) => rows[b].sv - rows[a].sv).slice(0, 5).map(s => ({ n: s, sv: rows[s].sv }));
  const centersOnLine = JOBS.centers.filter(c => c.stations.some(cs => g.st.has(cs))).map(c => c.name);
  lines.push({ name: nm, color: g.color, golden, avg: Math.round(avg * 10) / 10, top20: Math.round(top20 * 10) / 10, util: Math.round(util), stdev: Math.round(sd * 10) / 10, count: g.st.size, topStations, centersOnLine });
}
lines.sort((a, b) => b.golden - a.golden);

/* ── 저장 ── */
const meta = {
  updatedAt: NET.meta.asOf, method: '그래프 최단시간(환승 페널티) + config 가중치 — 역별 점수 하드코딩 없음',
  status: 'ESTIMATED', stationCount: allStations.length,
  note: 'Station Wealth·areaPriceLevel은 콘텐츠 전용 — 아파트 적정가치 계산에 사용하지 않는다'
};
fs.writeFileSync(path.join(ROOT, 'data', 'station_intelligence.json'), JSON.stringify({ meta, stations: rows }));
fs.writeFileSync(path.join(ROOT, 'data', 'line_intelligence.json'), JSON.stringify({ meta, lines }));

/* 요약 출력 */
console.log(`역 ${allStations.length}개 · 노선 ${lines.length}개 계산 완료`);
console.log('TOP 12:', sorted.slice(0, 12).map(s => `${s} ${rows[s].sv}`).join(' / '));
console.log('황금노선:', lines.slice(0, 6).map(l => `${l.name} ${l.golden}`).join(' / '));
const probe = ['신사', '녹번', '압구정', '고속터미널', '잠실', '여의도', '서울역', '성수', '판교', '광화문', '고덕', '목동', '대치', '수내', '정자', '평촌', '동탄', '중계'];
for (const s of probe) if (rows[s]) console.log(`  ${s}: SV ${rows[s].sv} (직주 ${rows[s].comps.job} 목적지 ${rows[s].comps.dest} 네트워크 ${rows[s].comps.net} 경제 ${rows[s].comps.econ}) 강남 ${rows[s].gangnamMin}분 wealth ${rows[s].wealth}`);
