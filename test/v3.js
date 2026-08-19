'use strict';
/* V3 검증 + §88 QA 테이블 — 시장기준가/금융지지/미래엔진/판정 + 대표 단지·역 QA */
const fs = require('fs'), path = require('path');
const E = require('../src/engine.js');
const R = p => JSON.parse(fs.readFileSync(path.join(__dirname, '..', p), 'utf8'));
const CFG = R('config/valuation-parameters.json'), HUBS = R('config/education_hubs.json'),
  JOBS = R('config/job_centers.json'), DATA = R('data/apartments.json'),
  STN = R('data/station_intelligence.json'), LINEI = R('data/line_intelligence.json');

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass++; else { fail++; console.error('  ✗ FAIL:', n); } };
const f1 = x => (Math.round(x * 10) / 10).toFixed(1);

/* live 병합 헬퍼 (UI mergeSampleWithLive와 동일 로직) */
const shardCache = {};
function liveMerged(cx0) {
  const cx = JSON.parse(JSON.stringify(cx0));
  if (!cx.regionCode) return cx;
  const p2 = path.join(__dirname, '..', 'data', 'live', cx.regionCode + '.json');
  if (!fs.existsSync(p2)) return cx;
  const sh = shardCache[cx.regionCode] || (shardCache[cx.regionCode] = JSON.parse(fs.readFileSync(p2, 'utf8')));
  const key = Object.keys(sh.complexes).find(k => {
    const [dong, nm] = k.split('|');
    return dong === cx.dong && (nm === cx.name || (cx.aliases || []).some(a => a.replace(/\s/g, '') === nm.replace(/\s/g, '')));
  });
  if (!key) return cx;
  for (const a of cx.areas) {
    const la = sh.complexes[key].areas[a.key];
    if (la && la.trades && la.trades.length) { a.trades = la.trades; if (la.jeonse) a.jeonse = la.jeonse.v; cx.liveLinked = true; }
  }
  return cx;
}
const run = (cx, key) => E.analyze({ complex: cx, areaKey: key, asOfYM: '2026-08', overrides: {} }, CFG, HUBS, JOBS, STN);

/* ── 시장 기준가 (P0-1) ── */
{
  const g = liveMerged(DATA.complexes.find(c => c.id === 'godeok-gracium'));
  ok(g.liveLinked, '고덕그라시움: 국토부 자동수집 실거래 연동됨 (샘플 가짜 거래 대체)');
  const r = run(g, '84');
  ok(r.marketRef && r.marketRef.n >= 3, '시장기준가: 기간창 3건 이상');
  ok(r.marketRef.latest.price !== r.marketRef.med, '최근 실거래 1건 ≠ 시장 기준가 (분리)');
  ok(r.marketRef.latest.date.length === 10, '거래일 완전한 날짜(YYYY-MM-DD) 보존');
  ok(r.currentPrice >= 20, '고덕 84 현재가가 실데이터 수준(20억+) — 데이터 정합성');
  // 이상거래 저가중: 극단 거래 주입해도 기준가가 크게 안 흔들림
  const g2 = JSON.parse(JSON.stringify(g));
  g2.areas.find(a => a.key === '84').trades.unshift({ ym: '2026-08', d: 1, price: 45, floor: 2, o: 1 });
  const r2 = run(g2, '84');
  ok(Math.abs(r2.marketRef.med - r.marketRef.med) / r.marketRef.med < 0.06, `이상거래 플래그 저가중 (중앙값 이동 ${(Math.abs(r2.marketRef.med - r.marketRef.med) / r.marketRef.med * 100).toFixed(1)}%)`);
}

/* ── 금융지지·미래·판정 ── */
{
  const eun = liveMerged(DATA.complexes.find(c => c.id === 'eunma'));
  const r = run(eun, '84');
  ok(r.financial.fsv.low < r.financial.fsv.base && r.financial.fsv.base < r.financial.fsv.high, 'FSV 시나리오 순서');
  ok(r.financial.gScen.low < r.financial.gScen.base && r.financial.gScen.base < r.financial.gScen.high, 'g 시나리오 순서');
  ok(r.future && r.future.score >= 0 && r.future.score <= 100, '미래 5축 점수');
  ok(['낮음', '보통', '높음', '매우 높음'].includes(r.verdicts.expectation.label), '기대 반영도 라벨');
  ok(r.trace && r.trace.length >= 10, 'Calculation Trace 생성');
  // 가격을 낮추면 기대 반영도는 내려가야 (단조성)
  const rLow = E.analyze({ complex: eun, areaKey: '84', asOfYM: '2026-08', overrides: { price: r.currentPrice * 0.7 } }, CFG, HUBS, JOBS, STN);
  ok(rLow.verdicts.expectation.idx <= r.verdicts.expectation.idx, '가격↓ → 기대 반영도 비상승');
  ok(rLow.verdicts.financial.ratio > r.verdicts.financial.ratio, '가격↓ → 금융 지지력 상승');
}

