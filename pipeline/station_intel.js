'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Station Intelligence V5 빌더 — Station Value(역 생활권 가치)와
   Line Value(노선 네트워크 가치)를 서로 다른 모델로 분리한다.

   [Station Value — 4축, V4 유지 + 경제력 정의 수정(V5.2)]
     ① 교통·네트워크 30% ② 역세권 경제력 35% ③ 교육·주거 20% ④ 업무·중심성 15%
     경제력(V5.2) = 그 역 생활권에 "거주하는 주민들의 경제 수준(소득·소비)"만 평가.
     입력은 역세권 거주민 경제수준 추정 등급 w(1~5, rail_network 전문가 추정,
     ESTIMATED)뿐이다. 아파트 실거래가·시세는 입력에서 완전히 제외(집값→역 가치
     →아파트 가치 순환참조 차단), 업무지·상권·유동인구도 제외(업무 축과 이중
     가중 방지 — 업무는 d.emp 등에서 별도 평가). 역세권 단위 소득·자산 정밀
     데이터가 없으므로 등급 추정임을 숨기지 않는다(임의 정밀값 생성 금지).
     주변 시세는 priceLevel(검증용 참고 지표)로만 별도 저장하고 점수에 쓰지 않는다.

   [Line Value V5.1 — Station Value 평균이 아니다. 같은 장점의 중복 보상 금지]
     ① 노선 내 역세권 가치 30% — 환승 감쇄(편승 방지) 적용한 SV의
        중앙값·상위25%평균·80점 이상 비율 조합 (단순 평균 금지)
     ② 핵심 생활권 연결력 25% — config/life_hubs.json의 서로 다른 생활권 직결
        (같은 생활권 역 여러 개 = 1회, 1역 스침 감쇄, **한계효용 체감** 0.82^i —
        생활권 개수 누적으로 긴 노선이 과대평가되지 않게)
     ③ 도시 횡단·네트워크 20% — 환승 네트워크·KTX/공항 관문·동서남북 횡단성만.
        생활권 축과 중복되는 주거↔업무·주거↔교육 관계는 여기서 재가산하지 않음
     ④ 실제 이동 효율 15% — 배차·표정속도·급행
     ⑤ 대체불가능성 10% — 노선 제거 시 핵심지 도달시간 증가(그래프 재계산, SV 가중)
        + 생활권 독점 연결. 단독역 '수'는 사용하지 않음
     최종 점수는 raw 그대로(재스케일 없음) + Tier(S/A/B/C) 표시
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
const ANCH = R('config/anchor_academies.json');
const LIFE = R('config/life_hubs.json');
const FULLCFG = R('config/valuation-parameters.json');
const AptEngine = require('../src/engine.js');
const CFG = FULLCFG.station;
/* 교육 V2(§11): 존 점수는 사전 Tier가 아니라 구성요소에서 계산 — 엔진과 동일 스코어러 사용 */
const zoneScoreOf = z => { const s = AptEngine.eduZoneScore(z, FULLCFG.education, ANCH); return s ? s.score : 0; };
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

  /* ② 역세권 경제력 — 거주민 경제수준(소득·소비) 추정 등급 w(1~5)만 사용.
     시세·업무·상권은 입력에서 제외. 시세는 검증용 priceLevel로만 별도 저장 */
  const ppm = stationPpm.get(s);

  /* ③ 교육·주거 생활권 — 교육생활권(zone) 접근 + 단지 밀집도.
     존 강도 = 구성요소 계산 점수(§11 데이터→점수 — 사전 Tier 계수 폐기) × 거리 감쇄 */
  let hubEdu = 0, hubName = null;
  if (info.c) {
    for (const z of HUBS.zones) {
      const dist = havKm(info.c, [z.latitude, z.longitude]);
      const sig = zoneScoreOf(z) * Math.exp(-Math.max(0, dist - z.radius_km) / V4.hubDecayKm);
      if (sig > hubEdu) { hubEdu = sig; hubName = sig > 25 ? z.name : hubName; }
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
    _t: transitRaw, _w: wl, _ppm: ppm ?? null, _edu: eduRaw, _b: bizRaw,
    sub: { core: Math.round(core), net: Math.round(network), fric: Math.round(fric), hubEdu: Math.round(hubEdu), density: density != null ? Math.round(density) : null, dest: Math.round(bizRaw) },
    hubName,
    jobAccess: Math.round(clamp(100 * jobRaw / jobRawMax, 0, 100)),
    gangnamMin, jobMinutes: jm, lines: [...(stationLines.get(s) || [])], express,
    econSrc: 'grade', econGrade: wl,       // 거주민 경제수준 추정 등급 (1~5, ESTIMATED)
    priceN: stationEconN.get(s) ?? null,   // 주변 시세(검증용) 표본 단지 수
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
/* 경제력: 거주민 경제수준 추정 등급 w(1~5)의 전 역 백분위 (동률 = 평균 순위).
   시세·업무·상권 미사용 — 등급이 같으면 상권 규모나 집값이 달라도 같은 점수다 */
pctRank(r => r._w, (r, v) => { r.comps.econ = v; });
/* 주변 시세 수준 — 검증용 참고 지표(Station Value에 미반영). 실거래 보유 역만 백분위 */
{
  const live = allStations.filter(s => rows[s]._ppm != null);
  const arr = live.map(s => [s, rows[s]._ppm]).sort((a, b) => b[1] - a[1]);
  const n = arr.length;
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && arr[j + 1][1] === arr[i][1]) j++;
    const v = Math.round(100 * (1 - (n === 1 ? 0 : ((i + j) / 2) / (n - 1))));
    for (let k = i; k <= j; k++) rows[arr[k][0]].priceLevel = v;
    i = j + 1;
  }
  for (const s of allStations) if (rows[s]._ppm == null) rows[s].priceLevel = null;
}

