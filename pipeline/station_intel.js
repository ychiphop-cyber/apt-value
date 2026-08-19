'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Station Intelligence V3 빌더
   V3 변경: ① 체감 이동시간(Generalized Travel Time — 대기·환승·진입 반영)
            ② Service Friction (배차·요금·심도 — GTX/공항철도 과대평가 방지)
            ③ 점수 정규화 (상위 1% ≈ 95~100, 평균권 45~65 — §41~43)
            ④ Golden Corridor Index (노선이 관통하는 고가치 벨트 — §35~36)
   원칙: 역·노선 점수 하드코딩 금지 / Station Wealth·주변가격은 콘텐츠 전용(순환참조 금지)
   사용: node pipeline/station_intel.js
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const R = p => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

const NET = R('data/rail_network.json');
const JOBS = R('config/job_centers.json');
const CFG = R('config/valuation-parameters.json').station;
const GEN = CFG.generalized;

const lineById = Object.fromEntries(NET.lines.map(l => [l.id, l]));
const boardCost = l => (l.svc ? l.svc.headway / 2 * GEN.waitWeight + GEN.depthEntryMin[(l.svc.depth || 1) - 1] : 3);

/* ── 그래프: (역,노선) 확장 정점 · 탑승비용은 방향성 간선으로 ── */
const vids = new Map(); const vlist = [];
const vid = (s, l) => { const k = s + '§' + l; if (!vids.has(k)) { vids.set(k, vlist.length); vlist.push({ s, l }); adj.push([]); } return vids.get(k); };
const adj = [];
const addBi = (a, b, w) => { adj[a].push([b, w]); adj[b].push([a, w]); };
const addDir = (a, b, w) => { adj[a].push([b, w]); };

const stationLines = new Map();
const stationExpress = new Map();
for (const line of NET.lines) {
  const st = line.stations;
  for (let i = 0; i < st.length; i++) {
    vid(st[i], line.id);
    if (!stationLines.has(st[i])) stationLines.set(st[i], new Set());
    if (!line.overlay) stationLines.get(st[i]).add(line.name);
    if (line.express) stationExpress.set(st[i], true);
    if (i > 0) addBi(vid(st[i - 1], line.id), vid(st[i], line.id), line.hopMin);
  }
  if (line.loop) addBi(vid(st[st.length - 1], line.id), vid(st[0], line.id), line.hopMin);
}
const byStation = new Map();
for (let i = 0; i < vlist.length; i++) {
  if (!byStation.has(vlist[i].s)) byStation.set(vlist[i].s, []);
  byStation.get(vlist[i].s).push(i);
}
// 환승: 도보 + 갈아탈 노선의 대기·진입 비용 (방향성)
for (const arr of byStation.values())
  for (const a of arr) for (const b of arr) {
    if (a === b) continue;
    addDir(a, b, GEN.transferWalkMin + boardCost(lineById[vlist[b].l]));
  }

