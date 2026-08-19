'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Station Intelligence V4 빌더
   V4 변경: 역 가치를 "업무 접근성 중심"에서 "생활권 가치 포함" 4축으로 재정의
     ① 교통·네트워크 30% — 강남·도심·여의도 체감 이동시간, 환승·급행·배차(마찰)
     ② 역세권 경제력 35% — 역 생활권(법정동) 실거래 ㎡가 중앙값 백분위 (winsorize),
        부족 시 수동 wealth 폴백 — 소득·자산 데이터를 추정 생성하지 않는다
     ③ 교육·주거 생활권 20% — 학원가 허브 접근(거리감쇠) + 아파트 단지 밀집도
     ④ 업무·도시 중심성 15% — 역 주변 업무·상업·문화 시설(목적지가치)
   각 축은 전 역 백분위 정규화(0~100) 후 가중합 — 한 변수가 지배하지 못한다.
   가치평가용 svT는 경제력·교육 축을 축소(axesForValuation) — 아파트 자체의
   시장기준가(실거래)·교육점수와의 중복 계상(순환) 방지.
   원칙: 역·노선 점수 하드코딩 금지 / 모든 계수는 config에서만 관리
   사용: node pipeline/station_intel.js
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const R = p => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

const NET = R('data/rail_network.json');
const JOBS = R('config/job_centers.json');
const HUBS = R('config/education_hubs.json');
const CFG = R('config/valuation-parameters.json').station;
const GEN = CFG.generalized;
const V4 = CFG.v4;

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
const stationEntries = new Map();   // 역 → 소속 노선 엔트리들 (마찰 계산용, 급행 overlay 포함)
for (const line of NET.lines) {
  const st = line.stations;
  for (let i = 0; i < st.length; i++) {
    vid(st[i], line.id);
    if (!stationLines.has(st[i])) stationLines.set(st[i], new Set());
    if (!line.overlay) stationLines.get(st[i]).add(line.name);
    if (line.express) stationExpress.set(st[i], true);
    if (!stationEntries.has(st[i])) stationEntries.set(st[i], []);
    stationEntries.get(st[i]).push(line);
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
const havKm = (a, b) => {
  const d2r = Math.PI / 180;
  const dLa = (b[0] - a[0]) * d2r, dLo = (b[1] - a[1]) * d2r;
  const x = Math.sin(dLa / 2) ** 2 + Math.cos(a[0] * d2r) * Math.cos(b[0] * d2r) * Math.sin(dLo / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(x));
};

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

/* ── 역 생활권 데이터: 실거래 ㎡가 · 단지 밀집도 (dong_stations 링크 기반)
   키 체계는 ui.js dongLinkFor()와 동일: "시군구코드:동" 오버라이드가 있으면 그 지역의
   동은 스코프 키로만 매칭되고, 일반 "동" 키는 나머지 지역의 동을 뜻한다.
   스코프 제외 후에도 2개 이상 지역에 같은 동명이 남으면 제외(오연결 방지). ── */
const stationDongs = new Map();   // 역 → dong_stations 키 집합 (스코프 키 포함)
const dongOverrides = new Map();  // 동 → 스코프 오버라이드가 존재하는 지역코드 집합
try {
  const DONG = R('data/dong_stations.json');
  for (const [key, links] of Object.entries(DONG.map)) {
    const m = key.match(/^(\d{5}):(.+)$/);
    if (m) { if (!dongOverrides.has(m[2])) dongOverrides.set(m[2], new Set()); dongOverrides.get(m[2]).add(m[1]); }
    for (const l of links) { if (!stationDongs.has(l.st)) stationDongs.set(l.st, new Set()); stationDongs.get(l.st).add(key); }
  }
} catch (e) { console.log('dong_stations 없음:', e.message); }

const dongPrice = new Map();   // 키("동" 또는 "코드:동") → [㎡당 최근가...]
const dongCplx = new Map();    // 키 → 단지 수
{
  const plainRegions = new Map();   // 일반 키의 동명 충돌 감지 (스코프 지역 제외 후)
  const liveDir = path.join(ROOT, 'data', 'live');
  if (fs.existsSync(liveDir)) {
    for (const f of fs.readdirSync(liveDir).filter(x => /^\d{5}\.json$/.test(x))) {
      const sh = JSON.parse(fs.readFileSync(path.join(liveDir, f), 'utf8'));
      const code = sh.meta.code;
      for (const cx of Object.values(sh.complexes)) {
        const scoped = (dongOverrides.get(cx.dong) || new Set()).has(code);
        const key = scoped ? `${code}:${cx.dong}` : cx.dong;
        if (!scoped) {
          if (!plainRegions.has(cx.dong)) plainRegions.set(cx.dong, new Set());
          plainRegions.get(cx.dong).add(code);
        }
        dongCplx.set(key, (dongCplx.get(key) || 0) + 1);
        for (const ar of Object.values(cx.areas)) {
          if (!ar.trades || !ar.trades.length || !ar.m2) continue;
          const clean = ar.trades.filter(t => !t.o);
          if (!clean.length) continue;
          if (!dongPrice.has(key)) dongPrice.set(key, []);
          dongPrice.get(key).push(clean[0].price / ar.m2);
        }
      }
    }
    for (const [dg, set] of plainRegions) if (set.size > 1) { dongPrice.delete(dg); dongCplx.delete(dg); }
  }
}

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

/* 역 생활권 ㎡가 중앙값 → winsorize (극단값 제어) */
const stationPpm = new Map();
for (const [st, dongs] of stationDongs) {
  const vals = [...dongs].flatMap(dg => dongPrice.get(dg) || []);
  if (vals.length >= (V4.econMinSamples || 3)) {
    vals.sort((a, b) => a - b);
    stationPpm.set(st, vals[Math.floor(vals.length / 2)]);
  }
}
{
  const meds = [...stationPpm.values()].sort((a, b) => a - b);
  if (meds.length >= 10) {
    const [pl, ph] = V4.econWinsorPct;
    const lo = meds[Math.floor(meds.length * pl / 100)], hi = meds[Math.min(meds.length - 1, Math.floor(meds.length * ph / 100))];
    for (const [st, v] of stationPpm) stationPpm.set(st, clamp(v, lo, hi));
  }
}

const gCurve = CFG.gangnamCurve.map(p => [p.min, p.score]);
const FR = CFG.friction;
const lineFriction = l => l.svc ? clamp(FR.base - Math.max(0, l.svc.headway - FR.headwayRef) * FR.perHeadwayMin - l.svc.fare * FR.perFareStep - ((l.svc.depth || 1) - 1) * FR.perDepthStep, FR.floor, 100) : 60;

const rows = {};
for (const s of allStations) {
  const info = NET.stations[s] || {};
  const d = Object.assign({}, NET.defaults.dest, info.d || {});
  const wl = info.w ?? NET.defaults.wealth;
  const { jobRaw, jm } = raws[s];

  /* ① 교통·네트워크 — 핵심지 체감시간 + 네트워크 구조 + 이용 마찰 */
  const gangnamMin = Math.min(...JOBS.centers.filter(c => c.gangnamCore).map(c => jm[c.id] ?? 999));
  const CW = V4.coreWeights;
  const core = clamp(
    CW.gangnam * interp(gangnamMin, gCurve) +
    CW.cbd * interp(jm.CBD ?? CFG.maxTravelMin, gCurve) +
    CW.ybd * interp(jm.YBD ?? CFG.maxTravelMin, gCurve), 0, 100);
  const NW = CFG.network;
  let covered = 0, wsum = 0;
  for (const c of JOBS.centers) { wsum += c.importance * jm[c.id]; if (jm[c.id] <= NW.directReachMin) covered += c.importance; }
  const meanMin = wsum / totalImp;
  const hubProx = clamp(100 * Math.exp(-Math.max(0, meanMin - 10) / NW.hubProximityTau), 0, 100);
  const lineCount = (stationLines.get(s) || new Set()).size;
  const lcScore = NW.lineCountScore[String(Math.min(4, Math.max(1, lineCount)))] ?? 55;
  const express = !!stationExpress.get(s);
  const network = clamp(NW.weights.directJobCoverage * (covered / totalImp) * 100 + NW.weights.hubProximity * hubProx + NW.weights.lineCount * lcScore + NW.weights.express * (express ? 100 : 40), 0, 100);
  const fric = Math.max(...(stationEntries.get(s) || []).map(lineFriction), 20);
  const TS = V4.transitSub;
  const transitRaw = TS.core * core + TS.network * network + TS.friction * fric;

  /* ② 역세권 경제력 — 실거래 기반, 없으면 수동 wealth 폴백 (추정 생성 금지) */
  const ppm = stationPpm.get(s);
  const econManual = V4.wealthFallbackScore[wl] ?? 55;

  /* ③ 교육·주거 생활권 — 학원가 허브 접근 + 단지 밀집도 */
  let hubEdu = 0, hubName = null;
  if (info.c) {
    for (const h of HUBS.hubs) {
      const dist = havKm(info.c, [h.latitude, h.longitude]);
      const coef = V4.hubTierCoef[String(h.tier)] ?? 0.45;
      const sig = 100 * coef * Math.exp(-Math.max(0, dist - h.radius_km) / V4.hubDecayKm);
      if (sig > hubEdu) { hubEdu = sig; hubName = sig > 25 ? h.hub_name : hubName; }
    }
  }
  hubEdu = clamp(hubEdu, 0, 100);
  const cplxCnt = stationDongs.has(s) ? [...stationDongs.get(s)].reduce((a, dg) => a + (dongCplx.get(dg) || 0), 0) : null;
  const density = cplxCnt != null && cplxCnt > 0 ? clamp(100 * Math.log(1 + cplxCnt) / Math.log(1 + V4.densityLogRef), 0, 100) : null;
  const ES = V4.eduSub;
  const eduRaw = density != null ? ES.hub * hubEdu + ES.density * density : hubEdu;

  /* ④ 업무·도시 중심성 — 역 주변 업무·상업·문화·의료 시설 */
  const DW = CFG.destWeights;
  const bizRaw = clamp(100 * (DW.emp * d.emp + DW.comm * d.comm + DW.cult * d.cult + DW.med * d.med + DW.tour * d.tour) / 5, 0, 100);

  rows[s] = {
    _t: transitRaw, _e: ppm != null ? null : econManual, _ppm: ppm ?? null, _edu: eduRaw, _b: bizRaw,
    sub: { core: Math.round(core), net: Math.round(network), fric: Math.round(fric), hubEdu: Math.round(hubEdu), density: density != null ? Math.round(density) : null, dest: Math.round(bizRaw) },
    hubName,
    jobAccess: Math.round(clamp(100 * jobRaw / jobRawMax, 0, 100)),
    gangnamMin, jobMinutes: jm, lines: [...(stationLines.get(s) || [])], express,
    econSrc: ppm != null ? 'live' : 'manual',
    c: info.c || null
  };
}

/* ── 축 백분위 정규화 (0~100, 동률은 평균 순위) ── */
function pctRank(getter, setter) {
  const arr = allStations.map(s => [s, getter(rows[s])]).sort((a, b) => b[1] - a[1]);
  const n = arr.length;
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && arr[j + 1][1] === arr[i][1]) j++;
    const rankAvg = (i + j) / 2;
    const score = Math.round(100 * (1 - rankAvg / (n - 1)));
    for (let k = i; k <= j; k++) setter(rows[arr[k][0]], score);
    i = j + 1;
  }
}
pctRank(r => r._t, (r, v) => { r.comps = r.comps || {}; r.comps.transit = v; });
pctRank(r => r._edu, (r, v) => { r.comps.edu = v; });
pctRank(r => r._b, (r, v) => { r.comps.biz = v; });
/* 경제력: 실거래 보유 역은 ㎡가 백분위, 미보유 역은 수동 폴백 점수를 그대로 사용 */
{
  const live = allStations.filter(s => rows[s]._ppm != null);
  const arr = live.map(s => [s, rows[s]._ppm]).sort((a, b) => b[1] - a[1]);
  arr.forEach(([s], i) => {
    const v = Math.round(100 * (1 - (arr.length === 1 ? 0 : i / (arr.length - 1))));
    rows[s].comps.econ = v;
    rows[s].areaPriceLevel = v;
  });
  for (const s of allStations) if (rows[s]._ppm == null) rows[s].comps.econ = Math.round(rows[s]._e);
}