/* ── Station Value: 4축 가중합 → 표시 정규화 (상위 1% ≈ 95~100) ── */
for (const s of allStations) {
  const c = rows[s].comps, A = V4.axes, AV = V4.axesForValuation;
  rows[s].svRaw = Math.round((A.transit * c.transit + A.econ * c.econ + A.edu * c.edu + A.biz * c.biz) * 10) / 10;
  rows[s].svTRaw = Math.round((AV.transit * c.transit + AV.econ * c.econ + AV.edu * c.edu + AV.biz * c.biz) * 10) / 10;
  rows[s].wealth = c.econ;   // 역세권 경제력 축 (실거래 기반 백분위 or 수동 폴백)
  delete rows[s]._t; delete rows[s]._w; delete rows[s]._ppm; delete rows[s]._edu; delete rows[s]._b;
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

/* ══════════ Line Value V5.1 — Station Value 평균이 아닌 별도 네트워크 모델 ══════════ */

/* 대체불가능성(detour) 측정: 특정 노선을 제거한 축소 철도망에서 핵심지 체감 도달시간을
   다시 계산 — "이 노선이 없어지면 얼마나 우회해야 하나"의 직접 근사.
   §21: 핵심지는 강남·도심·여의도 하드코딩이 아니라 importance ≥ coreCenterMinImportance인
   다핵 업무지 전체(잠실·삼성·판교 등 포함) — 8호선의 잠실 대체불가성 같은 기능이 반영된다.
   단독역 수 같은 proxy를 쓰지 않고 실제 그래프 재계산으로 측정한다. */
const coreCenters = JOBS.centers.filter(c => c.importance >= (LV5.coreCenterMinImportance ?? 0.4));
function reducedCoreTimes(excludeGroup) {
  const vids2 = new Map(); const vlist2 = []; const adj2 = [];
  const vid2 = (s, l) => { const k = s + '§' + l; if (!vids2.has(k)) { vids2.set(k, vlist2.length); vlist2.push({ s, l }); adj2.push([]); } return vids2.get(k); };
  for (const line of NET.lines) {
    if (line.name.replace(' 급행', '') === excludeGroup) continue;
    const st = line.stations;
    for (let i = 0; i < st.length; i++) {
      vid2(st[i], line.id);
      if (i > 0) { const a = vid2(st[i - 1], line.id), b = vid2(st[i], line.id); adj2[a].push([b, line.hopMin]); adj2[b].push([a, line.hopMin]); }
    }
    if (line.loop) { const a = vid2(st[st.length - 1], line.id), b = vid2(st[0], line.id); adj2[a].push([b, line.hopMin]); adj2[b].push([a, line.hopMin]); }
  }
  const byStation2 = new Map();
  for (let i = 0; i < vlist2.length; i++) {
    if (!byStation2.has(vlist2[i].s)) byStation2.set(vlist2[i].s, []);
    byStation2.get(vlist2[i].s).push(i);
  }
  for (const arr of byStation2.values())
    for (const a of arr) for (const b of arr) {
      if (a !== b) adj2[a].push([b, GEN.transferWalkMin + boardCost(lineById[vlist2[b].l])]);
    }
  // 멀티소스: 모든 핵심지 앵커역에서 출발 → 각 역까지 최단 체감시간의 최솟값
  const dist = new Float64Array(vlist2.length).fill(Infinity);
  const pq = [];
  for (const c of coreCenters) for (const cs of c.stations) {
    for (const v of (byStation2.get(cs) || [])) {
      const d0 = boardCost(lineById[vlist2[v].l]);
      if (d0 < dist[v]) { dist[v] = d0; pq.push([d0, v]); }
    }
  }
  while (pq.length) {
    let bi = 0;
    for (let i = 1; i < pq.length; i++) if (pq[i][0] < pq[bi][0]) bi = i;
    const [d, u] = pq.splice(bi, 1)[0];
    if (d > dist[u]) continue;
    for (const [v, w] of adj2[u]) {
      const nd = d + w;
      if (nd < dist[v] - 1e-9) { dist[v] = nd; pq.push([nd, v]); }
    }
  }
  const out = new Map();
  for (let i = 0; i < vlist2.length; i++) {
    const s = vlist2[i].s;
    const cur = out.get(s);
    if (cur === undefined || dist[i] < cur) out.set(s, dist[i]);
  }
  return out;
}

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

  /* ② 핵심 생활권 연결력 25% — 서로 다른 생활권 1회씩 (Unique Hubs). 같은 생활권 역이
     여러 개라고 반복 가산하지 않고, 1역 스침은 hubDepthPartial 감쇄, §15 환승 편승 감쇄 적용.
     V5.1: 한계효용 체감 — 기여도 내림차순 i번째 생활권에 hubDiminish^i 배. 생활권 '개수'의
     단순 누적(긴 노선 유리)을 막고, 처음 몇 개의 고가치 직결에 가치를 집중한다.
     raw는 전 노선 최대 대비 정규화 */
  const hubStns = new Map();
  for (const s of stArr) { const h = hubOf.get(s); if (h) { if (!hubStns.has(h)) hubStns.set(h, []); hubStns.get(h).push(s); } }
  const hubsServed = [...hubStns.keys()];
  // '취급' 기준: 역 2개 이상(단일역 생활권은 그 역 1개) — 못 채우면 스침으로 보고 감쇄
  const fullServe = h => hubStns.get(h).length >= Math.min(2, h.stations.length);
  const depthCoef = h => fullServe(h) ? 1 : LV5.hubDepthPartial;
  const hubDecay = h => { const a = hubStns.get(h); return a.reduce((x, s) => x + decayOf(s), 0) / a.length; };
  const hubRaw = hubsServed.map(h => (LV5.hubTierCoef[String(h.tier)] ?? 0.5) * depthCoef(h) * hubDecay(h))
    .sort((a, b) => b - a)
    .reduce((a, c, i) => a + c * Math.pow(LV5.hubDiminish, i), 0);

  /* ② 노선 내 역세권 가치 — 환승 감쇄 SV의 중앙값·상위25%·80점 이상 비율 */
  const dsv = stArr.map(s => rows[s].sv * decayOf(s)).sort((a, b) => a - b);
  const medD = median(dsv);
  const topN = Math.max(2, Math.ceil(nSt * 0.25));
  const topAvgD = dsv.slice(-topN).reduce((a, b) => a + b, 0) / topN;
  const share80 = stArr.filter(s => rows[s].sv >= LV5.share80Threshold).length / nSt;
  const SS = LV5.stationSub;
  const stationScore = clamp(SS.median * medD + SS.topQuartile * topAvgD + SS.share80 * share80 * 100, 0, 100);

  /* ③ 도시 횡단·네트워크 20% — 환승 네트워크 + 광역 관문 + 동서·남북 횡단성만.
     생활권 연결력 축과 중복되는 주거↔업무·주거↔교육 관계는 여기서 다시 가산하지 않는다(V5.1).
     횡단성은 시청 반경 내 구간의 스팬만 계산 — 수도권 외곽 연장은 횡단이 아니며 길이 무가산 */
  const otherLines = [...lineGroups.keys()].filter(o => o !== nm && [...lineGroups.get(o).st].some(s => g.st.has(s))).length;
  const gwServed = stArr.filter(s => gateways.has(s));
  const CITY = [37.566, 126.978];   // 서울시청
  const inSeoul = stArr.map(s => rows[s].c).filter(c => c && havKm(c, CITY) <= LV5.crossSeoulRadiusKm);
  let ewKm = 0, nsKm = 0;
  if (inSeoul.length >= 2) {
    const lats = inSeoul.map(c => c[0]), lons = inSeoul.map(c => c[1]);
    ewKm = (Math.max(...lons) - Math.min(...lons)) * 111.32 * Math.cos(37.55 * Math.PI / 180);
    nsKm = (Math.max(...lats) - Math.min(...lats)) * 110.95;
  }
  const crossing = 0.5 * Math.min(1, ewKm / LV5.crossSpanRefKm) + 0.5 * Math.min(1, nsKm / LV5.crossSpanRefKm);
  const NS = LV5.networkSub;
  const networkScore = clamp(100 * (
    NS.transfer * Math.min(1, otherLines / LV5.transferLineRef) +
    NS.intercity * Math.min(1, gwServed.length / LV5.intercityRef) +
    NS.crossing * crossing), 0, 100);

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

  /* ⑤ 대체불가능성 10% (V5.1) — 단독역 수(soloShare)는 쓰지 않는다. 이 노선을 철도망에서
     제거하고 핵심지(강남·도심·여의도) 체감 도달시간을 재계산 — 소속 역들의 시간 증가분
     (SV 가중 평균, detourCapMin 포화) = "없어지면 얼마나 우회하나". + 생활권 독점 연결 */
  const reduced = reducedCoreTimes(nm);
  let dSum = 0, wSum = 0;
  for (const s of stArr) {
    const t0 = Math.min(...coreCenters.map(c => (raws[s].jm[c.id] ?? CFG.maxTravelMin)));
    const t1 = Math.min(reduced.get(s) ?? Infinity, CFG.maxTravelMin);
    const delta = clamp((t1 - t0) / LV5.detourCapMin, 0, 1);
    dSum += rows[s].sv * delta; wSum += rows[s].sv;
  }
  const detour = wSum > 0 ? dSum / wSum : 0;
  const hubExShare = hubsServed.length
    ? hubsServed.filter(h => (hubLineNames.get(h.name) || new Set()).size <= LV5.hubExclusiveMaxLines).length / hubsServed.length
    : 0;
  const US = LV5.uniquenessSub;
  const uniqScore = clamp(100 * (US.detour * detour + US.hubExclusive * hubExShare), 0, 100);

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
      share80: Math.round(share80 * 100), otherLines,
      ewKm: Math.round(ewKm), nsKm: Math.round(nsKm),
      detour: Math.round(detour * 100), hubEx: Math.round(hubExShare * 100),
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
/* 허브 축 정규화(전 노선 최대 대비 0~100) → 5축 가중합.
   V5.1: 최종 점수는 raw 그대로 표시 — 작은 실제 차이를 화면에서 압도적 격차로 벌리는
   재스케일(minmax 22~98)을 제거한다. Tier(S/A/B/C)로 근접 점수의 과잉 서열화를 방지 */
const hubMax = Math.max(...linesOut.map(l => l._hubRaw), 0.001);
const LA = LV5.axes;
for (const l of linesOut) {
  const hubScore = clamp(100 * l._hubRaw / hubMax, 0, 100);
  l.breakdown.hub = Math.round(hubScore);
  l.goldenRaw = LA.station * l._station + LA.hub * hubScore + LA.network * l._network + LA.efficiency * l._eff + LA.uniqueness * l._uniq;
  delete l._hubRaw; delete l._station; delete l._network; delete l._eff; delete l._uniq;
  l.golden = Math.round(l.goldenRaw * 10) / 10;
  l.goldenRaw = l.golden;
}
linesOut.sort((a, b) => b.golden - a.golden);
{
  const top = linesOut[0] ? linesOut[0].golden : 0;
  const [s, a, b] = LV5.tierBands;
  for (const l of linesOut) l.tier = l.golden >= top - s ? 'S' : l.golden >= top - a ? 'A' : l.golden >= top - b ? 'B' : 'C';
}

/* ── 저장 — station·line 파일은 반드시 같은 meta(버전·생성시각)로 함께 생성된다 ── */
const meta = {
  updatedAt: NET.meta.asOf, version: 5, generatedAt: new Date().toISOString(),
  method: 'V5.2 — Station Value 4축(교통30/경제력35/교육주거20/업무15). 경제력 = 거주민 경제수준(소득·소비) 추정 등급 w(1~5) 백분위 — 아파트 시세·업무·상권 미사용(순환·이중가중 차단), 시세는 priceLevel(검증용)로만 저장 · Line Value 5축(역세권30/생활권25 한계효용/네트워크20/효율15/대체불가10, 환승 감쇄·raw 표시) — 역·노선 점수 하드코딩 없음',
  status: 'ESTIMATED', stationCount: allStations.length,
  priceLevelCount: [...stationPpm.keys()].length,
  note: '경제력 축은 5단계 추정 등급(ESTIMATED — 역세권 단위 소득·자산 정밀 데이터 미확보, 임의 정밀값 생성 금지). Line Value는 Station Value 평균이 아니며 같은 장점을 여러 축에서 중복 보상하지 않음'
};
fs.writeFileSync(path.join(ROOT, 'data', 'station_intelligence.json'), JSON.stringify({ meta, stations: rows }));
fs.writeFileSync(path.join(ROOT, 'data', 'line_intelligence.json'), JSON.stringify({ meta, lines: linesOut }));

const sorted = allStations.slice().sort((a, b) => rows[b].sv - rows[a].sv);
console.log(`역 ${allStations.length}개 · 노선 ${linesOut.length}개 (V5.2) · 시세 검증지표 보유 ${meta.priceLevelCount}개 역`);
console.log('TOP 12:', sorted.slice(0, 12).map(s => `${s} ${Math.round(rows[s].sv)}`).join(' / '));
/* §2 검증용: 경제력(거주민 등급) vs 주변 시세 수준 괴리 상위 — 시세가 등급 대비 크게
   높거나 낮은 역은 등급 데이터 재검토 후보 (점수에는 미반영, 리포트 전용) */
{
  const gap = allStations.filter(s => rows[s].priceLevel != null)
    .map(s => [s, rows[s].priceLevel - rows[s].comps.econ])
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 8);
  console.log('검증(점수 미반영) 경제력 등급 vs 시세 괴리 상위:', gap.map(([s, d]) => `${s} ${d > 0 ? '+' : ''}${d}`).join(' / '));
}
console.log('노선:', linesOut.map(l => `${l.name} ${l.golden}(${l.tier})`).join(' / '));
for (const l of linesOut) {
  const B = l.breakdown;
  console.log(`  ${l.name}: 역세권 ${B.station}(중앙 ${B.medianDecayed}/상위 ${B.topAvgDecayed}/80+ ${B.share80}%) · 생활권 ${B.hub}(${B.hubs.length}곳) · 네트워크 ${B.network}(환승 ${B.otherLines}·관문 ${B.gateways.length}·횡단 ${B.ewKm}×${B.nsKm}km) · 효율 ${B.efficiency}(${B.kmh}km/h) · 대체불가 ${B.uniqueness}(우회 ${B.detour}) → ${l.golden} ${l.tier}  [${B.hubs.map(h => h.n).join(', ')}]`);
}
const probe = ['압구정', '대치', '잠실', '잠실새내', '신사', '여의도', '광화문', '공덕', '목동', '오목교', '올림픽공원', '둔촌동', '고덕', '강남', '종로3가', '녹번', '중계', '평촌', '수내', '동탄', '성수', '서울역'];
for (const s of probe) if (rows[s]) {
  const c = rows[s].comps;
  console.log(`  ${s}: SV ${rows[s].sv} (${rows[s].rank}위) 교통 ${c.transit} 경제력 ${c.econ}(등급 ${rows[s].econGrade}) 교육주거 ${c.edu} 업무 ${c.biz}${rows[s].priceLevel != null ? ` [시세참고 ${rows[s].priceLevel}]` : ''}`);
}
