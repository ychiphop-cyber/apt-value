'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Station Intelligence V5 빌더 — Station Value(역 생활권 가치)와
   Line Value(노선 네트워크 가치)를 서로 다른 모델로 분리한다.

   [Station Value — 4축, V4 유지 + 경제력 계산 개선]
     ① 교통·네트워크 30% ② 역세권 경제력 35% ③ 교육·주거 20% ④ 업무·중심성 15%
     경제력(V5): 거래 → 평형(최근 거래 중앙값, 이상거래 필터) → 단지 대표 ㎡가
     (평형별 값의 중앙값, 단지당 1표) → 역세권 도보시간 가중 중앙값.
     법정동 전체 가격 일괄 귀속·최신 1건 표본·평형 수 편중을 제거했고,
     단지당 1표 + 중앙값이라 특정 단지(평가 대상 포함)가 역 점수를 좌우하기
     어렵다(순환 방지). 소득·자산 데이터를 추정 생성하지 않는다 — 부족하면 수동 폴백.

   [Line Value V5 — Station Value 평균이 아니다]
     ① 핵심 생활권 연결력 30% — config/life_hubs.json의 서로 다른 생활권을
        몇 곳이나 직결하는가 (같은 생활권 역 여러 개 = 1회, Unique Hubs)
     ② 노선 내 역세권 가치 25% — 환승 감쇄(편승 방지) 적용한 SV의
        중앙값·상위25%평균·80점 이상 비율 조합 (단순 평균 금지)
     ③ 도시 횡단·네트워크 20% — 생활권 유형 다양성(주거↔업무↔교육↔관문),
        타 노선 환승 연결, KTX·공항 관문 (노선 길이 자체엔 점수 없음)
     ④ 실제 이동 효율 15% — 배차·표정속도·급행
     ⑤ 독점성·대체불가능성 10% — 단독 역 비중(SV 가중)·생활권 독점 연결
   원칙: 역·노선 점수 하드코딩 금지 / 모든 계수는 config에서만 관리 /
   순위를 만들기 위한 보정 금지. 사용: node pipeline/station_intel.js
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const R = p => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

const NET = R('data/rail_network.json');
const JOBS = R('config/job_centers.json');
const HUBS = R('config/education_hubs.json');
const LIFE = R('config/life_hubs.json');
const CFG = R('config/valuation-parameters.json').station;
const GEN = CFG.generalized;
const V4 = CFG.v4;
const LV5 = CFG.lineV5;

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
const stationDongs = new Map();   // 역 → dong_stations 키 집합 (밀집도용)
const stationDongLinks = new Map(); // 역 → [{key, min}] (경제력 도보시간 가중용)
const dongOverrides = new Map();  // 동 → 스코프 오버라이드가 존재하는 지역코드 집합
try {
  const DONG = R('data/dong_stations.json');
  for (const [key, links] of Object.entries(DONG.map)) {
    const m = key.match(/^(\d{5}):(.+)$/);
    if (m) { if (!dongOverrides.has(m[2])) dongOverrides.set(m[2], new Set()); dongOverrides.get(m[2]).add(m[1]); }
    for (const l of links) {
      if (!stationDongs.has(l.st)) stationDongs.set(l.st, new Set());
      stationDongs.get(l.st).add(key);
      if (!stationDongLinks.has(l.st)) stationDongLinks.set(l.st, []);
      stationDongLinks.get(l.st).push({ key, min: l.min ?? 10 });
    }
  }
} catch (e) { console.log('dong_stations 없음:', e.message); }

const median = arr => { const a = arr.slice().sort((x, y) => x - y); const n = a.length; return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2; };
const wMedian = items => {   // items: [{v,w}] — 가중 중앙값
  const a = items.slice().sort((x, y) => x.v - y.v);
  const tot = a.reduce((s, it) => s + it.w, 0);
  let acc = 0;
  for (const it of a) { acc += it.w; if (acc >= tot / 2) return it.v; }
  return a.length ? a[a.length - 1].v : null;
};

