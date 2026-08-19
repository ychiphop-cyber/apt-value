'use strict';
/* Station Intelligence 검증 — PRD §48 Test A~E + 엔진 연결 검증
   사전 조작 금지: 모든 값은 계산 결과. 여기서는 "구조적 타당성"만 검증한다. */
const fs = require('fs'), path = require('path');
const E = require('../src/engine.js');
const R = p => JSON.parse(fs.readFileSync(path.join(__dirname, '..', p), 'utf8'));
const CFG = R('config/valuation-parameters.json');
const HUBS = R('config/education_hubs.json');
const JOBS = R('config/job_centers.json');
const DATA = R('data/apartments.json');
const STN = R('data/station_intelligence.json');
const LINEI = R('data/line_intelligence.json');

let pass = 0, fail = 0;
function ok(cond, name) { if (cond) pass++; else { fail++; console.error('  ✗ FAIL:', name); } }
const st = n => STN.stations[n];

/* 기본 무결성 + §33 데이터 정합성 — station/line 파일은 같은 버전·생성시각이어야 한다 */
ok(Object.keys(STN.stations).length > 300, '역 300개 이상 계산됨');
ok(Object.values(STN.stations).every(s => s.sv >= 0 && s.sv <= 100 && isFinite(s.sv)), 'Station Value 0~100');
ok(STN.meta.version === 5 && LINEI.meta.version === 5, `§33: 데이터 버전 V5 (station ${STN.meta.version} / line ${LINEI.meta.version})`);
ok(!!STN.meta.generatedAt && STN.meta.generatedAt === LINEI.meta.generatedAt,
  '§33: station·line intelligence 생성시각 일치 — 구버전 혼합 배포 금지');
ok(LINEI.lines.length >= 10 && LINEI.lines.every(l => l.golden > 0 && l.golden <= 100), '노선 지수 정상');