/* ── Station Value: 4축 가중합 → 표시 정규화 (상위 1% ≈ 95~100) ── */
for (const s of allStations) {
  const c = rows[s].comps, A = V4.axes, AV = V4.axesForValuation;
  rows[s].svRaw = Math.round((A.transit * c.transit + A.econ * c.econ + A.edu * c.edu + A.biz * c.biz) * 10) / 10;
  rows[s].svTRaw = Math.round((AV.transit * c.transit + AV.econ * c.econ + AV.edu * c.edu + AV.biz * c.biz) * 10) / 10;
  rows[s].wealth = c.econ;   // 역세권 경제력 축 (실거래 기반 백분위 or 수동 폴백)
  delete rows[s]._t; delete rows[s]._e; delete rows[s]._ppm; delete rows[s]._edu; delete rows[s]._b;
}
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

/* ── 노선 V4: 중앙값 50% + 상위 25% 역 평균 30% + 핵심지 연결성 20% ── */
const CR = CFG.corridor, LV = V4.lineV4;
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
  // Golden Corridor: 연속 구간 최고 가치 (순환선은 wrap 허용) — 지도 강조·프로필 표시용
  const arr = main.loop ? seq.concat(seq) : seq;
  const wlen = Math.max(CR.windowMinLen, Math.ceil(seq.length * CR.windowShare));
  let best = { avg: -1, from: 0 };
  for (let i = 0; i + wlen <= arr.length && i < seq.length; i++) {
    const win = arr.slice(i, i + wlen);
    const avg = win.reduce((a, s) => a + metric(s), 0) / wlen;
    if (avg > best.avg) best = { avg, from: i };
  }
  const corridorStations = arr.slice(best.from, best.from + wlen);
  const svsAsc = [...g.st].map(s => rows[s].sv).sort((a, b) => a - b);
  const nSt = svsAsc.length;
  const median = nSt % 2 ? svsAsc[(nSt - 1) / 2] : (svsAsc[nSt / 2 - 1] + svsAsc[nSt / 2]) / 2;
  const topN = Math.max(2, Math.ceil(nSt * 0.25));
  const topArr = svsAsc.slice(-topN);
  const topAvg = topArr.reduce((a, b) => a + b, 0) / topN;
  const coreConnect = [...g.st].reduce((a, s) => a + rows[s].sub.core, 0) / nSt;
  const goldenRaw = LV.median * median + LV.topQuartileAvg * topAvg + LV.coreConnect * coreConnect;
  const lineAvg = svsAsc.reduce((a, b) => a + b, 0) / nSt;
  const headway = Math.min(...g.entries.filter(e => e.svc).map(e => e.svc.headway));
  const fare = Math.max(...g.entries.map(e => e.svc ? e.svc.fare : 0));
  const depth = Math.max(...g.entries.map(e => e.svc ? e.svc.depth : 1));
  const friction = clamp(FR.base - Math.max(0, headway - FR.headwayRef) * FR.perHeadwayMin - fare * FR.perFareStep - (depth - 1) * FR.perDepthStep, FR.floor, 100);
  const util = Math.round([...g.st].reduce((a, s) => a + rows[s].comps.transit, 0) / nSt);
  const sd = Math.sqrt(svsAsc.reduce((a, b) => a + (b - lineAvg) ** 2, 0) / nSt);
  linesOut.push({
    name: nm, color: g.color, goldenRaw,
    breakdown: { median: Math.round(median), topAvg: Math.round(topAvg), coreConnect: Math.round(coreConnect), topN },
    corridor: { stations: corridorStations, avg: Math.round(best.avg) },
    avg: Math.round(lineAvg * 10) / 10, util, friction: Math.round(friction),
    svc: { headway, fare, depth }, stdev: Math.round(sd * 10) / 10, count: nSt,
    profile: seq.map(s => ({ n: s, sv: Math.round(rows[s].sv) })),
    topStations: [...g.st].sort((a, b) => rows[b].sv - rows[a].sv).slice(0, 5).map(s => ({ n: s, sv: Math.round(rows[s].sv) })),
    centersOnLine: JOBS.centers.filter(c => c.stations.some(cs => g.st.has(cs))).map(c => c.name)
  });
}
/* 표시 점수 정규화: 최상위 노선 ≈ 95~100 */
const gMin = Math.min(...linesOut.map(l => l.goldenRaw)), gMax = Math.max(...linesOut.map(l => l.goldenRaw));
for (const l of linesOut) {
  l.golden = Math.round(LV.displayMin + (l.goldenRaw - gMin) / (gMax - gMin) * (LV.displayMax - LV.displayMin));
  l.goldenRaw = Math.round(l.goldenRaw * 10) / 10;
}
linesOut.sort((a, b) => b.golden - a.golden);