/* V5 경제력: 거래 → 평형(최근 중앙값·이상거래 필터) → 단지 대표 ㎡가(단지당 1표) */
const dongComplexPpm = new Map();  // 키("동" 또는 "코드:동") → [단지 대표 ㎡가...]
const dongCplx = new Map();        // 키 → 단지 수 (밀집도)
{
  const plainRegions = new Map();   // 일반 키의 동명 충돌 감지 (스코프 지역 제외 후)
  const [bandLo, bandHi] = V4.econTradeBand;
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
        const areaPpms = []; let obsN = 0;
        for (const ar of Object.values(cx.areas)) {
          if (ar.jeonse && ar.jeonse.n) obsN += ar.jeonse.n;            // 전세 거래도 규모 proxy에 포함
          if (!ar.trades || !ar.trades.length || !ar.m2) continue;
          let prices = ar.trades.filter(t => !t.o).map(t => t.price);   // 이상거래 플래그 제외
          if (!prices.length) continue;
          if (prices.length >= V4.econTradeBandMinTrades) {             // 거래 단위 이상치 제거
            const med0 = median(prices);
            prices = prices.filter(p => p >= med0 * bandLo && p <= med0 * bandHi);
          }
          areaPpms.push(median(prices) / ar.m2);                        // 평형 대표 = 최근(수집창) 거래 중앙값
          obsN += prices.length;
        }
        if (!areaPpms.length || obsN < (V4.econComplexMinObs || 2)) continue;
        if (!dongComplexPpm.has(key)) dongComplexPpm.set(key, []);
        // 단지 대표 = 평형 값 중앙값. n = 매매+전세 관측수(단지 규모 proxy — 세대수 데이터 없음.
        // 매매만 쓰면 거래허가구역 대단지의 규모가 지워진다)
        dongComplexPpm.get(key).push({ ppm: median(areaPpms), n: obsN });
      }
    }
    for (const [dg, set] of plainRegions) if (set.size > 1) { dongComplexPpm.delete(dg); dongCplx.delete(dg); }
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