/* ═══ Line Value V5.1 구조 검증 — 순위를 테스트하지 않는다. 구조만 검증한다:
   ① 환승역 편승 감쇄 적용 ② 생활권 한계효용 체감 적용 ③ 긴 노선 직접 가산 없음
   ④ soloShare(단독역 수) 제거 ⑤ 동일 데이터 재현성 ═══ */
{
  const L5 = CFG.station.lineV5;
  const sum = o => Object.values(o).reduce((a, b) => a + b, 0);
  ok(Math.abs(sum(L5.axes) - 1) < 1e-9, 'LV5.1: 5축 가중치 합 = 1');
  const AX = ['station', 'hub', 'network', 'efficiency', 'uniqueness'];
  ok(LINEI.lines.every(l => l.breakdown && AX.every(k => isFinite(l.breakdown[k]) && l.breakdown[k] >= 0 && l.breakdown[k] <= 100)),
    'LV5.1: 전 노선 5축(역세권·생활권·네트워크·효율·대체불가) 0~100 저장');
  ok(LINEI.lines.every(l => Array.isArray(l.breakdown.hubs)), 'LV5.1: 연결 생활권 목록 저장');

  /* ④ soloShare 제거 — 설정·산출물 어디에도 단독역 수 지표가 없다 */
  ok(!('soloShare' in L5.uniquenessSub) && 'detour' in L5.uniquenessSub,
    'LV5.1 ④: uniqueness는 우회시간(detour) 기반 — soloShare(단독역 수) 제거');
  ok(LINEI.lines.every(l => !('soloShare' in l.breakdown) && isFinite(l.breakdown.detour)),
    'LV5.1 ④: breakdown에 soloShare 없음 · 우회 부담(detour) 저장');

  /* ② 한계효용 체감 설정 존재 + ⑤ 재현: 생활권 축을 동일 데이터로 재계산하면 일치 */
  ok(L5.hubDiminish > 0 && L5.hubDiminish < 1, `LV5.1 ②: 생활권 한계효용 체감 계수 ${L5.hubDiminish} (<1)`);
  const NETL = R('data/rail_network.json').lines;
  const LIFE = R('config/life_hubs.json');
  const groups = new Map();
  for (const l of NETL) {
    const nm = l.name.replace(' 급행', '');
    if (!groups.has(nm)) groups.set(nm, new Set());
    l.stations.forEach(s => groups.get(nm).add(s));
  }
  const lineNamesOf = new Map();
  for (const l of NETL) {
    if (l.overlay) continue;
    for (const s of l.stations) { if (!lineNamesOf.has(s)) lineNamesOf.set(s, new Set()); lineNamesOf.get(s).add(l.name); }
  }
  const decayOf = s => L5.transferDecay[String(Math.min(3, Math.max(1, (lineNamesOf.get(s) || new Set()).size)))] ?? 1;
  const hubOf = new Map();
  for (const h of LIFE.hubs) for (const s of h.stations) if (!hubOf.has(s)) hubOf.set(s, h);
  const med = a => { const x = a.slice().sort((p, q) => p - q); const n = x.length; return n % 2 ? x[(n - 1) / 2] : (x[n / 2 - 1] + x[n / 2]) / 2; };
  const hubRawOf = nm => {
    const stArr = [...groups.get(nm)];
    const hubStns = new Map();
    for (const s of stArr) { const h = hubOf.get(s); if (h) { if (!hubStns.has(h)) hubStns.set(h, []); hubStns.get(h).push(s); } }
    return [...hubStns.keys()].map(h => {
      const a = hubStns.get(h);
      const depth = a.length >= Math.min(2, h.stations.length) ? 1 : L5.hubDepthPartial;
      const decay = a.reduce((x, s) => x + decayOf(s), 0) / a.length;
      return (L5.hubTierCoef[String(h.tier)] ?? 0.5) * depth * decay;
    }).sort((a, b) => b - a).reduce((a, c, i) => a + c * Math.pow(L5.hubDiminish, i), 0);
  };
  const hubMax = Math.max(...[...groups.keys()].map(hubRawOf));
  let hubRepro = true, stRepro = true, scoreRepro = true;
  for (const l of LINEI.lines) {
    const stArr = [...groups.get(l.name)];
    // ⑤·② 생활권 축 재현 (체감 적용 공식 그대로)
    const hubScore = Math.round(100 * hubRawOf(l.name) / hubMax);
    if (Math.abs(hubScore - l.breakdown.hub) > 1) { hubRepro = false; console.error(`  ↳ ${l.name} 생활권 재현 실패: ${hubScore} vs ${l.breakdown.hub}`); }
    // ⑤·① 역세권 축 재현 — 환승 감쇄가 실제 적용되어야만 일치한다
    const dsv = stArr.map(s => st(s).sv * decayOf(s)).sort((a, b) => a - b);
    const topN = Math.max(2, Math.ceil(dsv.length * 0.25));
    const topAvg = dsv.slice(-topN).reduce((a, b) => a + b, 0) / topN;
    const share80 = stArr.filter(s => st(s).sv >= L5.share80Threshold).length / dsv.length;
    const SS = L5.stationSub;
    const stScore = Math.round(Math.min(100, Math.max(0, SS.median * med(dsv) + SS.topQuartile * topAvg + SS.share80 * share80 * 100)));
    if (Math.abs(stScore - l.breakdown.station) > 1) { stRepro = false; console.error(`  ↳ ${l.name} 역세권 재현 실패: ${stScore} vs ${l.breakdown.station}`); }
    // ③ 최종 점수 = 5축 가중합뿐 (길이 등 숨은 가산 없음 + raw 그대로, 재스케일 없음)
    const recon = L5.axes.station * l.breakdown.station + L5.axes.hub * l.breakdown.hub + L5.axes.network * l.breakdown.network + L5.axes.efficiency * l.breakdown.efficiency + L5.axes.uniqueness * l.breakdown.uniqueness;
    if (Math.abs(recon - l.golden) > 1.2) { scoreRepro = false; console.error(`  ↳ ${l.name} 점수 재현 실패: ${recon.toFixed(1)} vs ${l.golden}`); }
  }
  ok(hubRepro, 'LV5.1 ②⑤: 생활권 축(한계효용 체감 포함) 동일 데이터 재현 일치');
  ok(stRepro, 'LV5.1 ①⑤: 역세권 축(환승 편승 감쇄 포함) 동일 데이터 재현 일치');
  ok(scoreRepro, 'LV5.1 ③⑤: 최종 점수 = 5축 가중합 그대로 — 노선 길이 직접 가산·재스케일 없음');
  ok(LINEI.lines.every(l => ['S', 'A', 'B', 'C'].includes(l.tier)), 'LV5.1: Tier(S/A/B/C) 부여');
}