/* ── 저장 ── */
const meta = {
  updatedAt: NET.meta.asOf, version: 4,
  method: 'V4 4축(교통·네트워크 30 / 역세권 경제력 35 / 교육·주거 20 / 업무·중심성 15) — 각 축 백분위 정규화 후 가중합, 역·노선 점수 하드코딩 없음',
  status: 'ESTIMATED', stationCount: allStations.length,
  econLiveCount: [...stationPpm.keys()].length,
  note: '경제력 축은 역 생활권 실거래 ㎡가 중앙값(winsorize) 백분위. 가치평가용 svT는 경제력·교육 축 축소(중복 계상 방지)'
};
fs.writeFileSync(path.join(ROOT, 'data', 'station_intelligence.json'), JSON.stringify({ meta, stations: rows }));
fs.writeFileSync(path.join(ROOT, 'data', 'line_intelligence.json'), JSON.stringify({ meta, lines: linesOut }));

const sorted = allStations.slice().sort((a, b) => rows[b].sv - rows[a].sv);
console.log(`역 ${allStations.length}개 · 노선 ${linesOut.length}개 (V4) · 경제력 실거래 기반 ${meta.econLiveCount}개 역`);
console.log('TOP 12:', sorted.slice(0, 12).map(s => `${s} ${Math.round(rows[s].sv)}`).join(' / '));
console.log('노선:', linesOut.map(l => `${l.name} ${l.golden}`).join(' / '));
for (const l of linesOut.filter(x => ['공항철도', 'GTX-A', '3호선', '9호선', '2호선', '5호선', '신분당선'].includes(x.name)))
  console.log(`  ${l.name}: 중앙값 ${l.breakdown.median} · 상위${l.breakdown.topN}역 ${l.breakdown.topAvg} · 핵심연결 ${l.breakdown.coreConnect} → ${l.golden}`);
const probe = ['압구정', '대치', '잠실', '신사', '여의도', '광화문', '목동', '오목교', '올림픽공원', '둔촌동', '고덕', '강남', '종로3가', '녹번', '중계', '평촌', '수내', '동탄', '성수', '서울역'];
for (const s of probe) if (rows[s]) {
  const c = rows[s].comps;
  console.log(`  ${s}: SV ${rows[s].sv} (${rows[s].rank}위) 교통 ${c.transit} 경제력 ${c.econ}(${rows[s].econSrc}) 교육주거 ${c.edu} 업무 ${c.biz}`);
}