function shortestFrom(station) {
  const dist = new Float64Array(vlist.length).fill(Infinity);
  const pq = [];
  for (const v of (byStation.get(station) || [])) {
    dist[v] = boardCost(lineById[vlist[v].l]);   // 출발역 진입·대기
    pq.push([dist[v], v]);
  }
  while (pq.length) {
    let bi = 0;
    for (let i = 1; i < pq.length; i++) if (pq[i][0] < pq[bi][0]) bi = i;
    const [d, u] = pq.splice(bi, 1)[0];
    if (d > dist[u]) continue;
    for (const [v, w] of adj[u]) {
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

/* ── 업무지 체감 이동시간 ── */
const centerDist = {};
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

/* ── 역별 RAW 계산 ── */
const allStations = [...byStation.keys()];
const raws = {};
let jobRawMax = 0;
for (const s of allStations) {
  let raw = 0; const jm = {};
  for (const c of JOBS.centers) {
    const t = Math.min(CFG.maxTravelMin, centerDist[c.id].get(s) ?? CFG.maxTravelMin);
    jm[c.id] = Math.round(t);
    raw += c.importance * Math.exp(-t / CFG.jobDecayTauMin);
  }
  raws[s] = { jobRaw: raw, jm };
  jobRawMax = Math.max(jobRawMax, raw);
}

const rows = {};
for (const s of allStations) {
  const info = NET.stations[s] || {};
  const d = Object.assign({}, NET.defaults.dest, info.d || {});
  const wl = info.w ?? NET.defaults.wealth;
  const { jobRaw, jm } = raws[s];

  const job = clamp(100 * jobRaw / jobRawMax, 0, 100);
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
  const network = clamp(NW.weights.directJobCoverage * coverage * 100 + NW.weights.hubProximity * hubProx + NW.weights.lineCount * lcScore + NW.weights.express * (express ? 100 : 40), 0, 100);
  const econ = clamp(100 * (0.55 * d.emp + 0.45 * d.comm) / 5, 0, 100);
  const wealth = [null, 25, 45, 65, 85, 97][wl] ?? 65;

  const W = CFG.svWeights, WT = CFG.svForTransportReweight;
  rows[s] = {
    svRaw: W.jobAccess * job + W.destination * dest + W.network * network + W.economy * econ,
    svTRaw: WT.jobAccess * job + WT.destination * dest + WT.network * network + WT.economy * econ,
    comps: { job: Math.round(job), gangnam: Math.round(gangnam), dest: Math.round(dest), net: Math.round(network), econ: Math.round(econ) },
    wealth, gangnamMin, jobMinutes: jm, lines: [...(stationLines.get(s) || [])], express,
    c: info.c || null
  };
}

/* ── 정규화: 상위 1% ≈ 95~100, 평균권 45~65 (§41~43) ── */
const curve = CFG.displayCurve.map(p => [p.p, p.s]);
function normalizeBy(key, outKey) {
  const sorted = allStations.slice().sort((a, b) => rows[b][key] - rows[a][key]);
  sorted.forEach((s, i) => {
    const pct = (i + 1) / sorted.length * 100;
    rows[s][outKey] = Math.round(interp(pct, curve) * 10) / 10;
    if (outKey === 'sv') { rows[s].rank = i + 1; rows[s].rankPct = Math.max(1, Math.ceil(pct)); }
  });
}
normalizeBy('svRaw', 'sv');
normalizeBy('svTRaw', 'svT');
for (const s of allStations) { rows[s].svRaw = Math.round(rows[s].svRaw * 10) / 10; rows[s].svTRaw = Math.round(rows[s].svTRaw * 10) / 10; }

/* ── 주변 주택가격 수준 (콘텐츠 전용) ── */
try {
  const DONG = R('data/dong_stations.json');
  const stationDongs = new Map();
  for (const [dong, links] of Object.entries(DONG.map))
    for (const l of links) { if (!stationDongs.has(l.st)) stationDongs.set(l.st, []); stationDongs.get(l.st).push(dong); }
  const dongPrice = new Map();
  const dongRegions = new Map();   // 동명 충돌 감지 (예: 양천 목동 vs 화성 목동)
  const liveDir = path.join(ROOT, 'data', 'live');
  if (fs.existsSync(liveDir)) {
    for (const f of fs.readdirSync(liveDir).filter(x => /^\d{5}\.json$/.test(x))) {
      const sh = JSON.parse(fs.readFileSync(path.join(liveDir, f), 'utf8'));
      for (const cx of Object.values(sh.complexes)) {
        if (!dongRegions.has(cx.dong)) dongRegions.set(cx.dong, new Set());
        dongRegions.get(cx.dong).add(sh.meta.code);
        for (const ar of Object.values(cx.areas)) {
          if (!ar.trades || !ar.trades.length || !ar.m2) continue;
          const clean = ar.trades.filter(t => !t.o);
          if (!clean.length) continue;
          if (!dongPrice.has(cx.dong)) dongPrice.set(cx.dong, []);
          dongPrice.get(cx.dong).push(clean[0].price / ar.m2);
        }
      }
    }
    // 서로 다른 시군구에 같은 동명이 있으면 콘텐츠 지표에서 제외 (잘못된 연결 방지)
    for (const [dg, set] of dongRegions) if (set.size > 1) dongPrice.delete(dg);
  }
  const stationPpm = [];
  for (const [st, dongs] of stationDongs) {
    const vals = dongs.flatMap(dg => dongPrice.get(dg) || []);
    if (vals.length >= 3 && rows[st]) { vals.sort((a, b) => a - b); stationPpm.push([st, vals[Math.floor(vals.length / 2)]]); }
  }
  stationPpm.sort((a, b) => a[1] - b[1]);
  stationPpm.forEach(([st], i) => { rows[st].areaPriceLevel = Math.round((i + 1) / stationPpm.length * 100); });
  console.log(`주변가격 수준: ${stationPpm.length}개 역 (콘텐츠 전용)`);
} catch (e) { console.log('주변가격 생략:', e.message); }

/* ── 노선: Golden Corridor + Friction + Utility (§35~42) ── */
const CR = CFG.corridor, FR = CFG.friction, GV = CFG.goldenV3;
const lineGroups = new Map();
for (const line of NET.lines) {
  const nm = line.name.replace(' 급행', '');
  if (!lineGroups.has(nm)) lineGroups.set(nm, { color: line.color, st: new Set(), entries: [] });
  const g = lineGroups.get(nm);
  line.stations.forEach(s => g.st.add(s));
  g.entries.push(line);
}
const linesOut = [];
for (const [nm, g] of lineGroups) {
  const main = g.entries.filter(e => !e.overlay).sort((a, b) => b.stations.length - a.stations.length)[0];
  const seq = main.stations;
  const metric = s => CR.svWeight * rows[s].sv + CR.wealthWeight * rows[s].wealth;
  // Golden Corridor: 연속 구간 최고 가치 (순환선은 wrap 허용)
  const arr = main.loop ? seq.concat(seq) : seq;
  const wlen = Math.max(CR.windowMinLen, Math.ceil(seq.length * CR.windowShare));
  let best = { avg: -1, from: 0 };
  for (let i = 0; i + wlen <= arr.length && i < seq.length; i++) {
    const win = arr.slice(i, i + wlen);
    const avg = win.reduce((a, s) => a + metric(s), 0) / wlen;
    if (avg > best.avg) best = { avg, from: i };
  }
  const corridorStations = arr.slice(best.from, best.from + wlen);
  const svs = [...g.st].map(s => rows[s].sv);
  const lineAvg = svs.reduce((a, b) => a + b, 0) / svs.length;
  const headway = Math.min(...g.entries.filter(e => e.svc).map(e => e.svc.headway));
  const fare = Math.max(...g.entries.map(e => e.svc ? e.svc.fare : 0));
  const depth = Math.max(...g.entries.map(e => e.svc ? e.svc.depth : 1));
  const friction = clamp(FR.base - Math.max(0, headway - FR.headwayRef) * FR.perHeadwayMin - fare * FR.perFareStep - (depth - 1) * FR.perDepthStep, FR.floor, 100);
  const goldenRaw = GV.corridorAvg * best.avg + GV.lineAvg * lineAvg + GV.friction * friction;
  const util = Math.round([...g.st].reduce((a, s) => a + rows[s].comps.net, 0) / g.st.size);
  const sd = Math.sqrt(svs.reduce((a, b) => a + (b - lineAvg) ** 2, 0) / svs.length);
  linesOut.push({
    name: nm, color: g.color, goldenRaw, corridor: { stations: corridorStations, avg: Math.round(best.avg) },
    avg: Math.round(lineAvg * 10) / 10, util, friction: Math.round(friction),
    svc: { headway, fare, depth }, stdev: Math.round(sd * 10) / 10, count: g.st.size,
    profile: seq.map(s => ({ n: s, sv: Math.round(rows[s].sv) })),
    topStations: [...g.st].sort((a, b) => rows[b].sv - rows[a].sv).slice(0, 5).map(s => ({ n: s, sv: Math.round(rows[s].sv) })),
    centersOnLine: JOBS.centers.filter(c => c.stations.some(cs => g.st.has(cs))).map(c => c.name)
  });
}
/* 표시 점수 정규화: 최상위 노선 ≈ 95~100 (§41~42) */
const gMin = Math.min(...linesOut.map(l => l.goldenRaw)), gMax = Math.max(...linesOut.map(l => l.goldenRaw));
for (const l of linesOut) {
  l.golden = Math.round(GV.displayMin + (l.goldenRaw - gMin) / (gMax - gMin) * (GV.displayMax - GV.displayMin));
  l.goldenRaw = Math.round(l.goldenRaw * 10) / 10;
}
linesOut.sort((a, b) => b.golden - a.golden);

/* ── 저장 ── */
const meta = {
  updatedAt: NET.meta.asOf, version: 3,
  method: '체감 이동시간(대기·환승·진입 반영) 그래프 + config 가중치 — 역·노선 점수 하드코딩 없음. 점수는 백분위 정규화(상위 1%≈95+)',
  status: 'ESTIMATED', stationCount: allStations.length,
  note: 'Station Wealth·areaPriceLevel은 콘텐츠 전용 — 아파트 가치평가에 사용하지 않는다'
};
fs.writeFileSync(path.join(ROOT, 'data', 'station_intelligence.json'), JSON.stringify({ meta, stations: rows }));
fs.writeFileSync(path.join(ROOT, 'data', 'line_intelligence.json'), JSON.stringify({ meta, lines: linesOut }));

const sorted = allStations.slice().sort((a, b) => rows[b].sv - rows[a].sv);
console.log(`역 ${allStations.length}개 · 노선 ${linesOut.length}개 (V3)`);
console.log('TOP 12:', sorted.slice(0, 12).map(s => `${s} ${Math.round(rows[s].sv)}`).join(' / '));
console.log('황금노선(Corridor):', linesOut.slice(0, 8).map(l => `${l.name} ${l.golden}`).join(' / '));
for (const l of linesOut.filter(x => ['공항철도', 'GTX-A', '3호선', '9호선', '2호선', '신분당선'].includes(x.name)))
  console.log(`  ${l.name}: corridor ${l.corridor.avg}(${l.corridor.stations.slice(0, 4).join('·')}…) avg ${l.avg} friction ${l.friction} → ${l.golden}`);
const probe = ['신사', '녹번', '강남', '고속터미널', '잠실', '여의도', '서울역', '동탄', '고덕', '대치', '수내', '평촌', '중계', '압구정', '성수'];
for (const s of probe) if (rows[s]) console.log(`  ${s}: SV ${rows[s].sv} (raw ${rows[s].svRaw}) 강남 ${rows[s].gangnamMin}분 rank ${rows[s].rank}`);