/* Test A — 같은 3호선: 신사 vs 녹번, 차이가 4축 컴포넌트로 설명 가능해야 */
{
  const a = st('신사'), b = st('녹번');
  ok(a.sv > b.sv + 15, 'A: 신사 SV가 녹번보다 뚜렷이 높음');
  ok(a.comps.transit > b.comps.transit && a.comps.econ > b.comps.econ && a.comps.biz > b.comps.biz,
    'A: 차이가 교통·경제력·업무 축으로 설명됨');
  ok(a.gangnamMin < b.gangnamMin, 'A: 강남 접근시간 차이 반영');
}

/* Test A2 — V4 구조: 4축 존재·범위, 가중치 정합, 가치평가용 블렌드의 중복 축소 */
{
  const V4 = CFG.station.v4;
  const sum = o => Object.values(o).reduce((a, b) => a + b, 0);
  ok(Math.abs(sum(V4.axes) - 1) < 1e-9, 'A2: 표시용 4축 가중치 합 = 1');
  ok(Math.abs(sum(V4.axesForValuation) - 1) < 1e-9, 'A2: 가치평가용 블렌드 가중치 합 = 1');
  ok(V4.axesForValuation.econ < V4.axes.econ && V4.axesForValuation.edu < V4.axes.edu,
    'A2: 가치평가용 블렌드는 경제력·교육 축 축소 (아파트 자체 실거래·교육점수와 중복 방지)');
  ok(Object.values(STN.stations).every(s => ['transit', 'econ', 'edu', 'biz'].every(k =>
    s.comps[k] >= 0 && s.comps[k] <= 100 && isFinite(s.comps[k]))), 'A2: 전 역 4축 0~100');
  ok(Object.values(STN.stations).some(s => s.econSrc === 'live') &&
    Object.values(STN.stations).some(s => s.econSrc === 'manual'), 'A2: 경제력 실거래/폴백 출처 구분 저장');
}

/* Test A3 — §16 주거·교육·자산 강지역이 업무 유동인구 없이도 합리적으로 평가 */
{
  const total = Object.keys(STN.stations).length;
  for (const n of ['대치', '목동', '고덕', '올림픽공원', '평촌', '수내'])
    ok(st(n).rank <= total * 0.40, `A3: ${n} 상위 40% 이내 (${st(n).rank}위/${total})`);
  ok(st('대치').rank <= total * 0.10, `A3: 대치 상위 10% 이내 (${st('대치').rank}위)`);
  ok(st('대치').comps.edu >= 90, `A3: 대치 교육·주거 축 최상위 (${st('대치').comps.edu})`);
  ok(st('압구정').rank < st('서울역').rank, 'A3: 압구정(주거 최상급) > 서울역(업무 중심) — 업무축만으로 최상위 불가');
}

/* Test A4 — V5 경제력: 단지 단위 표본·규모 필터 구조 확인 */
{
  ok(Object.values(STN.stations).filter(s => s.econSrc === 'live').every(s => s.econN >= CFG.station.v4.econMinSamples),
    'A4: 실거래 기반 역은 최소 단지 표본 이상');
  // 잠실새내(잠실주공5 재건축 초고가 ㎡가 이슈): 단지당 1표 중앙값이라 재건축 1곳이 역 점수를 지배하지 못함
  ok(st('잠실새내').comps.econ <= st('압구정').comps.econ, `A4: 잠실새내 경제력(${st('잠실새내').comps.econ}) ≤ 압구정(${st('압구정').comps.econ}) — 단일 재건축 단지 지배 방지`);
  // 목동: 나홀로 소형 단지가 다수라도 규모(매매+전세 거래량) 가중으로 신시가지가 대표성 유지
  ok(st('목동').comps.econ >= 50, `A4: 목동 경제력 ${st('목동').comps.econ} — 소형 단지 희석 방지(규모 가중)`);
}

