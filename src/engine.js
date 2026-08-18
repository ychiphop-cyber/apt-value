'use strict';
/* ═══════════════════════════════════════════════════════════════════
   닥터마빈 아파트 가치진단 — 가치평가 엔진 (순수함수, Node 테스트 가능)
   Engine A 시장 상대가치 · B 금융·임대 내재가치 · C 주거·입지·상품
   Engine D 수요·공급·시장구조 · E 미래 옵션가치 → 하이브리드 결합
   모든 계수는 CFG(config/valuation-parameters.json)에서만 온다.
   가격 단위: 억원 / 월세: 만원 / 비율: 소수 / 시간: 분
   ═══════════════════════════════════════════════════════════════════ */

const AptEngine = (() => {

  /* ── 공용 유틸 ── */
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const round1 = x => Math.round(x * 10) / 10;

  function ymToNum(ym) { const [y, m] = ym.split('-').map(Number); return y * 12 + (m - 1); }
  function monthsBetween(nowYM, ym) { return Math.max(0, ymToNum(nowYM) - ymToNum(ym)); }

  // 구간 선형보간: points = [[x,y],...] (x 오름차순)
  function interp(x, points) {
    if (x <= points[0][0]) return points[0][1];
    for (let i = 1; i < points.length; i++) {
      if (x <= points[i][0]) {
        const [x0, y0] = points[i - 1], [x1, y1] = points[i];
        return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
      }
    }
    return points[points.length - 1][1];
  }

  function weightedPercentile(items, p) { // items: [{v,w}]
    const arr = items.slice().sort((a, b) => a.v - b.v);
    const total = arr.reduce((s, it) => s + it.w, 0);
    if (total <= 0) return NaN;
    let acc = 0;
    for (const it of arr) {
      acc += it.w;
      if (acc / total >= p) return it.v;
    }
    return arr[arr.length - 1].v;
  }
  const weightedMedian = items => weightedPercentile(items, 0.5);

  /* ═══════════ Engine A · 시장 상대가치 ═══════════ */
  function engineMarket(cx, area, input, CFG) {
    const M = CFG.market, now = input.asOfYM;
    const comps = [];
    const pushTrade = (t, sim, adjPrice, tier, label) => {
      const age = monthsBetween(now, t.ym);
      if (age > M.maxCompAgeMonths) return;
      const w = sim * Math.pow(0.5, age / M.compHalfLifeMonths);
      comps.push({ v: adjPrice, w, tier, ym: t.ym, raw: t.price, label });
    };
    // ① 동일 단지 동일 평형
    for (const t of (area.trades || [])) pushTrade(t, M.tierSimilarity.sameComplexSameArea, t.price, 1, '동일단지 동일평형');
    // ② 동일 단지 유사 평형 (면적 탄력 보정)
    for (const a2 of cx.areas) {
      if (a2.key === area.key) continue;
      for (const t of (a2.trades || [])) {
        const adj = t.price * Math.pow(area.m2 / a2.m2, M.areaElasticity);
        pushTrade(t, M.tierSimilarity.sameComplexOtherArea, adj, 2, `동일단지 ${a2.label}`);
      }
    }
    // ③ 인근 유사 단지 (특성 보정 — 보정폭 캡)
    for (const cp of (cx.comparables || [])) {
      const fd = clamp(cp.featureDelta || 0, -M.featureAdjCapTotal, M.featureAdjCapTotal);
      for (const t of (cp.trades || [])) {
        const adj = t.price * (1 + fd) * Math.pow(area.m2 / cp.m2, M.areaElasticity);
        pushTrade(t, M.tierSimilarity.nearbyComplex, adj, 3, cp.name);
      }
    }
    const totW = comps.reduce((s, c) => s + c.w, 0);
    const w1 = comps.filter(c => c.tier === 1).reduce((s, c) => s + c.w, 0);
    const value = comps.length ? weightedMedian(comps) : null;
    const p25 = comps.length ? weightedPercentile(comps, 0.25) : null;
    const p75 = comps.length ? weightedPercentile(comps, 0.75) : null;
    const dispersion = (value && p75 != null && p25 != null && value > 0) ? Math.max(0, (p75 - p25) / value / 2) : 0.05;
    // 최신성: tier1 우선, 없으면 전체
    const t1 = comps.filter(c => c.tier === 1);
    const latestMonths = (t1.length ? t1 : comps).reduce((m, c) => Math.min(m, monthsBetween(now, c.ym)), 99);
    return {
      value, p25, p75, dispersion,
      comps, compCount: comps.filter(c => c.tier === 1).length, compCountAll: comps.length,
      compQuality: totW > 0 ? w1 / totW : 0,   // 1.0 = 전부 동일단지 동일평형
      latestMonths, enough: comps.filter(c => c.tier === 1).length >= M.minCompsForAnchor
    };
  }

  /* ═══════════ Engine B · 금융·임대 내재가치 ═══════════ */
  function engineFinancial(cx, area, input, CFG, currentPrice) {
    const F = CFG.financial;
    const rateDelta = input.overrides.rateDelta || 0;
    const jeonse = (input.overrides.jeonse != null ? input.overrides.jeonse : area.jeonse) * (input.overrides.jeonseMul || 1);
    const conv = (cx.conversionRate || F.defaultConversionRate) + rateDelta * 0.5; // 금리 상승 시 전환율도 일부 동행
    // 연간 주거서비스 가치 R
    let R, rSourceText;
    if (input.useRent && area.rentExample) {
      R = area.rentExample.rent * 12 / 10000 + area.rentExample.deposit * conv;
      rSourceText = `월세 ${area.rentExample.rent}만 × 12 + 보증금 ${area.rentExample.deposit}억 × 전환율 ${(conv * 100).toFixed(1)}%`;
    } else {
      R = jeonse * conv;
      rSourceText = `전세 ${round1(jeonse)}억 × 시장 전월세전환율 ${(conv * 100).toFixed(1)}%`;
    }
    // 요구수익률 r (합성) + 장기 임대가치 성장률 g
    const r = F.altReturn + F.liquidityPremium + F.assetRiskPremium + (F.regionRiskPremium[cx.regionTier] ?? F.regionRiskPremium['기타']) + rateDelta;
    const g = F.longTermRentGrowth[cx.regionTier] ?? F.longTermRentGrowth['기타'];
    // 고든 성장모형 가드: r-g가 비정상적으로 근접하면 유한 DCF로 대체
    let value, mode;
    if (r - g >= F.minSpread) { value = R / (r - g); mode = 'gordon'; }
    else {
      let pv = 0;
      for (let t = 1; t <= F.dcfYears; t++) pv += R * Math.pow(1 + g, t - 1) / Math.pow(1 + r, t);
      value = pv; mode = 'dcf';
    }
    // 역산: 현재가 유지에 필요한 성장률
    const impliedG = currentPrice > 0 ? r - R / currentPrice : null;
    const jeonseRatio = currentPrice > 0 ? jeonse / currentPrice : null;
    const equity = currentPrice - jeonse;
    return { R, r, g, conv, mode, value, impliedG, jeonse, jeonseRatio, equity, rSourceText };
  }

  /* 전세지지력 (5등급) */
  function jeonseSupport(fin, sup, combinedBurden, CFG) {
    const J = CFG.jeonseSupport;
    const ratio = fin.jeonseRatio ?? 0;
    let idx = J.ratioBands.length; // 기본 최하
    for (let i = 0; i < J.ratioBands.length; i++) if (ratio >= J.ratioBands[i]) { idx = i; break; }
    let score = [90, 75, 60, 45, 30][idx];
    const factors = [`전세가율 ${(ratio * 100).toFixed(0)}%`];
    const tAdj = (J.trendAdj[sup.jeonseTrend] ?? 0) * 6;
    if (tAdj) { score += tAdj; factors.push(`전세가격 ${sup.jeonseTrend === 'up' ? '상승세' : '하락세'}`); }
    const lAdj = (J.listingsAdj[String(sup.jeonseListingsLevel ?? 3)] ?? 0) * 6;
    if (lAdj) { score += lAdj; factors.push(`전세 매물 ${sup.jeonseListingsLevel <= 2 ? '적음' : '많음'}`); }
    if (combinedBurden >= J.supplyBurdenAdjOver) { score -= 8; factors.push('향후 공급 부담'); }
    score = clamp(score, 0, 100);
    const gIdx = score >= 80 ? 0 : score >= 65 ? 1 : score >= 50 ? 2 : score >= 35 ? 3 : 4;
    return { score, gradeIdx: gIdx, label: J.gradeLabels[gIdx], factors };
  }

  /* ═══════════ Engine C · 주거·입지·상품가치 ═══════════ */
  function engineHedonic(cx, area, input, CFG, HUBS, JOBS, gaps) {
    const H = CFG.hedonic, E = CFG.education;
    const loc = cx.location, edu = cx.education, life = cx.life, nat = cx.nature;
    const notes = {};

    // 교통
    let transport = interp(loc.subwayMin, [[2, 96], [5, 88], [8, 78], [12, 64], [15, 55], [20, 42], [30, 30]]);
    const tN = [`지하철 도보 ${loc.subwayMin}분`];
    if (loc.transfer) { transport += 5; tN.push('환승 접근'); }
    if (loc.express) { transport += 5; tN.push('급행·광역'); }
    if ((loc.lines || []).length >= 2) { transport += 3; tN.push('복수 노선'); }
    if (loc.futureTransit) {
      const confirmed = /확정|공사/.test(loc.futureTransit);
      transport += confirmed ? 4 : 1;
      tN.push(`${loc.futureTransit}${confirmed ? '' : ' — 미확정은 제한 반영'}`);
    }
    transport = clamp(transport, 0, 100); notes.transport = tN;

    // 직주근접 (Job Accessibility = Σ 규모 × e^(−t/τ))
    let ja = 0; const jN = [];
    for (const c of JOBS.centers) {
      const t = (loc.jobMinutes || {})[c.id] ?? 75;
      ja += c.jobsIndex * Math.exp(-t / H.jobDecayTau);
      if (t <= 30) jN.push(`${c.name} ${t}분`);
    }
    const job = clamp(100 * ja / H.jobRefAccess, 0, 100);
    notes.job = jN.length ? [`30분 내 업무지: ${jN.join(' · ')}`] : ['30분 내 주요 업무지 없음'];

    // 교육 (4개 하위 모듈)
    const elemBase = edu.elemM <= 300 ? 95 : edu.elemM <= 500 ? 85 : edu.elemM <= 800 ? 72 : 55;
    const school = clamp(0.45 * (elemBase + (edu.chopuma ? 3 : 0)) + 0.55 * [40, 55, 70, 84, 95][(edu.middlePref || 3) - 1], 0, 100);
    const hub = edu.inHub && edu.hubId ? HUBS.hubs.find(h => h.id === edu.hubId) : null;
    const academy = hub ? hub.initial_strength
      : (E.localAcademyScore[String(edu.localAcademyLevel || 2)] ?? 50);
    const accessCands = [];
    if (hub) accessCands.push({ v: hub.initial_strength, tier: hub.tier });
    for (const ha of (edu.hubAccess || [])) {
      const h2 = HUBS.hubs.find(h => h.id === ha.hubId);
      if (!h2) continue;
      const dec = E.accessDecay.find(d => ha.min <= d.maxMin);
      accessCands.push({ v: h2.initial_strength * (dec ? dec.factor : 0.25), tier: h2.tier });
    }
    if (!accessCands.length) accessCands.push({ v: academy * 0.7, tier: 4 });
    accessCands.sort((a, b) => b.v - a.v);
    const access = clamp(accessCands[0].v, 0, 100);
    let demand = interp(edu.age3049 || 0.28, [[0.24, 45], [0.27, 58], [0.30, 72], [0.33, 84], [0.36, 92]]);
    demand += edu.studentTrend === 'up' ? 5 : edu.studentTrend === 'down' ? -7 : 0;
    demand = clamp(demand, 0, 100);
    const eduScore = E.subWeights.school * school + E.subWeights.academy * academy + E.subWeights.access * access + E.subWeights.demand * demand;
    // 지역 교육 계수 (대치 500m ≠ 일반도시 500m)
    const coeffTier = hub ? hub.tier : Math.min(4, (accessCands[0].tier || 4) + 1);
    const eduCoeff = E.coefficientByTier[String(coeffTier)] ?? 0.55;
    notes.education = [
      `학교환경 ${Math.round(school)} · 학원가 ${Math.round(academy)} · 교육접근성 ${Math.round(access)} · 수요지속성 ${Math.round(demand)}`,
      hub ? `${hub.hub_name} 허브 생활권 (계수 ×${eduCoeff})` : `주요 교육 허브 비생활권 (계수 ×${eduCoeff})`
    ];

    // 생활편의
    const lifeScore = clamp(
      0.35 * interp(life.martMin, [[5, 90], [10, 80], [15, 68], [30, 55]]) +
      0.25 * interp(life.deptMin, [[5, 92], [10, 84], [15, 74], [25, 62], [40, 50]]) +
      0.20 * interp(life.hospitalMin, [[5, 90], [10, 80], [15, 70], [25, 58], [40, 48]]) +
      0.20 * [40, 55, 68, 80, 92][(life.streetLevel || 3) - 1], 0, 100);
    notes.life = [`마트 ${life.martMin}분 · 백화점 ${life.deptMin}분 · 병원 ${life.hospitalMin}분`];

    // 자연환경 (한강 접근 ≠ 한강 조망 — 조망 데이터 없으면 제외)
    const parkComp = nat.bigPark ? interp(nat.parkMin, [[5, 92], [10, 84], [15, 72], [30, 55]])
      : interp(nat.parkMin, [[5, 80], [10, 72], [15, 62], [30, 50]]);
    let riverComp = nat.hanRiver ? interp(nat.riverMin, [[10, 95], [15, 88], [25, 75], [40, 60]])
      : interp(nat.riverMin, [[10, 72], [20, 60], [40, 50]]);
    const natN = [`공원 ${nat.parkMin}분${nat.bigPark ? ' (대형)' : ''}`];
    if (nat.hanRiver) natN.push(`한강 접근 ${nat.riverMin}분`);
    if (nat.hanRiverView === true) { riverComp = clamp(riverComp + 8, 0, 100); natN.push('한강 조망 세대'); }
    else if (nat.hanRiverView == null && nat.hanRiver) { gaps.push('한강 조망 데이터 없음 — 평가 제외'); }
    const nature = clamp(0.5 * parkComp + 0.35 * riverComp + 0.15 * (nat.forest ? 80 : 55), 0, 100);
    notes.nature = natN;

    // 상품가치 (연식 비선형 · 세대수 로그 · 브랜드 제한 · 주차 · 임대비중 양면)
    const age = input.asOfYear - cx.builtYear;
    const ageScore = interp(age, [[3, 95], [7, 88], [12, 80], [18, 70], [25, 60], [32, 52], [45, 46]]);
    const hhScore = clamp(35 + 14 * Math.log((cx.households || 300) / 100), 40, 95);
    const brandScore = [92, 82, 70, 58][(cx.brandTier || 3) - 1];
    const parkingScore = interp(cx.parkingRatio ?? 0.9, [[0.4, 38], [0.6, 50], [0.8, 62], [1.0, 75], [1.2, 85], [1.5, 95]]);
    const share = cx.rentalShare || 0;
    const rentalScore = share >= 0.15 ? 62 : share >= 0.08 ? 74 : 85;
    const product = clamp(0.30 * ageScore + 0.24 * hhScore + 0.15 * brandScore + 0.22 * parkingScore + 0.09 * rentalScore, 0, 100);
    notes.product = [
      `${cx.builtYear}년 준공 (${age}년차) · ${(cx.households || 0).toLocaleString()}세대 · 주차 ${cx.parkingRatio ?? '?'}대/세대`,
      ...(age >= 26 ? ['구축 연식은 상품성에서 감점하되, 정비사업 가능성은 미래 옵션가치에서 별도 평가'] : []),
      ...(share >= 0.08 ? [`임대비중 ${(share * 100).toFixed(0)}% — 실거주 안정성은 감점, 임대수요 강도는 별도 판단`] : [])
    ];

    const subs = { transport, job, education: eduScore, life: lifeScore, nature, product };

    // 가격 반영: 카테고리별 캡 × (점수−기준)/분모, 교육은 지역계수 곱, 총합 클램프
    const adj = {};
    let total = 0;
    for (const k of Object.keys(H.categoryCaps)) {
      let a = H.categoryCaps[k] * (subs[k] - H.baselineScore) / H.scoreToAdjDivisor;
      a = clamp(a, -H.categoryCaps[k], H.categoryCaps[k]);
      if (k === 'education') a *= eduCoeff;
      adj[k] = a; total += a;
    }
    total = clamp(total, -H.totalCap, H.totalCap);
    return { subs, notes, adj, total, eduDetail: { school, academy, access, demand, eduCoeff, hubName: hub ? hub.hub_name : null } };
  }

  /* ═══════════ Engine D · 수요·공급·시장구조 ═══════════ */
  function engineSupply(cx, input, CFG) {
    const S = CFG.supply, sup = cx.supply;
    const mul = input.overrides.supplyMul || 1;
    const demand = sup.pop * S.demandRate;
    const localRatio = (sup.next3yAvg * mul) / demand;
    const combined = S.zoneWeights.local * localRatio + S.zoneWeights.adjacent * (sup.adjacentRatio ?? 1) * mul + S.zoneWeights.metro * (sup.metroRatio ?? 1) * mul;
    let gradeIdx = S.burdenBands.length;
    for (let i = 0; i < S.burdenBands.length; i++) if (combined < S.burdenBands[i]) { gradeIdx = i; break; }
    let adj = S.priceAdjByGrade[gradeIdx] ?? 0;
    adj += S.unsoldExtraAdj[String(sup.unsoldLevel)] ?? 0;
    // 규제효과: 양면 서술 + 소폭만 반영
    let regAdj = 0;
    const regulation = sup.regulated
      ? { demandSide: '대출·세금·거래 규제로 매수수요에는 부정적', lockinSide: '보유·거래 비용으로 매도유인 감소 — 매물잠김 효과는 가격 지지에 긍정적' }
      : { demandSide: '비규제 — 매수 진입 제약이 작음', lockinSide: '매물잠김 효과는 약해 공급(매물) 측 완충이 적음' };
    if (!sup.regulated) regAdj = Math.min(0.005, S.regulationAdjCap);
    adj = clamp(adj + regAdj, -S.priceAdjCap, S.priceAdjCap);
    const score = clamp([88, 76, 62, 45, 30][gradeIdx] - (sup.unsoldLevel >= 4 ? 8 : 0) + (sup.txVolumeLevel >= 4 ? 4 : sup.txVolumeLevel <= 2 ? -4 : 0), 0, 100);
    return {
      demand: Math.round(demand), localRatio, combined, gradeIdx,
      gradeLabel: S.burdenLabels[gradeIdx], adj, regulation, score,
      demandLabel: S.demandRateLabel, mul,
      notes: [
        `간이 추정수요 연 ${Math.round(demand).toLocaleString()}호 vs 향후 3년 연평균 입주 ${Math.round(sup.next3yAvg * mul).toLocaleString()}호 (해당 지역)`,
        `공급부담률(가중): 해당 지역 ${localRatio.toFixed(2)} · 인접 ${((sup.adjacentRatio ?? 1) * mul).toFixed(2)} · 광역 ${((sup.metroRatio ?? 1) * mul).toFixed(2)} → 종합 ${combined.toFixed(2)}`,
        ...(sup.adjacentNote ? [`인접 생활권: ${sup.adjacentNote}`] : []),
        ...(sup.txNote ? [sup.txNote] : []), ...(sup.jeonseNote ? [sup.jeonseNote] : [])
      ]
    };
  }

  /* ═══════════ Engine E · 미래 옵션가치 ═══════════ */
  function engineOption(cx, input, CFG, gaps) {
    const O = CFG.option;
    let stage = (cx.redev && cx.redev.stage) || 'none';
    const age = input.asOfYear - cx.builtYear;
    if (stage === 'none' && age >= 30 && (cx.far || 999) < 180) stage = 'potential';
    const prob = O.stageProbabilities[stage] ?? 0;
    const headroom = (cx.allowedFar && cx.far) ? (cx.allowedFar - cx.far) / cx.far : null;
    let premium = 0, premiumNote = null;
    if (prob > 0) {
      if (headroom != null) premium = prob * O.maxOptionPremium * clamp(headroom / O.headroomRef, 0, 1);
      else { premiumNote = '용적률·대지지분 데이터 부족 — 금액 반영 없이 등급·시나리오만 제시'; gaps.push('정비사업 사업성 데이터 일부 없음'); }
    }
    let gIdx = O.gradeBands.length;
    for (let i = 0; i < O.gradeBands.length; i++) if (prob >= O.gradeBands[i]) { gIdx = i; break; }
    const scenario = prob <= 0 ? null :
      `현 단계(${O.stageLabels[stage]}) 기준 실현확률 가정 ${(prob * 100).toFixed(0)}%` +
      (headroom != null ? ` · 용적률 여유 ${(headroom * 100).toFixed(0)}% (${cx.far}% → 허용 ${cx.allowedFar}%)` : '') +
      ' — 사업 지연·분담금 증가 시 가치가 줄어드는 조건부 기대입니다.';
    return {
      stage, label: O.stageLabels[stage], prob, headroom, premium, premiumNote,
      gradeLabel: O.gradeLabels[gIdx], gradeIdx: gIdx, scenario,
      note: cx.redev && cx.redev.note ? cx.redev.note : null
    };
  }

  /* ═══════════ 하이브리드 결합 + 범위 ═══════════ */
  function combine(market, fin, hed, sup, opt, CFG, compQuality) {
    const FN = CFG.final, RG = CFG.range;
    const vM = market.value;
    // 히도닉 잔차: 비교거래가 대상 그 자체(동일단지 동일평형)일수록 이중반영 제거
    const hRes = hed.total * (1 - compQuality);
    const vMktAdj = vM * (1 + hRes + sup.adj);
    const vFundEff = fin.value * (1 + opt.premium);
    // 모델 괴리 → fundamental 가중 축소
    const d = Math.abs(vFundEff - vM) / vM;
    const wfRaw = FN.corePair.financial * Math.max(FN.fundWeightFloor, 1 - d);
    const wm = FN.corePair.market / (FN.corePair.market + wfRaw);
    const wf = 1 - wm;
    let center = wm * vMktAdj + wf * vFundEff;
    // 시장앵커 안전 클램프 (비정상 결과 방지)
    const lo = vM * (1 - FN.anchorClamp), hi = vM * (1 + FN.anchorClamp);
    const clamped = center < lo || center > hi;
    center = clamp(center, lo, hi);
    return { center, vMktAdj, vFundEff, hRes, wm, wf, disagreement: d, anchorClamped: clamped };
  }

  function valueRange(center, market, disagreement, fillRate, CFG) {
    const RG = CFG.range;
    const spread = clamp(
      RG.minSpread + RG.dispersionWeight * market.dispersion + RG.disagreementWeight * disagreement + RG.dataGapWeight * (1 - fillRate),
      RG.minSpread, RG.maxSpread);
    return { low: center * (1 - spread), high: center * (1 + spread), spread };
  }

  /* ═══════════ 3대 점수 ═══════════ */
  function livingScore(hed, CFG) {
    const W = CFG.scores.living;
    let s = 0; for (const k of Object.keys(W)) s += W[k] * hed.subs[k];
    return clamp(s, 0, 100);
  }

  function investScore(cx, hed, sup, opt, support, CFG) {
    const W = CFG.scores.invest;
    const tierScore = { '서울핵심': 88, '서울': 78, '수도권핵심': 72, '수도권': 60, '지방광역': 52, '기타': 46 }[cx.regionTier] ?? 50;
    const hhScore = clamp(35 + 14 * Math.log((cx.households || 300) / 100), 40, 95);
    const scarcity = clamp(0.4 * hhScore + 0.25 * [92, 82, 70, 58][(cx.brandTier || 3) - 1] + 0.35 * tierScore + (opt.gradeIdx <= 1 ? 5 : 0), 0, 100);
    let future = [88, 74, 60, 48][opt.gradeIdx];
    if (cx.location.futureTransit && /확정|공사/.test(cx.location.futureTransit)) future = clamp(future + 6, 0, 100);
    const location = clamp(0.55 * hed.subs.job + 0.45 * hed.subs.transport, 0, 100);
    const liquidity = [30, 45, 60, 75, 88][(cx.supply.txVolumeLevel || 3) - 1];
    const subs = { jeonseSupport: support.score, supplyDemand: sup.score, scarcity, future, location, liquidity };
    let s = 0; for (const k of Object.keys(W)) s += W[k] * subs[k];
    return { total: clamp(s, 0, 100), subs };
  }

  function attractScore(currentPrice, center, range, support, CFG) {
    const premium = (currentPrice - center) / center;
    const curve = CFG.scores.priceAttractCurve.map(p => [p.premium, p.score]);
    let s = interp(premium, curve);
    s += (support.gradeIdx <= 1 ? 3 : support.gradeIdx >= 3 ? -3 : 0);
    s = clamp(s, CFG.scores.priceAttractClamp[0], CFG.scores.priceAttractClamp[1]);
    // 범위 내 위치
    let positionLabel;
    if (currentPrice < range.low) positionLabel = '적정가치 하단 아래';
    else if (currentPrice > range.high) positionLabel = '적정가치 상단 위';
    else {
      const pos = (currentPrice - range.low) / (range.high - range.low);
      positionLabel = pos < 0.33 ? '적정가치 하단' : pos < 0.67 ? '적정범위 중앙' : '적정가치 상단';
    }
    return { score: Math.round(s), premium, positionLabel };
  }

  /* ═══════════ 신뢰도 ═══════════ */
  function confidence(market, disagreement, fillRate, manualCount, CFG) {
    const C = CFG.confidence.penalties, penalties = [];
    let s = 100;
    if (market.compCount < 3) { s -= C.compsUnder3; penalties.push(`동일평형 비교거래 ${market.compCount}건 (3건 미만)`); }
    else if (market.compCount < 6) { s -= C.compsUnder6; penalties.push(`동일평형 비교거래 ${market.compCount}건 (6건 미만)`); }
    if (market.latestMonths > 12) { s -= C.latestOver12mo; penalties.push('최근 12개월 내 거래 없음'); }
    else if (market.latestMonths > 6) { s -= C.latestOver6mo; penalties.push('최근 6개월 내 거래 없음'); }
    if (market.compQuality < 0.2) { s -= C.tier3Only; penalties.push('비교거래가 대부분 타단지·타평형'); }
    const mo = Math.min(manualCount * C.perManualOverride, C.manualOverrideMax);
    if (mo) { s -= mo; penalties.push(`수동 보정 ${manualCount}건`); }
    if (disagreement > C.disagreementOver) { s -= C.disagreementPenalty; penalties.push('시장가격과 임대가치 모델 간 괴리 큼'); }
    const gap = Math.round((1 - fillRate) * C.dataGapFactor);
    if (gap > 0) { s -= gap; penalties.push(`데이터 충족률 ${(fillRate * 100).toFixed(0)}%`); }
    s = clamp(Math.round(s), 0, 100);
    const B = CFG.confidence.bands;
    const label = s >= B.high ? CFG.confidence.labels[0] : s >= B.mid ? CFG.confidence.labels[1] : CFG.confidence.labels[2];
    return { score: s, label, penalties };
  }

  /* ═══════════ 설명 생성 (상승·하락 요인 / 기여도 / 조건부 해석) ═══════════ */
  function buildExplain(res, cx, area, CFG) {
    const { hedonic: hed, financial: fin, supplyE: sup, option: opt, support, scores } = res;
    const up = [], down = [];
    const sub = hed.subs;
    if (sub.job >= 75) up.push('주요 업무지 접근성 우수');
    if (sub.transport >= 80) up.push('역세권·교통 경쟁력');
    if (sub.education >= 80) up.push(hed.eduDetail.hubName ? `선호 학군·학원가 (${hed.eduDetail.hubName})` : '교육환경 우수');
    if (sub.product >= 80) up.push('신축급 상품성·대단지');
    else if ((cx.households || 0) >= 3000) up.push('대단지 규모');
    if (sub.nature >= 80) up.push('공원·수변 등 자연환경');
    if (support.gradeIdx <= 1) up.push(`전세지지력 ${support.label}`);
    if (sup.gradeIdx <= 1) up.push('향후 공급 부족·양호');
    if (opt.gradeIdx <= 1) up.push(`정비사업 기대 (${opt.label})`);
    if (scores.attract.premium <= -0.05) up.push('모델 적정가치 대비 낮은 현재 가격');

    if (scores.attract.premium >= 0.05) down.push('모델 적정가치 대비 높은 현재 가격');
    if (fin.impliedG != null && fin.impliedG > CFG.financial.impliedGrowthConcernOver) down.push('가격에 반영된 미래 성장 기대가 큼');
    if (sub.product < 60) down.push('구축 연식·상품성 열위');
    if ((cx.parkingRatio ?? 1) < 0.7) down.push('주차 경쟁력 부족');
    if (sup.gradeIdx >= 3) down.push(`공급 ${sup.gradeLabel}`);
    if (support.gradeIdx >= 3) down.push(`전세지지력 ${support.label}`);
    if (sub.transport < 55) down.push('대중교통 접근성 열위');
    if (cx.supply.txVolumeLevel <= 2) down.push('거래 빈도 낮음 — 가격 발견 제한');
    if (!up.length) up.push('뚜렷한 프리미엄 요인 없음 — 가격 부담이 낮은 편인지 확인');
    if (!down.length) down.push('뚜렷한 하방 요인 없음');

    // 상대적 가치 기여도 (평균적 아파트 60점 대비, 개념적 지표)
    const contrib = [
      { k: '금융·임대 지지력', v: clamp((fin.value / res.market.value - 1) * 100, -40, 40) },
      { k: '교통·직주 프리미엄', v: clamp((0.5 * (sub.transport + sub.job) - 60) * 0.9, -40, 40) },
      { k: '교육 프리미엄', v: clamp((sub.education - 60) * 0.9 * hed.eduDetail.eduCoeff, -40, 40) },
      { k: '생활·자연환경', v: clamp((0.5 * (sub.life + sub.nature) - 60) * 0.9, -40, 40) },
      { k: '상품성·희소성', v: clamp((0.5 * (sub.product + scores.invest.subs.scarcity) - 60) * 0.9, -40, 40) },
      { k: '수급 구조', v: clamp((sup.score - 60) * 0.9, -40, 40) },
      { k: '미래 기대(정비·교통)', v: clamp([30, 18, 5, 0][opt.gradeIdx] + (cx.location.futureTransit && /확정|공사/.test(cx.location.futureTransit) ? 8 : 0), -40, 40) }
    ];

    // 조건부 해석
    const interp2 = [];
    const P = res.currentPrice;
    if (fin.impliedG != null) {
      const gPct = (fin.impliedG * 100).toFixed(1);
      if (fin.impliedG > CFG.financial.impliedGrowthConcernOver)
        interp2.push(`현재 ${round1(P)}억원이 유지되려면 임대가치가 연평균 약 ${gPct}% 성장해야 합니다. 장기 평균 가정(${(fin.g * 100).toFixed(1)}%)을 크게 웃도는 수준으로, 현재 가격에는 상당한 미래 성장 기대가 이미 반영되어 있습니다.`);
      else if (fin.impliedG > 0)
        interp2.push(`현재 ${round1(P)}억원을 정당화하려면 임대가치가 연평균 약 ${gPct}% 성장하면 됩니다. 장기 가정(${(fin.g * 100).toFixed(1)}%) 범위에서 무리하지 않은 수준입니다.`);
      else
        interp2.push(`현재 가격은 임대가치 성장 없이도(연 ${gPct}%) 설명되는 보수적 구간입니다.`);
    }
    if (opt.prob >= 0.35 && res.combineOut.disagreement > 0.35)
      interp2.push(`현재 가격에는 임대(사용)가치보다 정비사업(${opt.label}) 기대가 크게 반영되어 있습니다. 사업 지연·분담금 증가 시나리오에서 가격 하방 변동성이 커질 수 있습니다.`);
    else if (sub.education >= 80 && sub.job >= 70)
      interp2.push(`현재 가격에는 학군·직주근접 프리미엄이 상대적으로 크게 반영되어 있습니다.`);
    if (support.gradeIdx <= 1 && sup.gradeIdx <= 1)
      interp2.push(`현재 가격이 유지되려면 지금 수준의 전세수요와 공급 ${sup.gradeLabel} 상태가 상당 기간 이어질 필요가 있습니다.`);
    if (sup.gradeIdx >= 3)
      interp2.push(`향후 공급 부담(종합 부담률 ${sup.combined.toFixed(2)})이 현실화되면 전세가격과 매매가격 지지력이 함께 약해질 수 있습니다.`);
    if (scores.living.total >= 78 && scores.attract.score < 55)
      interp2.push(`입지·주거 경쟁력은 높지만, 현재 가격도 이를 상당 부분 선반영하고 있어 가격매력도는 ${scores.attract.score}점에 머뭅니다.`);
    if (scores.attract.score >= 70)
      interp2.push(`지표 대비 상대적으로 낮은 가격 구간입니다. 동·층·향, 내부 상태 등 개별 물건 요인을 함께 확인하세요.`);

    return { up, down, contrib, interpretation: interp2 };
  }

  /* ═══════════ 메인 파이프라인 ═══════════ */
  function analyze(rawInput, CFG, HUBS, JOBS) {
    const input = {
      asOfYM: rawInput.asOfYM, asOfYear: Number(rawInput.asOfYM.split('-')[0]),
      overrides: rawInput.overrides || {}, useRent: !!rawInput.useRent,
      manualComplex: !!rawInput.manualComplex
    };
    const cx = rawInput.complex;
    const area = cx.areas.find(a => a.key === rawInput.areaKey) || cx.areas[0];
    const gaps = [];
    if (Array.isArray(cx.dataGaps)) gaps.push(...cx.dataGaps);   // 자동 수집 단지의 결측 항목

    // Engine A
    const market = engineMarket(cx, area, input, CFG);
    if (!market.value) throw new Error('비교거래 없음 — 현재 가격을 직접 입력해 주세요.');

    // 현재 시장가격: 사용자 수정 > 최근 실거래
    const t1 = (area.trades || []).slice().sort((a, b) => ymToNum(b.ym) - ymToNum(a.ym));
    const basePrice = input.overrides.price != null ? input.overrides.price : (t1.length ? t1[0].price : market.value);
    const currentPrice = basePrice * (input.overrides.priceMul || 1);

    // Engine B
    const fin = engineFinancial(cx, area, input, CFG, currentPrice);
    // Engine D (전세지지력이 공급부담을 참조하므로 먼저)
    const supplyE = engineSupply(cx, input, CFG);
    const support = jeonseSupport(fin, cx.supply, supplyE.combined, CFG);
    // Engine C
    const hedonic = engineHedonic(cx, area, input, CFG, HUBS, JOBS, gaps);
    // Engine E
    const option = engineOption(cx, input, CFG, gaps);

    // 데이터 충족률 (조망 등 결측 + 수동입력 단지 감안)
    const expectedGapBase = 10;
    const fillRate = clamp(1 - gaps.length / expectedGapBase - (input.manualComplex ? 0.15 : 0), 0.5, 1);

    // 결합 + 범위
    const combineOut = combine(market, fin, hedonic, supplyE, option, CFG, market.compQuality);
    const range = valueRange(combineOut.center, market, combineOut.disagreement, fillRate, CFG);

    // 점수
    const living = { total: livingScore(hedonic, CFG), subs: hedonic.subs };
    const invest = investScore(cx, hedonic, supplyE, option, support, CFG);
    const attract = attractScore(currentPrice, combineOut.center, range, support, CFG);

    // 신뢰도
    const manualCount = (input.overrides.price != null ? 1 : 0) + (input.overrides.jeonse != null ? 1 : 0) + (input.manualComplex ? 2 : 0);
    const conf = confidence(market, combineOut.disagreement, fillRate, manualCount, CFG);

    const res = {
      cx, area, input, currentPrice, market, financial: fin, support, hedonic, supplyE, option,
      combineOut, range, gaps, fillRate,
      scores: { living, invest, attract },
      confidence: conf
    };
    res.explain = buildExplain(res, cx, area, CFG);
    return res;
  }

  /* 스트레스 테스트: 프리셋 id 배열 → 오버라이드 병합 후 재계산 */
  function applyStress(rawInput, presetIds, CFG, HUBS, JOBS) {
    const ov = Object.assign({}, rawInput.overrides);
    for (const id of presetIds) {
      const p = CFG.stress.presets.find(x => x.id === id);
      if (!p) continue;
      for (const [k, v] of Object.entries(p.apply)) {
        if (k === 'rateDelta') ov.rateDelta = (ov.rateDelta || 0) + v;
        else ov[k] = v;
      }
    }
    return analyze(Object.assign({}, rawInput, { overrides: ov }), CFG, HUBS, JOBS);
  }

  return { analyze, applyStress, interp, weightedMedian, weightedPercentile, monthsBetween, clamp, round1 };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = AptEngine;