/* ── §81: 좋은 단지가 무조건 고평가/저평가로 나오지 않는다 ── */
{
  const labels = new Set();
  for (const c of DATA.complexes) labels.add(run(liveMerged(c), c.areas[0].key).verdicts.market.label);
  ok(labels.size >= 2, `시장 상대평가가 단지별로 분화 (${[...labels].join('/')})`);
}

/* ── UNKNOWN 제외·재정규화 (§12) ── */
{
  const cx = {
    name: 'U', regionTier: '서울', builtYear: 2015, households: null, brandTier: null, parkingRatio: null, far: null, rentalShare: null,
    redev: { stage: 'none' }, conversionRate: 0.045, dataGaps: [],
    fieldStatus: { price: 'VERIFIED', households: 'UNKNOWN', station: 'UNKNOWN' },
    areas: [{ key: '84', label: '84', m2: 84, jeonse: 8, trades: [{ ym: '2026-07', d: 10, price: 15, floor: 10 }, { ym: '2026-06', d: 5, price: 14.8, floor: 7 }, { ym: '2026-05', d: 20, price: 14.5, floor: 12 }] }],
    location: { unknownTransport: true, subwayMin: null, lines: [], jobMinutes: { GBD: 45 } },
    education: null, life: null, nature: null,
    supply: { pop: 400000, next3yAvg: 2000, adjacentRatio: 1, metroRatio: 1, unsoldLevel: 2, txVolumeLevel: 3, jeonseListingsLevel: 3, jeonseTrend: 'stable', regulated: false }
  };
  const r = run(cx, '84');
  ok(r.hedonic.subs.product == null || isFinite(r.hedonic.subs.product), '상품가치: 세대수·브랜드·주차 미확인 처리');
  ok(r.hedonic.subs.education === null && r.hedonic.subs.life === null && r.hedonic.subs.nature === null, '교육·생활·자연 미확인 → 제외(null)');
  ok(r.structural.excluded.length >= 3, `장기경쟁력: 미확인 ${r.structural.excluded.length}개 축 제외·재정규화`);
  ok(isFinite(r.scores.living.total) && isFinite(r.structural.score), '제외 후에도 전체 분석 정상 완주');
  ok(r.confidence.score < 75, '대량 미확인 → 신뢰도 하락');
}

/* ── 노선·역 구조 검증 — V5.1: 특정 노선 순위를 강제하는 테스트는 두지 않는다(순위는 sanity check로만) ── */
{
  const sv = n => STN.stations[n].sv;
  ok(sv('신사') - sv('녹번') >= 30, `신사(${sv('신사')}) vs 녹번(${sv('녹번')}) 충분히 다름`);
  ok(sv('강남') >= 95, `정규화: 강남 ${sv('강남')} (상위 1% ≈ 95+)`);
  ok(LINEI.lines.every(l => ['S', 'A', 'B', 'C'].includes(l.tier)), '전 노선 Tier(S/A/B/C) 부여');
}

/* ── §88 QA 테이블 출력 ── */
console.log('\n═══ 대표 단지 QA (V3) — 현재가 | 시장기준가 | 금융지지 | 판정(시장/금융/기대) | 장기경쟁력 | 신뢰도 ═══');
for (const c of DATA.complexes) {
  const cx = liveMerged(c);
  const key = cx.areas.find(a => a.key === '84') ? '84' : cx.areas[0].key;
  const r = run(cx, key);
  const m = r.marketRef;
  console.log(
    `${(cx.name + ' ' + key + '㎡').padEnd(18, ' ')} ${f1(r.currentPrice).padStart(5)}억 | ` +
    `${m ? f1(m.low) + '~' + f1(m.high) : '—'} (${m ? m.windowDays + 'd/' + m.n + '건' : ''}) | ` +
    `${f1(r.financial.fsv.low)}~${f1(r.financial.fsv.high)} | ` +
    `${r.verdicts.market.label}/${r.verdicts.financial.label} ${Math.round(r.verdicts.financial.ratio * 100)}%/${r.verdicts.expectation.label} | ` +
    `${r.structural.score}(${r.structural.band}) | ${r.confidence.label}${cx.liveLinked ? ' [실거래연동]' : ' [샘플]'}`);
}
console.log('\n═══ 대표 역 QA (V3 정규화 SV · 강남 체감시간) ═══');
const qaSt = ['강남', '신사', '압구정', '고속터미널', '잠실', '여의도', '서울역', '성수', '판교', '광화문', '녹번', '고덕', '목동', '대치', '수내', '정자', '평촌', '동탄', '중계'];
console.log(qaSt.filter(s => STN.stations[s]).map(s => `${s} ${Math.round(STN.stations[s].sv)}(강남${STN.stations[s].gangnamMin}분)`).join(' · '));
console.log('노선:', LINEI.lines.map(l => `${l.name} ${l.golden}`).join(' / '));

console.log(`\nv3.js  ${pass} pass / ${fail} fail`);
if (fail) process.exit(1);