/* Test B — 가치 높은 단일노선 역 > 가치 낮은 노선 환승역 (환승 개수만으로 승리 금지) */
{
  const single = st('압구정');      // 3호선 단일
  const weakTransfer = st('석계');  // 1호선+6호선 환승, 외곽
  ok(single.sv > weakTransfer.sv, `B: 압구정(단일 ${single.sv}) > 석계(환승 ${weakTransfer.sv})`);
  const single2 = st('한티');       // 수인분당 단일, 강남권
  const weakTransfer2 = st('온수'); // 1+7 환승 외곽
  ok(single2.sv > weakTransfer2.sv, `B: 한티(단일 ${single2.sv}) > 온수(환승 ${weakTransfer2.sv})`);
}

/* Test C·D — 더블역세권: 같은 방향이면 보너스 작고, 다른 업무지를 열면 커야 */
{
  const mk = (p, s) => ({
    name: 'T', regionTier: '서울', builtYear: 2015, households: 1000, brandTier: 2, parkingRatio: 1, far: 250, rentalShare: 0,
    redev: { stage: 'none' }, conversionRate: 0.045,
    stationLink: { primary: p, secondary: s },
    areas: [{ key: '84', label: '84', m2: 84, jeonse: 8, trades: [{ ym: '2026-07', price: 15, floor: 10 }] }],
    location: { subwayMin: p.min, lines: [], transfer: false, express: false, futureTransit: null, jobMinutes: {} },
    education: { elemM: 500, chopuma: false, middlePref: 3, hubId: null, inHub: false, localAcademyLevel: 3, hubAccess: [], age3049: 0.3, studentTrend: 'stable' },
    life: { martMin: 10, deptMin: 20, hospitalMin: 15, streetLevel: 3 },
    nature: { parkMin: 10, bigPark: false, riverMin: 30, hanRiver: false, hanRiverView: null, forest: false },
    supply: { pop: 400000, next3yAvg: 2000, adjacentRatio: 1, metroRatio: 1, unsoldLevel: 2, txVolumeLevel: 3, jeonseListingsLevel: 3, jeonseTrend: 'stable', regulated: false }
  });
  const run = cx => E.analyze({ complex: cx, areaKey: '84', asOfYM: '2026-08', overrides: {} }, CFG, HUBS, JOBS, STN);
  // C: 목동(5호선) + 오목교(5호선 같은 노선·같은 방향) → 보너스 거의 0
  const same = run(mk({ st: '목동', min: 7, status: 'VERIFIED' }, { st: '오목교', min: 10 }));
  ok(same.transit.bonus < 0.03, `C: 같은 방향 추가역 보너스 미미 (${(same.transit.bonus * 100).toFixed(1)}%)`);
  // D: 목동(5호선, CBD·여의도·마곡) + 신정(2호선 아님... 신정도 5호선) → 대신: 애오개(5호선) vs 공덕(5+6+공항+경의: 용산 등 확장)
  const solo = run(mk({ st: '애오개', min: 4, status: 'VERIFIED' }, null));
  const dual = run(mk({ st: '애오개', min: 4, status: 'VERIFIED' }, { st: '공덕', min: 9 }));
  ok(dual.transit.bonus >= same.transit.bonus, 'D: 네트워크 확장형 추가역 보너스가 동일방향보다 큼·같음');
  ok(dual.hedonic.subs.transport >= solo.hedonic.subs.transport, 'D: 확장형 더블역세권은 교통점수 상승');
  ok(dual.transit.bonus <= CFG.station.multiStation.totalBonusCap + 1e-9, 'D: 보너스 총량 캡 준수');
}

/* Test E — 경제력 높음·교통 보통 vs 경제력 보통·교통 탁월: 다른 프로필로 설명 */
{
  const rich = st('압구정');   // 경제력 최상
  const hub = st('서울역');    // 교통·업무 탁월, 주거 경제력 낮음
  ok(rich.comps.econ > hub.comps.econ && hub.comps.transit >= rich.comps.transit,
    `E: 압구정(경제력 ${rich.comps.econ}·교통 ${rich.comps.transit}) vs 서울역(경제력 ${hub.comps.econ}·교통 ${hub.comps.transit}) 프로필 상이`);
}