/* 역세권 ㎡가: 단지 대표값(1표) × 도보시간 가중 → 가중 중앙값 → winsorize */
const walkCurve = V4.econWalkCurve.map(p => [p.min, p.w]);
const stationPpm = new Map();
const stationEconN = new Map();   // 역 → 표본 단지 수 (신뢰도 표시용)
for (const [st, links] of stationDongLinks) {
  const items = [];
  for (const { key, min } of links) {
    const walkW = interp(min, walkCurve);
    for (const c of (dongComplexPpm.get(key) || []))
      items.push({ v: c.ppm, w: walkW * Math.min(c.n, V4.econSizeCap) });
  }
  if (items.length >= (V4.econMinSamples || 3)) {
    stationPpm.set(st, wMedian(items));
    stationEconN.set(st, items.length);
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
    econN: stationEconN.get(s) ?? null,   // 경제력 표본(단지 수) — 신뢰도 표시용
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
/* 경제력: 실거래 보유 역은 ㎡가 백분위(동률 = 평균 순위 — winsorize 상한 동률 구간이
   임의 순서로 100·99…를 나눠 갖지 않게 한다), 미보유 역은 수동 폴백 점수 사용 */
{
  const live = allStations.filter(s => rows[s]._ppm != null);
  const arr = live.map(s => [s, rows[s]._ppm]).sort((a, b) => b[1] - a[1]);
  const n = arr.length;
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && arr[j + 1][1] === arr[i][1]) j++;
    const v = Math.round(100 * (1 - (n === 1 ? 0 : ((i + j) / 2) / (n - 1))));
    for (let k = i; k <= j; k++) { rows[arr[k][0]].comps.econ = v; rows[arr[k][0]].areaPriceLevel = v; }
    i = j + 1;
  }
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

/* ══════════ Line Value V5 — Station Value 평균이 아닌 별도 네트워크 모델 ══════════ */
const CR = CFG.corridor;
const lineGroups = new Map();
for (const line of NET.lines) {
  const nm = line.name.replace(' 급행', '');
  if (!lineGroups.has(nm)) lineGroups.set(nm, { color: line.color, st: new Set(), entries: [] });
  const g = lineGroups.get(nm);
  line.stations.forEach(s => g.st.add(s));
  g.entries.push(line);
}

/* 생활권 허브 인덱스 (역 → 허브, 1역 1허브) + 데이터 검증 */
const hubOf = new Map();
for (const h of LIFE.hubs) {
  for (const s of h.stations) {
    if (!byStation.has(s)) { console.log(`⚠ life_hubs: 미존재 역 "${s}" (${h.name})`); continue; }
    if (hubOf.has(s)) { console.log(`⚠ life_hubs: 역 "${s}" 중복 소속 (${hubOf.get(s).name} / ${h.name}) — 앞선 허브 유지`); continue; }
    hubOf.set(s, h);
  }
}
/* 허브별 취급 노선 수 (독점성 축) */
const hubLineNames = new Map();
for (const [nm, g] of lineGroups)
  for (const s of g.st) { const h = hubOf.get(s); if (h) { if (!hubLineNames.has(h.name)) hubLineNames.set(h.name, new Set()); hubLineNames.get(h.name).add(nm); } }
const gateways = new Set(LIFE.intercityGateways);
const lineCountOf = s => Math.max(1, (stationLines.get(s) || new Set()).size);
const decayOf = s => LV5.transferDecay[String(Math.min(3, lineCountOf(s)))] ?? 1;
const hwCurve = LV5.headwayCurve.map(p => [p.min, p.s]);
const spCurve = LV5.speedCurve.map(p => [p.kmh, p.s]);

const linesOut = [];
for (const [nm, g] of lineGroups) {
  const main = g.entries.filter(e => !e.overlay).sort((a, b) => b.stations.length - a.stations.length)[0];
  const seq = main.stations;
  const stArr = [...g.st];
  const nSt = stArr.length;

  // Golden Corridor: 연속 구간 최고 가치 (지도 강조·프로필 표시용 — 점수에 미사용)
  const metric = s => CR.svWeight * rows[s].sv + CR.wealthWeight * rows[s].wealth;
  const arr = main.loop ? seq.concat(seq) : seq;
  const wlen = Math.max(CR.windowMinLen, Math.ceil(seq.length * CR.windowShare));
  let best = { avg: -1, from: 0 };
  for (let i = 0; i + wlen <= arr.length && i < seq.length; i++) {
    const avg = arr.slice(i, i + wlen).reduce((a, s) => a + metric(s), 0) / wlen;
    if (avg > best.avg) best = { avg, from: i };
  }
  const corridorStations = arr.slice(best.from, best.from + wlen);

  /* ① 핵심 생활권 연결력 — 서로 다른 생활권 1회씩 (Unique Hubs). 같은 생활권 역이
     여러 개라고 반복 가산하지 않되, 역 1개로 스치는지/2~3개 역으로 취급하는지의
     직결성 차이만 hubDepth(0.7/0.85/1.0 상한)로 반영. §15 환승 편승 방지: 그 생활권을
     취급하는 역들이 환승역뿐이면(다른 노선의 연결가치에 편승) 감쇄 평균을 곱한다.
     raw는 전 노선 최대 대비 정규화 */
  const hubStns = new Map();
  for (const s of stArr) { const h = hubOf.get(s); if (h) { if (!hubStns.has(h)) hubStns.set(h, []); hubStns.get(h).push(s); } }
  const hubsServed = [...hubStns.keys()];
  // '취급' 기준: 역 2개 이상(단일역 생활권은 그 역 1개) — 못 채우면 스침으로 보고 감쇄
  const fullServe = h => hubStns.get(h).length >= Math.min(2, h.stations.length);
  const depthCoef = h => fullServe(h) ? 1 : LV5.hubDepthPartial;
  const hubDecay = h => { const a = hubStns.get(h); return a.reduce((x, s) => x + decayOf(s), 0) / a.length; };
  const hubRaw = hubsServed.reduce((a, h) => a + (LV5.hubTierCoef[String(h.tier)] ?? 0.5) * depthCoef(h) * hubDecay(h), 0);

  /* ② 노선 내 역세권 가치 — 환승 감쇄 SV의 중앙값·상위25%·80점 이상 비율 */
  const dsv = stArr.map(s => rows[s].sv * decayOf(s)).sort((a, b) => a - b);
  const medD = median(dsv);
  const topN = Math.max(2, Math.ceil(nSt * 0.25));
  const topAvgD = dsv.slice(-topN).reduce((a, b) => a + b, 0) / topN;
  const share80 = stArr.filter(s => rows[s].sv >= LV5.share80Threshold).length / nSt;
  const SS = LV5.stationSub;
  const stationScore = clamp(SS.median * medD + SS.topQuartile * topAvgD + SS.share80 * share80 * 100, 0, 100);

  /* ③ 도시 횡단·네트워크 — 서로 다른 기능의 생활권을 잇는 '관계' 4종 + 타 노선 환승
     + 광역 관문. 노선 길이 자체에는 점수를 주지 않는다 */
  // 관계 판정에는 '취급'(fullServe) 생활권만 인정 — 역 1개 스침으로 관계를 주장하지 못한다(§11)
  const served = hubsServed.filter(fullServe);
  const attrsOf = h => h.attrs || ({ res: ['res'], edu: ['res', 'edu'], biz: ['biz'], mixed: ['res', 'biz'], transport: ['gw'] }[h.type] || []);
  const resHubs = served.filter(h => attrsOf(h).includes('res'));
  const bizHubs = served.filter(h => attrsOf(h).includes('biz'));
  const rel = [
    resHubs.some(r => bizHubs.some(b => b !== r)),                    // ① 주거권 ↔ 업무권 직결
    served.some(h => attrsOf(h).includes('edu')) && resHubs.length >= 2, // ② 주거권 ↔ 교육권 직결
    bizHubs.length >= 2,                                               // ③ 서로 다른 업무권 간 직결
    stArr.some(s => gateways.has(s))                                   // ④ 광역 관문 연결
  ].filter(Boolean).length / 4;
  const typeCount = new Set(hubsServed.map(h => h.type)).size;
  const otherLines = [...lineGroups.keys()].filter(o => o !== nm && [...lineGroups.get(o).st].some(s => g.st.has(s))).length;
  const gwServed = stArr.filter(s => gateways.has(s));
  const NS = LV5.networkSub;
  const networkScore = clamp(100 * (
    NS.diversity * rel +
    NS.transfer * Math.min(1, otherLines / LV5.transferLineRef) +
    NS.intercity * Math.min(1, gwServed.length / LV5.intercityRef)), 0, 100);

  /* ④ 실제 이동 효율 — 배차 + 표정속도(역간거리/역간시간) + 급행 */
  const headway = Math.min(...g.entries.filter(e => e.svc).map(e => e.svc.headway));
  const fare = Math.max(...g.entries.map(e => e.svc ? e.svc.fare : 0));
  const depth = Math.max(...g.entries.map(e => e.svc ? e.svc.depth : 1));
  const express = g.entries.some(e => e.express);
  let kmh = null;
  {
    let km = 0, hops = 0;
    for (let i = 1; i < seq.length; i++) {
      const a = (NET.stations[seq[i - 1]] || {}).c, b = (NET.stations[seq[i]] || {}).c;
      if (a && b) { km += havKm(a, b); hops++; }
    }
    if (hops) kmh = (km / hops) / main.hopMin * 60;
  }
  const ES = LV5.efficiencySub;
  const effScore = clamp(
    ES.headway * interp(headway, hwCurve) +
    ES.speed * (kmh != null ? interp(kmh, spCurve) : 50) +
    ES.express * (express ? LV5.expressScore.yes : LV5.expressScore.no), 0, 100);

  /* ⑤ 독점성·대체불가능성 — 단독 취급 역 비중(SV 가중) + 생활권 독점 연결 */
  const svSum = stArr.reduce((a, s) => a + rows[s].sv, 0);
  const soloShare = svSum > 0 ? stArr.reduce((a, s) => a + rows[s].sv / lineCountOf(s), 0) / svSum : 0;
  const hubExShare = hubsServed.length
    ? hubsServed.filter(h => (hubLineNames.get(h.name) || new Set()).size <= LV5.hubExclusiveMaxLines).length / hubsServed.length
    : 0;
  const US = LV5.uniquenessSub;
  const uniqScore = clamp(100 * (US.soloShare * soloShare + US.hubExclusive * hubExShare), 0, 100);

  const friction = clamp(FR.base - Math.max(0, headway - FR.headwayRef) * FR.perHeadwayMin - fare * FR.perFareStep - (depth - 1) * FR.perDepthStep, FR.floor, 100);
  const svsAsc = stArr.map(s => rows[s].sv).sort((a, b) => a - b);
  const lineAvg = svsAsc.reduce((a, b) => a + b, 0) / nSt;
  const sd = Math.sqrt(svsAsc.reduce((a, b) => a + (b - lineAvg) ** 2, 0) / nSt);

  linesOut.push({
    name: nm, color: g.color,
    _hubRaw: hubRaw, _station: stationScore, _network: networkScore, _eff: effScore, _uniq: uniqScore,
    breakdown: {
      // hub는 아래에서 전 노선 최대 대비 정규화 후 기록
      station: Math.round(stationScore), network: Math.round(networkScore),
      efficiency: Math.round(effScore), uniqueness: Math.round(uniqScore),
      medianDecayed: Math.round(medD), topAvgDecayed: Math.round(topAvgD), topN,
      share80: Math.round(share80 * 100), typeCount, otherLines, relations: Math.round(rel * 4),
      gateways: gwServed, kmh: kmh != null ? Math.round(kmh) : null,
      hubs: hubsServed.sort((a, b) => a.tier - b.tier || hubStns.get(b).length - hubStns.get(a).length).map(h => ({ n: h.name, t: h.type, tier: h.tier, cnt: hubStns.get(h).length, ex: (hubLineNames.get(h.name) || new Set()).size <= LV5.hubExclusiveMaxLines }))
    },
    corridor: { stations: corridorStations, avg: Math.round(best.avg) },
    avg: Math.round(lineAvg * 10) / 10, friction: Math.round(friction),
    svc: { headway, fare, depth }, express, stdev: Math.round(sd * 10) / 10, count: nSt,
    profile: seq.map(s => ({ n: s, sv: Math.round(rows[s].sv) })),
    topStations: stArr.sort((a, b) => rows[b].sv - rows[a].sv).slice(0, 5).map(s => ({ n: s, sv: Math.round(rows[s].sv) })),
    centersOnLine: JOBS.centers.filter(c => c.stations.some(cs => g.st.has(cs))).map(c => c.name)
  });
}
/* 허브 축 정규화(전 노선 최대 대비) → 5축 가중합 → 표시 스케일 */
const hubMax = Math.max(...linesOut.map(l => l._hubRaw), 0.001);
const LA = LV5.axes;
for (const l of linesOut) {
  const hubScore = clamp(100 * l._hubRaw / hubMax, 0, 100);
  l.breakdown.hub = Math.round(hubScore);
  l.goldenRaw = LA.hub * hubScore + LA.station * l._station + LA.network * l._network + LA.efficiency * l._eff + LA.uniqueness * l._uniq;
  delete l._hubRaw; delete l._station; delete l._network; delete l._eff; delete l._uniq;
}
const gMin = Math.min(...linesOut.map(l => l.goldenRaw)), gMax = Math.max(...linesOut.map(l => l.goldenRaw));
for (const l of linesOut) {
  l.golden = Math.round(LV5.displayMin + (l.goldenRaw - gMin) / (gMax - gMin) * (LV5.displayMax - LV5.displayMin));
  l.goldenRaw = Math.round(l.goldenRaw * 10) / 10;
}
linesOut.sort((a, b) => b.golden - a.golden || b.goldenRaw - a.goldenRaw);

/* ── 저장 — station·line 파일은 반드시 같은 meta(버전·생성시각)로 함께 생성된다 ── */
const meta = {
  updatedAt: NET.meta.asOf, version: 5, generatedAt: new Date().toISOString(),
  method: 'V5 — Station Value 4축(교통30/경제력35/교육주거20/업무15, 경제력은 단지 대표가 도보가중 중앙값) · Line Value 5축(생활권 연결력30/역세권 가치25/도시 네트워크20/이동 효율15/독점성10, 환승 감쇄) — 역·노선 점수 하드코딩 없음',
  status: 'ESTIMATED', stationCount: allStations.length,
  econLiveCount: [...stationPpm.keys()].length,
  note: '경제력 축: 거래→평형(중앙값·이상거래 필터)→단지 대표 ㎡가(단지당 1표)→도보시간 가중 중앙값→winsorize 백분위. Line Value는 Station Value 평균이 아님'
};
fs.writeFileSync(path.join(ROOT, 'data', 'station_intelligence.json'), JSON.stringify({ meta, stations: rows }));
fs.writeFileSync(path.join(ROOT, 'data', 'line_intelligence.json'), JSON.stringify({ meta, lines: linesOut }));

const sorted = allStations.slice().sort((a, b) => rows[b].sv - rows[a].sv);
console.log(`역 ${allStations.length}개 · 노선 ${linesOut.length}개 (V5) · 경제력 실거래 기반 ${meta.econLiveCount}개 역`);
console.log('TOP 12:', sorted.slice(0, 12).map(s => `${s} ${Math.round(rows[s].sv)}`).join(' / '));
console.log('노선:', linesOut.map(l => `${l.name} ${l.golden}`).join(' / '));
for (const l of linesOut) {
  const B = l.breakdown;
  console.log(`  ${l.name}: 생활권 ${B.hub} · 역세권 ${B.station}(중앙 ${B.medianDecayed}/상위 ${B.topAvgDecayed}/80+ ${B.share80}%) · 네트워크 ${B.network}(유형 ${B.typeCount}·환승 ${B.otherLines}·관문 ${B.gateways.length}) · 효율 ${B.efficiency}(${B.kmh}km/h) · 독점 ${B.uniqueness} → ${l.golden}  [${B.hubs.map(h => h.n).join(', ')}]`);
}
const probe = ['압구정', '대치', '잠실', '잠실새내', '신사', '여의도', '광화문', '공덕', '목동', '오목교', '올림픽공원', '둔촌동', '고덕', '강남', '종로3가', '녹번', '중계', '평촌', '수내', '동탄', '성수', '서울역'];
for (const s of probe) if (rows[s]) {
  const c = rows[s].comps;
  console.log(`  ${s}: SV ${rows[s].sv} (${rows[s].rank}위) 교통 ${c.transit} 경제력 ${c.econ}(${rows[s].econSrc}${rows[s].econN ? ' n=' + rows[s].econN : ''}) 교육주거 ${c.edu} 업무 ${c.biz}`);
}
