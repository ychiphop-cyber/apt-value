'use strict';
/* PRD 69 완료기준 — 전 샘플 단지 × 전 평형이 오류 없이 완주하고 결과가 정상 범위인지 회귀 검증 */
const fs = require('fs'), path = require('path');
const E = require('../src/engine.js');
const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/valuation-parameters.json'), 'utf8'));
const HUBS = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/education_hubs.json'), 'utf8'));
const JOBS = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/job_centers.json'), 'utf8'));
const DATA = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/apartments.json'), 'utf8'));
const STN = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/station_intelligence.json'), 'utf8'));

let fail = 0, n = 0;
const finite = x => typeof x === 'number' && isFinite(x);
const rows = [];

for (const cx of DATA.complexes) {
  for (const area of cx.areas) {
    n++;
    const label = `${cx.name} ${area.key}㎡`;
    try {
      const r = E.analyze({ complex: cx, areaKey: area.key, asOfYM: DATA.meta.asOf, overrides: {} }, CFG, HUBS, JOBS, STN);
      const checks = [
        [finite(r.currentPrice) && r.currentPrice > 0, '현재가'],
        [finite(r.range.low) && r.range.low > 0 && r.range.low < r.range.high, '범위'],
        [Math.abs(r.combineOut.center / r.market.value - 1) <= CFG.final.extremeGuard + 1e-9, 'Extreme Guard'],
        [typeof r.combineOut.divergence === 'number' && isFinite(r.combineOut.divergence), '괴리 지표'],
        [r.scores.living.total >= 30 && r.scores.living.total <= 100, '주거가치 정상범위'],
        [r.scores.invest.total >= 20 && r.scores.invest.total <= 100, '투자가치 정상범위'],
        [r.scores.attract.score >= 15 && r.scores.attract.score <= 95, '가격매력도 정상범위'],
        [!!r.scores.attract.positionLabel, '가격 판단 라벨'],
        [!!r.confidence.label, '신뢰도'],
        [r.explain.up.length > 0 && r.explain.down.length > 0, '요인'],
        [r.explain.interpretation.length > 0, '해석'],
        [!!r.support.label, '전세지지력'],
        [!!r.supplyE.gradeLabel, '수급 등급'],
        [Object.values(r.hedonic.subs).every(s => finite(s) && s >= 0 && s <= 100), '히도닉 하위점수']
      ];
      // 스트레스 프리셋 전체 각각 + 복합 1회
      for (const p of CFG.stress.presets) {
        const sr = E.applyStress({ complex: cx, areaKey: area.key, asOfYM: DATA.meta.asOf, overrides: {} }, [p.id], CFG, HUBS, JOBS, STN);
        checks.push([finite(sr.combineOut.center) && sr.range.low > 0, `스트레스 ${p.id}`]);
      }
      const bad = checks.filter(c => !c[0]);
      if (bad.length) { fail++; console.error(`✗ ${label}: ${bad.map(b => b[1]).join(', ')}`); }
      rows.push([label, r.currentPrice.toFixed(1), `${r.range.low.toFixed(1)}~${r.range.high.toFixed(1)}`,
        r.scores.attract.positionLabel, r.scores.living.total.toFixed(0), r.scores.invest.total.toFixed(0),
        String(r.scores.attract.score), r.support.label, r.supplyE.gradeLabel, r.option.gradeLabel, r.confidence.label]);
    } catch (e) {
      fail++; console.error(`✗ ${label}: 예외 — ${e.message}`);
    }
  }
}

// 요약표
const head = ['단지·평형', '현재가', '적정범위', '판단', '주거', '투자', '매력', '전세지지', '수급', '미래옵션', '신뢰도'];
const w = head.map((h, i) => Math.max(h.length * 2, ...rows.map(r => String(r[i]).replace(/[가-힣]/g, 'xx').length)) + 1);
console.log(head.map((h, i) => h.padEnd(Math.max(6, w[i] - h.replace(/[^가-힣]/g, '').length))).join(''));
for (const r0 of rows) console.log(r0.map((c, i) => String(c).padEnd(Math.max(6, w[i] - String(c).replace(/[^가-힣]/g, '').length))).join(''));

console.log(`cases.js  ${n}개 사례 중 ${n - fail} 통과 / ${fail} 실패`);
if (fail) process.exit(1);