/* 대표역 스팟체크 — 순서 타당성 (사전 점수 조작 없음, 관계만 검증) */
ok(st('강남').sv >= 90 && st('신사').sv >= 90, '강남·신사 최상위권(90+)');
ok(st('신사').sv > st('수내').sv, '신사 > 수내');
ok(st('판교').sv > st('평촌').sv, '판교 > 평촌');
ok(st('잠실').sv > st('고덕').sv, '잠실 > 고덕');
ok(st('여의도').sv > st('목동').sv, '여의도 > 목동');
ok(st('고속터미널').sv > st('녹번').sv, '고속터미널 > 녹번');

/* 엔진 연결: 샘플 단지 교통이 Station 기반으로 교체되고 캡·중복가산 방지 유지 */
{
  const cx = DATA.complexes.find(c => c.id === 'eunma');
  const r = E.analyze({ complex: cx, areaKey: '84', asOfYM: '2026-08', overrides: {} }, CFG, HUBS, JOBS, STN);
  ok(!!r.transit && r.transit.primary.st === '대치', '은마: 주력역 대치 연결');
  ok(r.hedonic.subs.transport === r.transit.score, '교통점수 = Station 기반 점수로 교체(가산 아님)');
  ok(Math.abs(r.hedonic.total) <= CFG.hedonic.totalCap + 1e-9, '히도닉 총량 캡 유지');
  ok(r.explain.diagnosis && r.explain.diagnosis.core && r.explain.diagnosis.watch, '진단형 문장 생성');
  // STN 없이 호출하면 기존 방식으로 정상 폴백
  const legacy = E.analyze({ complex: cx, areaKey: '84', asOfYM: '2026-08', overrides: {} }, CFG, HUBS, JOBS);
  ok(!legacy.transit && legacy.hedonic.subs.transport > 0, 'STN 없음 → 기존 로직 폴백 정상');
}

/* 미확인 처리: 역 정보 없는 자동 단지 → 중립점수 + 신뢰도 하락, 서비스는 정상 */
{
  const cx = {
    name: 'U', regionTier: '서울', builtYear: 2010, households: 700, brandTier: 2, parkingRatio: 0.9, far: 250, rentalShare: 0,
    redev: { stage: 'none' }, conversionRate: 0.045, dataGaps: ['역거리 미확인'],
    fieldStatus: { households: 'UNKNOWN', subway: 'UNKNOWN', price: 'VERIFIED' },
    areas: [{ key: '84', label: '84', m2: 84, jeonse: 6, trades: [{ ym: '2026-07', price: 11, floor: 5 }] }],
    location: { unknownTransport: true, subwayMin: null, lines: [], transfer: false, express: false, futureTransit: null, jobMinutes: { GBD: 45, CBD: 50 } },
    education: { elemM: 500, chopuma: false, middlePref: 3, hubId: null, inHub: false, localAcademyLevel: 3, hubAccess: [], age3049: 0.3, studentTrend: 'stable' },
    life: { martMin: 10, deptMin: 20, hospitalMin: 15, streetLevel: 3 },
    nature: { parkMin: 10, bigPark: false, riverMin: 30, hanRiver: false, hanRiverView: null, forest: false },
    supply: { pop: 400000, next3yAvg: 2000, adjacentRatio: 1, metroRatio: 1, unsoldLevel: 2, txVolumeLevel: 3, jeonseListingsLevel: 3, jeonseTrend: 'stable', regulated: false }
  };
  const r = E.analyze({ complex: cx, areaKey: '84', asOfYM: '2026-08', overrides: {}, autoComplex: true }, CFG, HUBS, JOBS, STN);
  ok(r.hedonic.subs.transport === null, '미확인 역거리 → 항목 제외(null) — 중립값으로 몰래 대체 금지(V3 §12)');
  ok(r.scores.living.total > 0 && isFinite(r.scores.living.total), '교통 제외 후 주거가치 재정규화 정상');
  ok(r.gaps.some(g => g.includes('역거리 미확인')), '미확인이 데이터 공백에 기록');
  ok(r.dataStatus && r.dataStatus.UNKNOWN === 2 && r.dataStatus.VERIFIED === 1, '필드 상태 집계(VERIFIED/UNKNOWN)');
  ok(isFinite(r.combineOut.center) && r.range.low > 0, '미확인 상태에서도 전체 분석 정상 완주');
}

console.log(`station.js  ${pass} pass / ${fail} fail`);
if (fail) process.exit(1);
