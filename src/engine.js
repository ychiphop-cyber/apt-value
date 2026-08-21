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

  // 한국어 조사: 받침 유무에 따라 이/가·은/는·을/를 선택 (FR-09 조사 오류 방지)
  function josa(word, withBatchim, without) {
    const w = String(word || '').trim();
    if (!w) return w + without;
    const c = w.charCodeAt(w.length - 1);
    const has = c >= 0xAC00 && c <= 0xD7A3 ? (c - 0xAC00) % 28 > 0 : /[013678lmnbktp]$/i.test(w);
    return w + (has ? withBatchim : without);
  }

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

  // 좌표 거리(km) — 교육생활권 매칭(§12)용
  function havKm(a, b) {
    const d2r = Math.PI / 180;
    const dLa = (b[0] - a[0]) * d2r, dLo = (b[1] - a[1]) * d2r;
    const x = Math.sin(dLa / 2) ** 2 + Math.cos(a[0] * d2r) * Math.cos(b[0] * d2r) * Math.sin(dLo / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.sqrt(x));
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

  /* ═══════════ 시장 기준가 (V3 §7~9) ═══════════
     최근 실거래 1건 ≠ 시장가치. 기간창(90→180→365일) 동일평형 거래의 가중중앙값을 쓰고,
     이상거래(o)·저층은 저가중. 최근 1건은 '최근 실거래'로만 별도 표시한다. */
  function dateOf(t) {
    const [y, m] = t.ym.split('-').map(Number);
    return Date.UTC(y, m - 1, Math.min(28, t.d || 15));
  }
  function marketReference(area, input, CFG) {
    const M = CFG.marketRef;
    const [ay, am] = input.asOfYM.split('-').map(Number);
    const asOf = Date.UTC(ay, am, 0);   // 기준월 말일
    const all = (area.trades || []).map(t => ({ ...t, days: Math.max(0, Math.round((asOf - dateOf(t)) / 86400000)) }))
      .sort((a, b) => a.days - b.days);
    if (!all.length) return null;
    let win = null, windowDays = null;
    for (const wd of M.windowsDays) {
      const w = all.filter(t => t.days <= wd);
      if (w.length >= M.minComps) { win = w; windowDays = wd; break; }
    }
    if (!win) { win = all.filter(t => t.days <= M.windowsDays[M.windowsDays.length - 1]); windowDays = M.windowsDays[M.windowsDays.length - 1]; }
    if (!win.length) { win = all.slice(0, 5); windowDays = null; }
    const items = win.map(t => ({
      v: t.price,
      w: Math.pow(0.5, t.days / M.recencyHalfLifeDays)
        * (t.o ? M.outlierWeight : 1)
        * (t.floor > 0 && t.floor <= M.lowFloorMax ? M.lowFloorWeight : 1),
      t
    }));
    const med = weightedMedian(items);
    const p25 = weightedPercentile(items, 0.25), p75 = weightedPercentile(items, 0.75);
    const half = Math.max(M.minHalfSpread * med, (p75 - p25) / 2);
    const latest = all[0];
    const totW = items.reduce((s, it) => s + it.w, 0);
    return {
      med, low: med - half, high: med + half,
      windowDays, extended: windowDays != null && windowDays > M.windowsDays[0],
      baseWindowDays: M.windowsDays[0],
      n: win.length, nOutlier: win.filter(t => t.o).length,
      latest: { date: `${latest.ym}-${String(latest.d || 15).padStart(2, '0')}`, price: latest.price, floor: latest.floor, outlier: !!latest.o, daysAgo: latest.days },
      dispersion: med > 0 ? Math.max(0, (p75 - p25) / med / 2) : 0.04,
      // FR-07 "왜 이 금액인가": 사용 거래 전체와 실제 가중치·공식 구성값을 그대로 공개 (재계산 가능해야 함)
      items: items.map(it => ({
        date: `${it.t.ym}-${String(it.t.d || 15).padStart(2, '0')}`, price: it.t.price, floor: it.t.floor || null,
        w: totW > 0 ? it.w / totW : 0, wRaw: it.w,
        outlier: !!it.t.o, lowFloor: !!(it.t.floor > 0 && it.t.floor <= M.lowFloorMax)
      })),
      formula: {
        p25, p75, half, iqrHalf: (p75 - p25) / 2, minHalf: M.minHalfSpread * med,
        minHalfApplied: M.minHalfSpread * med >= (p75 - p25) / 2,
        minHalfSpread: M.minHalfSpread, recencyHalfLifeDays: M.recencyHalfLifeDays,
        outlierWeight: M.outlierWeight, lowFloorMax: M.lowFloorMax, lowFloorWeight: M.lowFloorWeight
      }
    };
  }

  /* ═══════════ 대표 최근가 (V4 — 원칙 1: 사실과 판단 분리) ═══════════
     실거래는 사실이다 — 이상거래로 판단되더라도 실제 거래가격을 삭제·교체하지 않는다.
     price = 항상 실제 최근 거래가. 대신 또래(3개월) 대비 이상 저가/고가 '판단'을
     anomalous/anomalousHigh 플래그와 peerMed로 함께 제공하고, 시장 중심가격은
     marketReference(가중중앙값)가 담당한다. */
  function repRecentPrice(area, asOfYM, CFG) {
    const A = (CFG.marketRef && CFG.marketRef.anomalyLow) || { windowDays: 92, ratio: 0.85, minPeers: 2 };
    const all = (area.trades || []).slice().sort((a, b) => dateOf(b) - dateOf(a));
    if (!all.length) return null;
    const latest = all[0];
    const base = { price: latest.price, latest, anomalous: false, anomalousHigh: false };
    const t0 = dateOf(latest);
    const win = all.filter(t => (t0 - dateOf(t)) / 86400000 <= A.windowDays && !t.o);
    const peers = win.filter(t => t !== latest);
    if (peers.length < A.minPeers) return base;
    const sortedP = peers.map(t => t.price).sort((a, b) => a - b);
    const peerMed = sortedP.length % 2 ? sortedP[(sortedP.length - 1) / 2]
      : (sortedP[sortedP.length / 2 - 1] + sortedP[sortedP.length / 2]) / 2;
    return {
      price: latest.price, latest,
      anomalous: !!latest.o || latest.price < A.ratio * peerMed,
      anomalousHigh: latest.price > peerMed / A.ratio,
      peerMed: round1(peerMed), windowDays: A.windowDays
    };
  }

  /* ═══════════ 미래가치 엔진 (V3 §24~28) — 5축 → g 시나리오 ═══════════ */
  function engineFuture(cx, supplyE, hedonic, option, CFG, input) {
    const F = CFG.future;
    const comps = {};
    const edu = cx.education || {};
    comps.demand = clamp(
      0.5 * interp(edu.age3049 ?? 0.29, [[0.24, 45], [0.27, 58], [0.30, 72], [0.33, 84], [0.36, 92]]) +
      0.25 * (F.jeonseTrendScore[(cx.supply || {}).jeonseTrend] ?? 60) +
      0.25 * (F.tierPrior[cx.regionTier] ?? 45), 0, 100);
    comps.scarcity = clamp(interp(supplyE.combined, F.scarcityCurve.map(p => [p.x, p.s])) - ((cx.supply || {}).unsoldLevel >= 4 ? 8 : 0), 0, 100);
    const ftText = (cx.location || {}).futureTransit || '';
    let ts = F.transitNoneScore;
    for (const st of F.transitStages) if (new RegExp(st.re).test(ftText)) { ts = st.s; break; }
    comps.transitChange = ts;
    comps.eduPref = hedonic.subs.education != null ? hedonic.subs.education : null;   // 미확인이면 축 제외
    comps.redevOption = F.optionGradeScore[option.gradeIdx] ?? 45;
    if (input && input.neutralize && input.neutralize.has('future')) {   // §25 기여도 재계산
      comps.transitChange = F.transitNoneScore;
      comps.redevOption = 45;
    }

    let sum = 0, wsum = 0;
    const W = F.weights;
    const keyMap = { demand: 'demand', scarcity: 'scarcity', transitChange: 'transitChange', eduPref: 'eduPref', redevOption: 'redevOption' };
    for (const k of Object.keys(W)) {
      const v = comps[keyMap[k]];
      if (v == null) continue;
      sum += W[k] * v; wsum += W[k];
    }
    const score = wsum > 0 ? clamp(sum / wsum, 0, 100) : 50;
    const gPrior = CFG.financial.longTermRentGrowth[cx.regionTier] ?? CFG.financial.longTermRentGrowth['기타'];
    const gBase = gPrior + clamp((score - 60) / 40, -1, 1) * F.gSwing;
    return {
      score: Math.round(score), comps,
      g: { low: gBase - F.gBandDown, base: gBase, high: gBase + F.gBandUp },
      gPrior
    };
  }

  /* ═══════════ Engine B · 금융·임대 내재가치 ═══════════ */
  function engineFinancial(cx, area, input, CFG, currentPrice, gScen) {
    const F = CFG.financial;
    const rateDelta = input.overrides.rateDelta || 0;
    const jeonseBase = input.overrides.jeonse != null ? input.overrides.jeonse : area.jeonse;
    // FR-03 부분 분석: 전세가 없으면 금융·임대 엔진만 보류(null) — 다른 엔진은 계속 실행
    if (!(jeonseBase > 0) && !(input.useRent && area.rentExample)) return null;
    const jeonse = jeonseBase * (input.overrides.jeonseMul || 1);
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
    // 요구수익률 r (합성) — 구성값을 rParts로 공개 (FR-07)
    const regionRisk = F.regionRiskPremium[cx.regionTier] ?? F.regionRiskPremium['기타'];
    const r = F.altReturn + F.liquidityPremium + F.assetRiskPremium + regionRisk + rateDelta;
    const rParts = { altReturn: F.altReturn, liquidityPremium: F.liquidityPremium, assetRiskPremium: F.assetRiskPremium, regionRiskPremium: regionRisk, rateDelta };
    // g 시나리오: 미래가치 엔진 결과 (없으면 지역 prior 단일값)
    const gPrior = F.longTermRentGrowth[cx.regionTier] ?? F.longTermRentGrowth['기타'];
    const gs = gScen || { low: gPrior - 0.005, base: gPrior, high: gPrior + 0.004 };
    const valueAt = g => {
      if (r - g >= F.minSpread) return { v: R / (r - g), mode: 'gordon' };
      let pv = 0;
      for (let t = 1; t <= F.dcfYears; t++) pv += R * Math.pow(1 + g, t - 1) / Math.pow(1 + r, t);
      return { v: pv, mode: 'dcf' };
    };
    const base = valueAt(gs.base);
    const fsv = { low: valueAt(gs.low).v, base: base.v, high: valueAt(gs.high).v };
    // 역산: 현재가 유지에 필요한 성장률
    const impliedG = currentPrice > 0 ? r - R / currentPrice : null;
    const jeonseRatio = currentPrice > 0 ? jeonse / currentPrice : null;
    const equity = currentPrice - jeonse;
    // 시나리오별 대입값 전체 공개 (FR-07): V = R/(r−g) 또는 유한 DCF
    const scen = ['low', 'base', 'high'].map(k => ({ k, g: gs[k], v: valueAt(gs[k]).v, mode: valueAt(gs[k]).mode }));
    return { R, r, rParts, g: gs.base, gScen: gs, scen, conv, mode: base.mode, value: base.v, fsv, impliedG, jeonse, jeonseRatio, equity, rSourceText };
  }

  /* 금융 지지력 등급 (V3 §21) — 전세 없음(fin null)이면 '분석 보류' (FR-03) */
  function financialGrade(fin, currentPrice, CFG) {
    const G = CFG.financialGrade;
    if (!fin) return { ratio: null, label: CFG.verdicts.heldLabel, idx: null, held: true };
    const ratio = currentPrice > 0 ? fin.fsv.base / currentPrice : 0;
    let i = G.bands.length;
    for (let k = 0; k < G.bands.length; k++) if (ratio >= G.bands[k]) { i = k; break; }
    return { ratio, label: G.labels[i], idx: i };
  }

  /* 미래 기대 반영도 (V3 §21·29): 역산 g* vs 시나리오 밴드 */
  function expectationGrade(fin, CFG) {
    const L = CFG.verdicts.expectationLabels;
    if (!fin) return { label: CFG.verdicts.heldLabel, idx: null, held: true };
    const g = fin.impliedG, s = fin.gScen;
    if (g == null) return { label: L[1], idx: 1 };
    if (g < s.low) return { label: L[0], idx: 0 };
    if (g <= s.base) return { label: L[1], idx: 1 };
    if (g <= s.high) return { label: L[2], idx: 2 };
    return { label: L[3], idx: 3 };
  }

  /* 시장 상대평가 (V3 §21): 현재가 vs 시장 기준가 범위 */
  function marketVerdict(currentPrice, ref, CFG) {
    const T = CFG.verdicts.marketTolerance, L = CFG.verdicts.marketLabels;
    if (!ref) return { label: L[1], idx: 1 };
    if (currentPrice < ref.low * (1 - T)) return { label: L[0], idx: 0 };
    if (currentPrice > ref.high * (1 + T)) return { label: L[2], idx: 2 };
    return { label: L[1], idx: 1 };
  }

  /* 희소성 기본치 — 세대수·브랜드·지역 티어만 (정비 기대 보너스는 미래 옵션 영역, §33) */
  function scarcityBase(cx, CFG) {
    const tierScore = { '서울핵심': 88, '서울': 78, '수도권핵심': 72, '수도권': 60, '지방광역': 52, '기타': 46 }[cx.regionTier] ?? 50;
    const sc = [
      [0.4, cx.households > 0 ? clamp(35 + 14 * Math.log(cx.households / 100), 40, 95) : null],
      [0.25, cx.brandTier ? [92, 82, 70, 58][cx.brandTier - 1] : null],
      [0.35, tierScore]
    ].filter(x => x[1] != null);
    const w = sc.reduce((a, x) => a + x[0], 0);
    return { score: w > 0 ? clamp(sc.reduce((a, x) => a + x[0] * x[1], 0) / w, 0, 100) : null, coverage: w };
  }

  /* 구조 경쟁력 (V2 §6·§33) — 입지·주거·상품·희소성. 미래 기대는 넣지 않는다(단기 불변 요소만).
     미확인 그룹은 제외·재정규화, 그룹별 값과 제외 목록을 함께 반환. */
  function structuralScore(hedonic, scB, CFG) {
    const S = CFG.structuralV2, sub = hedonic.subs;
    const mix = (pairs) => {
      let s = 0, w = 0;
      for (const [wt, v] of pairs) { if (v == null || !isFinite(v)) continue; s += wt * v; w += wt; }
      return w > 0 ? s / w : null;
    };
    const groups = {
      location: mix([[S.locationMix.transport, sub.transport], [S.locationMix.job, sub.job]]),
      living: mix([[S.livingMix.education, sub.education], [S.livingMix.life, sub.life], [S.livingMix.nature, sub.nature]]),
      product: sub.product,
      scarcity: scB.score
    };
    let sum = 0, wsum = 0;
    const used = {};
    for (const k of Object.keys(S.weights)) {
      if (groups[k] == null) continue;
      sum += S.weights[k] * groups[k]; wsum += S.weights[k]; used[k] = Math.round(groups[k]);
    }
    const score = wsum > 0 ? clamp(sum / wsum, 0, 100) : null;
    const band = score == null ? null : (S.bands.find(b => score >= b.min) || S.bands[S.bands.length - 1]).label;
    return {
      score: score == null ? null : Math.round(score), band, comps: used,
      excluded: Object.keys(S.weights).filter(k => groups[k] == null),
      weightCoverage: wsum
    };
  }

  /* 전세지지력 (5등급) — 전세 없음(fin null)이면 산출 보류 (FR-03) */
  function jeonseSupport(fin, sup, combinedBurden, CFG) {
    if (!fin) return null;
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

  /* ═══════════ Station Intelligence · 아파트 교통가치 ═══════════
     기존 단순 역거리 점수를 "얼마나 강력한 역을 얼마나 가까이 이용할 수 있는가"로 교체.
     역 캐시(STN)가 없거나 역 연결이 없으면 null 반환 → 기존 로직 폴백. */
  function engineTransit(cx, input, CFG, JOBS, STN, gaps) {
    const S = CFG.station;
    if (!S || !STN || !STN.stations) return null;
    const link = cx.stationLink;
    if (!link || !link.primary || !STN.stations[link.primary.st]) {
      if (link && link.primary) gaps.push(`역 데이터 없음(${link.primary.st}) — 기존 방식으로 계산`);
      return null;
    }
    const decayPts = S.distanceDecay.map(p => [p.min, p.f]);
    const gCurve = S.gangnamCurve.map(p => [p.min, p.score]);
    const decay = m => interp(m, decayPts);
    const blend = st => S.transportBlend.svT * st.svT + S.transportBlend.gangnam * interp(st.gangnamMin, gCurve);
    const p = STN.stations[link.primary.st];
    const pd = decay(link.primary.min);
    const base = blend(p) * pd;

    // 추가 역 보너스: "새로 열리는 업무지"가 있을 때만 (노선 개수 아님 — §22·23)
    const totImp = JOBS.centers.reduce((a, c) => a + c.importance, 0);
    const reach = S.multiStation.newDestReachMin;
    const covered = new Set(JOBS.centers.filter(c => (p.jobMinutes[c.id] ?? 999) <= reach).map(c => c.id));
    let bonus = 0;
    const bonusNotes = [];
    const extras = [[link.secondary, S.multiStation.secondMax], [link.tertiary, S.multiStation.thirdMax]];
    for (const [sec, cap] of extras) {
      if (!sec || !STN.stations[sec.st]) continue;
      const s2 = STN.stations[sec.st];
      const newCenters = JOBS.centers.filter(c => (s2.jobMinutes[c.id] ?? 999) <= reach && !covered.has(c.id));
      const frac = newCenters.reduce((a, c) => a + c.importance, 0) / totImp;
      const quality = Math.min(1, (blend(s2) * decay(sec.min)) / Math.max(1, base));
      const b = cap * Math.min(1, frac / 0.3) * quality;
      if (b > 0.01) {
        bonus += b;
        bonusNotes.push(`${sec.st}(${s2.lines.join('·')})이 ${newCenters.map(c => c.name).join('·')} 접근을 새로 열어 +${Math.round(b * 100)}%`);
      } else if (frac < 0.02) {
        bonusNotes.push(`${sec.st}은 주력역과 같은 방향 — 추가 프리미엄 미미`);
      }
      newCenters.forEach(c => covered.add(c.id));
    }
    bonus = Math.min(bonus, S.multiStation.totalBonusCap);
    let score = clamp(base * (1 + bonus), 0, 100);
    let ft = null;
    if (cx.location && cx.location.futureTransit && !(input.neutralize && input.neutralize.has('future'))) {
      const conf = /확정|공사/.test(cx.location.futureTransit);
      score = clamp(score + (conf ? S.futureTransitBonus.confirmed : S.futureTransitBonus.planned), 0, 100);
      ft = `${cx.location.futureTransit}${conf ? '' : ' — 미확정은 제한 반영'}`;
    }
    // 직주근접: 역 기반 업무지 접근성 (도보거리 소폭 반영)
    const jobScore = clamp((p.jobAccess ?? p.comps.transit) * (0.9 + 0.1 * pd), 0, 100);
    const gangnamScore = Math.round(interp(p.gangnamMin, gCurve));
    return {
      score: clamp(score, 0, 100), jobScore, bonus, bonusNotes, futureNote: ft,
      primary: { st: link.primary.st, min: link.primary.min, status: link.primary.status || 'ESTIMATED', sv: p.sv, rank: p.rank, rankPct: p.rankPct, lines: p.lines, comps: p.comps, wealth: p.wealth, express: p.express },
      secondary: link.secondary && STN.stations[link.secondary.st] ? { st: link.secondary.st, min: link.secondary.min, sv: STN.stations[link.secondary.st].sv, lines: STN.stations[link.secondary.st].lines } : null,
      gangnamMin: p.gangnamMin, gangnamScore,
      jobMinutes: p.jobMinutes
    };
  }

  /* ═══════════ 교육평가 V2 (개선 PRD §2-14) ═══════════
     생활권(zone) 구성요소 기반 — 100점 = 학교25 + 학원25 + 입시15 + 통학15 + 수요10 + 지속성10.
     데이터 없는 구성요소는 추정하지 않고 제외·재정규화(§7). Anchor Academy는 커버리지 비율로
     최대 anchorMax점 보조(§6). 등급(S~D)은 점수에서 산출(§11 데이터→점수→등급).
     매칭은 법정동 목록 → 좌표 거리(§12) — 행정동 문자열 매칭 폐기, 지역명 사전 Tier 폐기. */
  function eduScoreFromComponents(comps, E2, anchorCov, anchorsCfg) {
    let s = 0, w = 0;
    const used = {}, missing = [];
    for (const k of Object.keys(E2.weights)) {
      const v = comps[k];
      if (v == null || !isFinite(v)) { missing.push(k); continue; }
      s += E2.weights[k] * v; w += E2.weights[k]; used[k] = Math.round(v);
    }
    if (w <= 0) return null;
    const base = s / w;
    const anchorMax = (anchorsCfg && anchorsCfg.anchorMax) ?? 5;
    const anchorBonus = anchorCov != null ? anchorMax * clamp(anchorCov, 0, 1) : 0;
    const score = clamp(base + anchorBonus, 0, 100);
    let ti = E2.tierBands.length;
    for (let i = 0; i < E2.tierBands.length; i++) if (score >= E2.tierBands[i]) { ti = i; break; }
    return {
      score: Math.round(score), base: Math.round(base), anchorBonus: round1(anchorBonus),
      tier: E2.tierLabels[ti], tierIdx: ti, coverage: w, used, missing
    };
  }

  /* 존 자체 점수(단지 보정 없음) — 상대평가(§35)·역 교육축(pipeline) 공용 */
  function eduZoneScore(zone, E2, anchorsCfg) {
    if (!zone || !zone.components) return null;
    const cov = anchorsCfg && anchorsCfg.categories && anchorsCfg.categories.length
      ? (zone.anchors || []).length / anchorsCfg.categories.length : 0;
    return eduScoreFromComponents(zone.components, E2, cov, anchorsCfg);
  }

  /* 교육생활권 매칭 (§12·13): ① 법정동 소속(구 가드) ② 좌표 거리(radius 내 → 소속,
     radius+adjacencyKm 내 → 인접 생활권). 매칭 실패는 null — 임의 배정하지 않는다. */
  function matchEduZone(HUBS, q, E2) {
    const zones = (HUBS && HUBS.zones) || [];
    const norm = s => String(s || '').replace(/\s/g, '');
    if (q.dong) {
      for (const z of zones) {
        const dl = z.districts || (z.district ? [z.district] : []);
        const dOK = !q.district || !dl.length ||
          dl.some(d => norm(q.district).includes(norm(d)) || norm(d).includes(norm(q.district)));
        if (dOK && (z.dongs || []).some(d => norm(d) === norm(q.dong)))
          return { zone: z, via: 'dong', adjacent: false, distKm: null };
      }
    }
    if (q.coord && q.coord.length === 2) {
      let best = null;
      for (const z of zones) {
        if (z.latitude == null) continue;
        const d = havKm(q.coord, [z.latitude, z.longitude]);
        const over = d - z.radius_km;
        if (!best || over < best.over) best = { z, d, over };
      }
      if (best) {
        const adjKm = (E2 && E2.adjacencyKm) ?? 2;
        if (best.over <= 0) return { zone: best.z, via: 'coord', adjacent: false, distKm: round1(best.d) };
        if (best.over <= adjKm) return { zone: best.z, via: 'coord', adjacent: true, distKm: round1(best.d) };
      }
    }
    return null;
  }

  /* 단지 교육 상세: 존 구성요소 + 단지 수준 보정(초등거리·중학선호·30-49비중) → 점수·등급·신뢰도 */
  function eduDetailOf(cx, edu, HUBS, E2) {
    const zone = edu && edu.zoneId ? ((HUBS && HUBS.zones) || []).find(z => z.id === edu.zoneId) : null;
    const zc = (zone && zone.components) || {};
    const comps = {};
    const mps = edu && edu.middlePref ? (E2.middlePrefScore[edu.middlePref - 1] ?? 70) : null;
    comps.school = zc.school != null && mps != null
      ? (1 - E2.blend.schoolMiddlePref) * zc.school + E2.blend.schoolMiddlePref * mps
      : (zc.school ?? mps);
    comps.academy = zc.academy != null ? zc.academy
      : (edu && edu.localAcademyLevel ? (E2.localAcademyScore[String(edu.localAcademyLevel)] ?? null) : null);
    comps.admission = zc.admission ?? null;   // 입시성과: 존 데이터만 — 없으면 추정 금지(§7)
    comps.continuity = zc.continuity ?? null;
    const elemS = edu && edu.elemM != null
      ? clamp(interp(edu.elemM, E2.elemCurve) + (edu.chopuma ? E2.chopumaBonus : 0), 0, 100) : null;
    comps.commute = elemS != null && zc.commute != null
      ? E2.blend.commuteComplex * elemS + (1 - E2.blend.commuteComplex) * zc.commute
      : (elemS ?? zc.commute ?? null);
    const dS = edu && edu.age3049 != null
      ? clamp(interp(edu.age3049, [[0.24, 45], [0.27, 58], [0.30, 72], [0.33, 84], [0.36, 92]])
        + (edu.studentTrend === 'up' ? 5 : edu.studentTrend === 'down' ? -7 : 0), 0, 100) : null;
    comps.demand = dS != null && zc.demand != null
      ? E2.blend.demandComplex * dS + (1 - E2.blend.demandComplex) * zc.demand
      : (dS ?? zc.demand ?? null);
    const adjacent = !!(edu && edu.adjacent);
    if (adjacent) for (const k of ['academy', 'admission']) if (comps[k] != null) comps[k] *= E2.adjacencyFactor;

    const anch = HUBS && HUBS.anchors;
    const anchorCov = zone && anch && anch.categories && anch.categories.length
      ? (zone.anchors || []).length / anch.categories.length * (adjacent ? E2.adjacencyFactor : 1)
      : (zone ? 0 : null);
    const sc = eduScoreFromComponents(comps, E2, anchorCov, anch);
    if (!sc) return null;

    // §35 상대평가: 등록된 교육생활권 전체 중 위치 (존 자체 점수 기준)
    let relative = null;
    if (zone && HUBS.zones && HUBS.zones.length >= 5) {
      const all = HUBS.zones.map(z => { const s = eduZoneScore(z, E2, anch); return s ? s.score : null; })
        .filter(v => v != null).sort((a, b) => b - a);
      const zs = eduZoneScore(zone, E2, anch);
      if (zs && all.length) {
        let rank = all.findIndex(v => v <= zs.score);
        if (rank < 0) rank = all.length - 1;
        relative = { pctile: Math.max(1, Math.ceil((rank + 1) / all.length * 100)), n: all.length, zoneScore: zs.score };
      }
    }
    // §14 데이터 신뢰도 3단계 + 별점
    const covIdx = sc.coverage >= E2.coverage.full ? 0 : sc.coverage >= E2.coverage.partial ? 1 : 2;
    const labels = (HUBS && HUBS.componentLabels) || {
      school: '학교 경쟁력', academy: '학원 생태계', admission: '입시 성과',
      commute: '배정·통학', demand: '교육 수요', continuity: '생태계 지속성'
    };
    // §34 이유 문장: 상위 구성요소 → 왜 높은가 / 최저·결측 → 아쉬운 점
    const ranked = Object.entries(sc.used).sort((a, b) => b[1] - a[1]);
    const hi = ranked.filter(([, v]) => v >= 78).slice(0, 2).map(([k]) => labels[k]);
    const lo2 = ranked.length ? ranked[ranked.length - 1] : null;
    const why = hi.length
      ? `${josa(hi.join('과 '), '이', '가')} 특히 강한 생활권입니다.`
      : '구성요소가 고르게 중간 수준인 생활권입니다.';
    const weakBits = [];
    if (lo2 && lo2[1] < 65) weakBits.push(`${josa(labels[lo2[0]], '은', '는')} 상위 학군 대비 낮습니다`);
    if (sc.missing.length) weakBits.push(`${sc.missing.map(k => labels[k]).join('·')} 데이터는 확보하지 못해 평가에서 제외했습니다`);
    const weak = weakBits.length ? weakBits.join('. ') + '.' : '뚜렷한 약점 구성요소는 없습니다.';
    return {
      zoneId: zone ? zone.id : null, zoneName: zone ? zone.name : null, adjacent,
      score: sc.score, base: sc.base, tier: sc.tier, tierIdx: sc.tierIdx,
      comps: sc.used, missing: sc.missing, labels,
      anchorBonus: sc.anchorBonus,
      anchorsCovered: zone ? (zone.anchors || []).length : 0,
      anchorsTotal: anch && anch.categories ? anch.categories.length : 0,
      coverage: Math.round(sc.coverage * 100) / 100, covIdx,
      covLabel: (E2.coverageLabels || ['데이터 충분', '일부 데이터', '데이터 부족'])[covIdx],
      stars: Math.max(1, Math.round(sc.coverage * 5)),
      relative, why, weak, zoneNotes: zone ? zone.notes : null
    };
  }

  /* ═══════════ Engine C · 주거·입지·상품가치 ═══════════ */
  function engineHedonic(cx, area, input, CFG, HUBS, JOBS, gaps, transit) {
    const H = CFG.hedonic, E = CFG.education;
    const loc = cx.location, edu = cx.education, life = cx.life, nat = cx.nature;
    const notes = {};

    // 교통 · 직주근접 — Station Intelligence가 있으면 그것으로 "교체"(가산 아님), 없으면 기존 방식
    let transport, job;
    if (transit) {
      transport = transit.score;
      notes.transport = [
        `주력역 ${transit.primary.st} (Station Value ${transit.primary.sv} · ${transit.primary.lines.join('·')}) 도보 ${transit.primary.min}분`,
        ...(transit.bonus > 0.005 ? [`추가 네트워크 보너스 +${Math.round(transit.bonus * 100)}%`] : []),
        ...transit.bonusNotes,
        ...(transit.futureNote ? [transit.futureNote] : [])
      ];
      job = transit.jobScore;
      const near = JOBS.centers.filter(c => (transit.jobMinutes[c.id] ?? 999) <= 30).map(c => `${c.name} ${transit.jobMinutes[c.id]}분`);
      notes.job = near.length ? [`${transit.primary.st} 기준 30분 내 업무지: ${near.join(' · ')}`] : ['30분 내 주요 업무지 없음'];
    } else if (loc.unknownTransport) {
      transport = null;   // §12: 미확인은 중립값으로 몰래 대체하지 않는다 — 평가 제외 + 재정규화
      notes.transport = ['역거리 미확인 — 교통 항목 제외(신뢰도 하락)'];
      gaps.push('역거리 미확인 — 교통 평가 제외');
      let ja0 = 0;
      for (const c of JOBS.centers) ja0 += c.jobsIndex * Math.exp(-((loc.jobMinutes || {})[c.id] ?? 75) / H.jobDecayTau);
      job = clamp(100 * ja0 / H.jobRefAccess, 0, 100);
      notes.job = ['지역 평균 접근성 기준(간이)'];
    } else {
      transport = interp(loc.subwayMin, [[2, 96], [5, 88], [8, 78], [12, 64], [15, 55], [20, 42], [30, 30]]);
      const tN = [`지하철 도보 ${loc.subwayMin}분`];
      if (loc.transfer) { transport += 5; tN.push('환승 접근'); }
      if (loc.express) { transport += 5; tN.push('급행·광역'); }
      if ((loc.lines || []).length >= 2) { transport += 3; tN.push('복수 노선'); }
      if (loc.futureTransit && !(input.neutralize && input.neutralize.has('future'))) {
        const confirmed = /확정|공사/.test(loc.futureTransit);
        transport += confirmed ? 4 : 1;
        tN.push(`${loc.futureTransit}${confirmed ? '' : ' — 미확정은 제한 반영'}`);
      }
      transport = clamp(transport, 0, 100); notes.transport = tN;

      let ja = 0; const jN = [];
      for (const c of JOBS.centers) {
        const t = (loc.jobMinutes || {})[c.id] ?? 75;
        ja += c.jobsIndex * Math.exp(-t / H.jobDecayTau);
        if (t <= 30) jN.push(`${c.name} ${t}분`);
      }
      job = clamp(100 * ja / H.jobRefAccess, 0, 100);
      notes.job = jN.length ? [`30분 내 업무지: ${jN.join(' · ')}`] : ['30분 내 주요 업무지 없음'];
    }
    if (transport != null) transport = clamp(transport, 0, 100);
    job = clamp(job, 0, 100);

    // 교육 V2 (§2-14) — 생활권 구성요소 기반. 정보 전체 미확인이면 항목 제외 + 재정규화 (§12)
    let eduScore = null, eduCoeff = 0, eduDetail = null;
    if (edu) {
      eduDetail = eduDetailOf(cx, edu, HUBS, E);
      if (eduDetail) {
        eduScore = eduDetail.score;
        eduCoeff = E.coeffByTier[eduDetail.tier] ?? 0.6;
        const compLine = Object.entries(eduDetail.comps)
          .map(([k, v]) => `${eduDetail.labels[k]} ${v}`).join(' · ');
        notes.education = [
          `${compLine}${eduDetail.anchorBonus > 0 ? ` · Anchor 학원군 +${eduDetail.anchorBonus}` : ''}`,
          eduDetail.zoneName
            ? `${eduDetail.zoneName} 교육생활권${eduDetail.adjacent ? ' 인접(감쇄 반영)' : ''} · ${eduDetail.tier}등급 (계수 ×${eduCoeff}) · ${eduDetail.covLabel}`
            : `교육생활권 미매칭 — 단지 입력값 기준 (계수 ×${eduCoeff}) · ${eduDetail.covLabel}`,
          ...(eduDetail.missing.length ? [`미확보 구성요소 제외: ${eduDetail.missing.map(k => eduDetail.labels[k]).join('·')}`] : [])
        ];
        if (eduDetail.covIdx === 2) gaps.push('교육 구성요소 데이터 부족 — 제한 평가');
      }
    }
    if (eduScore == null) {
      notes.education = ['교육 정보 미확인 — 평가 제외(신뢰도 하락)'];
      gaps.push('교육 정보 미확인 — 평가 제외');
    }

    // 생활편의 — 미확인이면 제외 (10분 기본값 폐기, §56)
    let lifeScore = null;
    if (life) {
      lifeScore = clamp(
        0.35 * interp(life.martMin, [[5, 90], [10, 80], [15, 68], [30, 55]]) +
        0.25 * interp(life.deptMin, [[5, 92], [10, 84], [15, 74], [25, 62], [40, 50]]) +
        0.20 * interp(life.hospitalMin, [[5, 90], [10, 80], [15, 70], [25, 58], [40, 48]]) +
        0.20 * [40, 55, 68, 80, 92][(life.streetLevel || 3) - 1], 0, 100);
      notes.life = [`마트 ${life.martMin}분 · 백화점 ${life.deptMin}분 · 병원 ${life.hospitalMin}분`];
    } else { notes.life = ['생활편의 미확인 — 평가 제외']; gaps.push('생활편의 미확인 — 평가 제외'); }

    // 자연환경 — 미확인이면 제외 (한강 접근 ≠ 조망)
    let nature = null;
    if (nat) {
      const parkComp = nat.bigPark ? interp(nat.parkMin, [[5, 92], [10, 84], [15, 72], [30, 55]])
        : interp(nat.parkMin, [[5, 80], [10, 72], [15, 62], [30, 50]]);
      let riverComp = nat.hanRiver ? interp(nat.riverMin, [[10, 95], [15, 88], [25, 75], [40, 60]])
        : interp(nat.riverMin, [[10, 72], [20, 60], [40, 50]]);
      const natN = [`공원 ${nat.parkMin}분${nat.bigPark ? ' (대형)' : ''}`];
      if (nat.hanRiver) natN.push(`한강 접근 ${nat.riverMin}분`);
      if (nat.hanRiverView === true) { riverComp = clamp(riverComp + 8, 0, 100); natN.push('한강 조망 세대'); }
      else if (nat.hanRiverView == null && nat.hanRiver) { gaps.push('한강 조망 데이터 없음 — 평가 제외'); }
      nature = clamp(0.5 * parkComp + 0.35 * riverComp + 0.15 * (nat.forest ? 80 : 55), 0, 100);
      notes.nature = natN;
    } else { notes.nature = ['자연환경 미확인 — 평가 제외']; gaps.push('자연환경 미확인 — 평가 제외'); }

    // 상품가치 — 미확인 구성요소는 제외하고 가중치 재정규화 (700세대 등 임의 기본값 폐기, §10·12·50)
    const age = cx.builtYear ? input.asOfYear - cx.builtYear : null;
    const pcomps = [
      { w: 0.30, s: age != null ? interp(age, [[3, 95], [7, 88], [12, 80], [18, 70], [25, 60], [32, 52], [45, 46]]) : null, gap: '준공연도 미확인' },
      { w: 0.24, s: cx.households > 0 ? clamp(35 + 14 * Math.log(cx.households / 100), 40, 95) : null, gap: '세대수 미확인' },
      { w: 0.15, s: cx.brandTier ? [92, 82, 70, 58][cx.brandTier - 1] : null, gap: '브랜드 미확인' },
      { w: 0.22, s: cx.parkingRatio != null ? interp(cx.parkingRatio, [[0.4, 38], [0.6, 50], [0.8, 62], [1.0, 75], [1.2, 85], [1.5, 95]]) : null, gap: '주차 미확인' },
      { w: 0.09, s: cx.rentalShare != null ? (cx.rentalShare >= 0.15 ? 62 : cx.rentalShare >= 0.08 ? 74 : 85) : null, gap: null }
    ];
    let pSum = 0, pW = 0;
    const pGaps = [];
    for (const c of pcomps) { if (c.s == null) { if (c.gap) pGaps.push(c.gap); continue; } pSum += c.w * c.s; pW += c.w; }
    const product = pW > 0.25 ? clamp(pSum / pW, 0, 100) : null;
    for (const g of pGaps) gaps.push(`${g} — 상품가치에서 제외`);
    notes.product = [
      `${cx.builtYear ? cx.builtYear + '년 준공 (' + age + '년차)' : '준공연도 미확인'} · ${cx.households > 0 ? cx.households.toLocaleString() + '세대' : '세대수 미확인'} · 주차 ${cx.parkingRatio ?? '미확인'}`,
      ...(pGaps.length ? [`미확인 항목(${pGaps.join('·')})은 제외하고 나머지 가중치로 재계산`] : []),
      ...(age >= 26 ? ['구축 연식은 상품성에서 감점하되, 정비사업 가능성은 미래 옵션가치에서 별도 평가'] : [])
    ];

    const subs = { transport, job, education: eduScore, life: lifeScore, nature, product };

    // §25 기여도 재계산: 중립화 대상은 기준점수로 치환(해당 카테고리 가격조정 0) — 값이 있던 항목만
    if (input.neutralize) {
      const nmap = { transit: ['transport', 'job'], education: ['education'], product: ['product'], lifeNature: ['life', 'nature'] };
      for (const g of input.neutralize) for (const k of (nmap[g] || [])) if (subs[k] != null) subs[k] = H.baselineScore;
    }

    // 가격 반영: 카테고리별 캡 × (점수−기준)/분모 — 미확인(null) 카테고리는 조정 없음
    const adj = {};
    let total = 0;
    for (const k of Object.keys(H.categoryCaps)) {
      if (subs[k] == null) { adj[k] = 0; continue; }
      let a = H.categoryCaps[k] * (subs[k] - H.baselineScore) / H.scoreToAdjDivisor;
      a = clamp(a, -H.categoryCaps[k], H.categoryCaps[k]);
      if (k === 'education') a *= eduCoeff;
      adj[k] = a; total += a;
    }
    total = clamp(total, -H.totalCap, H.totalCap);
    return { subs, notes, adj, total, eduCoeff, eduDetail };
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
    if (input.neutralize && input.neutralize.has('supply')) adj = 0;   // §25 기여도 재계산
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
    if (input.neutralize && input.neutralize.has('future')) premium = 0;   // §25 기여도 재계산
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
    // V2 §11: ±클램프 강제 제한 폐지 — 1차 결과는 제한 없이 계산하고, 시장가와의
    // 괴리(divergence)가 크면 숨기지 않고 표시·설명한다. extremeGuard는 비정상
    // 폭주 방지를 위한 최종 안전장치로만 작동한다.
    const finish = (center0, extra) => {
      const lo = vM * (1 - FN.extremeGuard), hi = vM * (1 + FN.extremeGuard);
      const extremeGuarded = center0 < lo || center0 > hi;
      const center = clamp(center0, lo, hi);
      const divergence = center / vM - 1;
      return Object.assign({
        center, centerRaw: center0, divergence,
        divergenceLarge: Math.abs(divergence) > FN.divergenceNoteOver,
        extremeGuarded, vMktAdj, hRes
      }, extra);
    };
    if (!fin) {
      // 전세 없음 → 금융 결합 없이 시장 경로만 (FR-03 부분 분석)
      return finish(vMktAdj, { vFundEff: null, wm: 1, wf: 0, disagreement: 0, marketOnly: true });
    }
    const vFundEff = fin.value * (1 + opt.premium);
    // 모델 괴리 → fundamental 가중 축소
    const d = Math.abs(vFundEff - vM) / vM;
    const wfRaw = FN.corePair.financial * Math.max(FN.fundWeightFloor, 1 - d);
    const wm = FN.corePair.market / (FN.corePair.market + wfRaw);
    const wf = 1 - wm;
    return finish(wm * vMktAdj + wf * vFundEff, { vFundEff, wm, wf, disagreement: d });
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
    let s = 0, w = 0;
    for (const k of Object.keys(W)) {
      if (hed.subs[k] == null) continue;   // 미확인 카테고리 제외 + 재정규화 (§12)
      s += W[k] * hed.subs[k]; w += W[k];
    }
    return w > 0 ? clamp(s / w, 0, 100) : 50;
  }

  function investScore(cx, hed, sup, opt, support, CFG) {
    const W = CFG.scores.invest;
    // 희소성: 기본치(세대·브랜드·티어, 미확인 제외·재정규화) + 정비 기대 보너스(투자 관점에서만)
    const scB = scarcityBase(cx, CFG);
    const scarcity = clamp((scB.score ?? 50) + (opt.gradeIdx <= 1 ? 5 : 0), 0, 100);
    let future = [88, 74, 60, 48][opt.gradeIdx];
    if (cx.location.futureTransit && /확정|공사/.test(cx.location.futureTransit)) future = clamp(future + 6, 0, 100);
    const location = hed.subs.transport != null ? clamp(0.55 * hed.subs.job + 0.45 * hed.subs.transport, 0, 100) : clamp(hed.subs.job, 0, 100);
    const liquidity = [30, 45, 60, 75, 88][(cx.supply.txVolumeLevel || 3) - 1];
    // 전세 없음 → 전세지지력 항목 제외 + 가중치 재정규화 (FR-03 부분 분석)
    const subs = { jeonseSupport: support ? support.score : null, supplyDemand: sup.score, scarcity, future, location, liquidity };
    let s = 0, w = 0;
    for (const k of Object.keys(W)) { if (subs[k] == null) continue; s += W[k] * subs[k]; w += W[k]; }
    return { total: w > 0 ? clamp(s / w, 0, 100) : 50, subs };
  }

  function attractScore(currentPrice, center, range, support, CFG) {
    const premium = (currentPrice - center) / center;
    const curve = CFG.scores.priceAttractCurve.map(p => [p.premium, p.score]);
    let s = interp(premium, curve);
    if (support) s += (support.gradeIdx <= 1 ? 3 : support.gradeIdx >= 3 ? -3 : 0);
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

  /* ═══════════ V2 §13 데이터 충족도 — 카테고리별 % (UNKNOWN=0, 임의 중립값 금지) ═══════════ */
  function fulfillmentOf(cx, area, marketRef, input, CFG) {
    const F = CFG.fulfillment, fs = cx.fieldStatus || {};
    const st = k => fs[k] || 'VERIFIED';   // 상세 프로필(fieldStatus 없음)은 확인 데이터로 취급
    const sVal = { VERIFIED: 1, MANUAL: 1, ESTIMATED: 0.55, UNKNOWN: 0 };
    const nTr = marketRef ? marketRef.n : (area.trades || []).length;
    const cats = {
      trades: clamp(nTr / F.tradesFullAt, 0, 1) * (nTr ? 1 : 0),
      jeonse: input.overrides.jeonse != null ? 1
        : area.jeonseMeta ? clamp((area.jeonseMeta.n || 1) / F.jeonseFullAt, 0.4, 1)
        : (area.jeonse > 0 ? 0.6 : 0),
      location: sVal[st('station')] ?? 0,
      education: sVal[st('education')] ?? 0,
      product: (() => {
        const parts = [cx.builtYear != null, cx.households > 0, cx.parkingRatio != null, cx.brandTier != null];
        return parts.filter(Boolean).length / parts.length;
      })(),
      redev: st('redev') === 'UNKNOWN' ? 0.3 : 1,   // '해당 없음' 확인과 미확인을 구분
      supply: sVal[st('supply')] ?? 0.55
    };
    let sum = 0, wsum = 0;
    for (const k of Object.keys(F.weights)) { sum += F.weights[k] * (cats[k] ?? 0); wsum += F.weights[k]; }
    const overall = Math.round(sum / wsum * 100);
    const band = overall >= F.bands.high ? '높음' : overall >= F.bands.mid ? '보통' : '낮음';
    return { cats: Object.fromEntries(Object.entries(cats).map(([k, v]) => [k, Math.round(v * 100)])), overall, band };
  }

  /* ═══════════ V2 §15 사용자 수정 합리성 검증 — 통과 시 USER_VERIFIED(감점 없음) ═══════════ */
  function validateUserEdits(input, cx, area, marketCenter, CFG) {
    const B = (CFG.userEdit && CFG.userEdit.bounds) || {};
    const issues = [];
    const inRange = (v, [lo, hi]) => v >= lo && v <= hi;
    const ov = input.overrides || {};
    if (ov.price != null && marketCenter > 0 && B.priceVsCenter && !inRange(ov.price / marketCenter, B.priceVsCenter))
      issues.push(`입력 시세 ${round1(ov.price)}억이 시장 중심가격과 크게 다릅니다`);
    if (ov.jeonse != null) {
      const p = ov.price != null ? ov.price : marketCenter;
      if (p > 0 && B.jeonseVsPrice && !inRange(ov.jeonse / p, B.jeonseVsPrice))
        issues.push(`입력 전세 ${round1(ov.jeonse)}억이 매매가 대비 비정상 범위입니다`);
    }
    const link = cx.stationLink && cx.stationLink.primary;
    if (link && link.status === 'MANUAL' && B.stationMin && !inRange(link.min, B.stationMin))
      issues.push(`역 도보 ${link.min}분이 검증 범위를 벗어납니다`);
    if (cx.fieldStatus && cx.fieldStatus.households === 'MANUAL' && cx.households > 0 && B.households && !inRange(cx.households, B.households))
      issues.push(`세대수 ${cx.households}가 검증 범위를 벗어납니다`);
    return issues;
  }

  /* ═══════════ V2 §8 확정 미래 / 기대 미래 분리 — 가능성 × 영향으로 표현 ═══════════ */
  function futureSplit(cx, option, CFG) {
    const confirmed = [], optional = [];
    const ft = (cx.location || {}).futureTransit || '';
    if (ft) {
      let stage = null;
      for (const st of CFG.future.transitStages) if (new RegExp(st.re).test(ft)) { stage = st; break; }
      const item = {
        name: ft, type: 'transit',
        likelihood: stage ? (stage.kind === 'confirmed' ? '높음' : '불확실') : '불확실',
        impact: '교통 접근성 개선'
      };
      (stage && stage.kind === 'confirmed' ? confirmed : optional).push(item);
    }
    if (option && option.prob > 0) {
      const conf = option.prob >= (CFG.option.confirmedMinProb ?? 0.7);
      const item = {
        name: `정비사업 — ${option.label}`, type: 'redev',
        likelihood: option.prob >= 0.7 ? '높음' : option.prob >= 0.35 ? '중간' : '낮음',
        prob: option.prob,
        impact: option.premium > 0 ? `가치 상방 ${(option.premium * 100).toFixed(1)}% 반영` : '단계 진행 시 상방 여력'
      };
      (conf ? confirmed : optional).push(item);
    }
    return { confirmed, optional };
  }

  /* ═══════════ V2 문장 헬퍼 — 점수와 설명의 일치를 테스트로 강제 (§46) ═══════════ */
  function attractSentence(score, CFG) {
    const B = CFG.scores.attractBands;
    if (score >= B.high) return '구조 경쟁력 대비 현재 가격 부담이 낮은 편입니다 — 가격 측면의 매력이 있습니다.';
    if (score >= B.mid) return '현재 가격이 경쟁력을 어느 정도 반영하고 있어, 가격 측면의 추가 매력은 중간 수준입니다.';
    if (score >= B.low) return '현재 가격이 이 아파트의 장점을 상당 부분 반영하고 있습니다 — 가격 부담이 있는 편입니다.';
    return '현재 가격에 프리미엄이 크게 반영되어 있어 가격 부담이 높은 편입니다.';
  }
  function oneLinerV2(structuralSc, attractSc, CFG) {
    const S = CFG.scores;
    const stHigh = structuralSc != null && structuralSc >= S.structuralHigh;
    const stMid = structuralSc != null && structuralSc >= S.structuralMid;
    const atHigh = attractSc >= S.attractBands.high;
    const atMid = attractSc >= S.attractBands.mid;
    if (structuralSc == null) return '데이터가 부족해 구조 경쟁력 판단은 보류합니다 — 가격 관련 지표만 참고하세요.';
    if (stHigh && atHigh) return '좋은 아파트이면서, 현재 가격 부담도 경쟁력 대비 상대적으로 낮은 편입니다.';
    if (stHigh && !atMid) return '좋은 아파트이지만 현재 가격 역시 그 장점을 상당 부분 반영하고 있습니다.';
    if (stHigh) return '좋은 아파트이며, 현재 가격은 장점을 어느 정도 반영한 수준입니다.';
    if (stMid && atHigh) return '아파트 자체는 무난한 수준이나, 현재 가격 부담이 낮아 가격 측면의 매력이 있습니다.';
    if (stMid) return '구조 경쟁력과 가격 수준이 모두 중간 범위의 단지입니다.';
    if (atHigh) return '구조 경쟁력은 낮은 편이지만 가격도 그만큼 낮게 거래되고 있습니다.';
    return '구조 경쟁력이 낮은 편이고, 가격 매력도 크지 않습니다.';
  }

  /* ═══════════ V2 §16·18 역 Tier — 절대순위 대신 등급 + 이유 설명 ═══════════ */
  function stationTier(sv, CFG) {
    const bands = CFG.station.v4.tierBands, labels = CFG.station.v4.tierLabels;
    for (let i = 0; i < bands.length; i++) if (sv >= bands[i]) return { label: labels[i], idx: i };
    return { label: labels[bands.length], idx: bands.length };
  }
  function stationReason(comps, CFG) {
    const hi = CFG.station.v4.reasonAxisHigh ?? 85;
    const names = { transit: '교통', econ: '거주민 경제력', edu: '교육·주거', biz: '업무 접근성' };
    const strong = Object.entries(comps || {}).filter(([, v]) => v >= hi).map(([k]) => names[k]);
    if (strong.length >= 3) return `${josa(strong.join('·'), '이', '가')} 모두 상위권이어서 종합평가에서 높은 등급을 받았습니다 — 한 축이 압도적이라기보다 균형이 강점입니다.`;
    if (strong.length) return `${josa(strong.join('·'), '이', '가')} 특히 강해 종합평가를 끌어올렸습니다. 나머지 축은 상대적으로 평이합니다.`;
    return '뚜렷하게 압도적인 축 없이 여러 요소가 고르게 반영된 평가입니다.';
  }

  /* ═══════════ 신뢰도 ═══════════ */
  function confidence(market, disagreement, fillRate, editIssues, CFG, marketRef, finHeld) {
    const C = CFG.confidence.penalties, penalties = [];
    let s = 100;
    if (!marketRef) { s -= 15; penalties.push('시장 기준가 산출 불가 — 비교거래 폴백'); }
    else if (marketRef.windowDays > 180) { s -= 10; penalties.push(`90일 거래 부족으로 기준가 조회기간을 ${marketRef.windowDays}일까지 확장`); }
    else if (marketRef.windowDays > 90) { s -= 5; penalties.push(`90일 거래 부족으로 기준가 조회기간을 ${marketRef.windowDays}일까지 확장`); }
    if (finHeld) { s -= C.jeonseMissing ?? 8; penalties.push('전세 실거래 없음 — 금융·임대 지지가치 분석 보류'); }
    if (market.compCount < 3) { s -= C.compsUnder3; penalties.push(`동일평형 비교거래 ${market.compCount}건 (3건 미만)`); }
    else if (market.compCount < 6) { s -= C.compsUnder6; penalties.push(`동일평형 비교거래 ${market.compCount}건 (6건 미만)`); }
    if (market.latestMonths > 12) { s -= C.latestOver12mo; penalties.push('최근 12개월 내 거래 없음'); }
    else if (market.latestMonths > 6) { s -= C.latestOver6mo; penalties.push('최근 6개월 내 거래 없음'); }
    if (market.compQuality < 0.2) { s -= C.tier3Only; penalties.push('비교거래가 대부분 타단지·타평형'); }
    // V2 §15: 사용자 수정 자체는 감점하지 않는다 — 합리성 검증에 걸린 수정만 감점
    const invalidPen = (CFG.userEdit && CFG.userEdit.invalidPenalty) || 6;
    for (const issue of (editIssues || [])) { s -= invalidPen; penalties.push(`수정값 검증 필요: ${issue}`); }
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
    if (sub.education >= 80) up.push(hed.eduDetail && hed.eduDetail.zoneName ? `선호 학군·학원가 (${hed.eduDetail.zoneName})` : '교육환경 우수');
    if (sub.product >= 80) up.push('신축급 상품성·대단지');
    else if ((cx.households || 0) >= 3000) up.push('대단지 규모');
    if (sub.nature >= 80) up.push('공원·수변 등 자연환경');
    if (support && support.gradeIdx <= 1) up.push(`전세지지력 ${support.label}`);
    if (sup.gradeIdx <= 1) up.push('향후 공급 부족·양호');
    if (opt.gradeIdx <= 1) up.push(`정비사업 기대 (${opt.label})`);
    if (scores.attract.premium <= -0.05) up.push('모델 적정가치 대비 낮은 현재 가격');

    if (scores.attract.premium >= 0.05) down.push('모델 적정가치 대비 높은 현재 가격');
    if (fin && fin.impliedG != null && fin.impliedG > CFG.financial.impliedGrowthConcernOver) down.push('가격에 반영된 미래 성장 기대가 큼');
    if (sub.product < 60) down.push('구축 연식·상품성 열위');
    if ((cx.parkingRatio ?? 1) < 0.7) down.push('주차 경쟁력 부족');
    if (sup.gradeIdx >= 3) down.push(`공급 ${sup.gradeLabel}`);
    if (support && support.gradeIdx >= 3) down.push(`전세지지력 ${support.label}`);
    if (sub.transport < 55) down.push('대중교통 접근성 열위');
    if (cx.supply.txVolumeLevel <= 2) down.push('거래 빈도 낮음 — 가격 발견 제한');
    if (!up.length) up.push('뚜렷한 프리미엄 요인 없음 — 가격 부담이 낮은 편인지 확인');
    if (!down.length) down.push('뚜렷한 하방 요인 없음');

    // 상대적 가치 기여도 (평균적 아파트 60점 대비, 개념적 지표 — 미확인 카테고리 제외)
    const mv = res.marketRef ? res.marketRef.med : res.market.value;
    const contrib = [
      fin ? { k: '금융·임대 지지력', v: clamp((fin.value / mv - 1) * 100, -40, 40) } : null,
      sub.transport != null ? { k: '교통·직주 프리미엄', v: clamp((0.5 * (sub.transport + sub.job) - 60) * 0.9, -40, 40) } : null,
      sub.education != null ? { k: '교육 프리미엄', v: clamp((sub.education - 60) * 0.9 * hed.eduCoeff, -40, 40) } : null,
      (sub.life != null && sub.nature != null) ? { k: '생활·자연환경', v: clamp((0.5 * (sub.life + sub.nature) - 60) * 0.9, -40, 40) } : null,
      sub.product != null ? { k: '상품성·희소성', v: clamp((0.5 * (sub.product + scores.invest.subs.scarcity) - 60) * 0.9, -40, 40) } : null,
      { k: '수급 구조', v: clamp((sup.score - 60) * 0.9, -40, 40) },
      { k: '미래 기대(정비·교통)', v: clamp([30, 18, 5, 0][opt.gradeIdx] + (cx.location.futureTransit && /확정|공사/.test(cx.location.futureTransit) ? 8 : 0), -40, 40) }
    ].filter(Boolean);

    // 조건부 해석
    const interp2 = [];
    const P = res.currentPrice;
    if (!fin) interp2.push('전세 실거래가 없어 금융·임대 지지가치와 역산 성장률 해석은 보류했습니다. STEP 2에서 전세 시세를 입력하면 이 분석이 포함됩니다.');
    if (fin && fin.impliedG != null) {
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
    if (support && support.gradeIdx <= 1 && sup.gradeIdx <= 1)
      interp2.push(`현재 가격이 유지되려면 지금 수준의 전세수요와 공급 ${sup.gradeLabel} 상태가 상당 기간 이어질 필요가 있습니다.`);
    if (sup.gradeIdx >= 3)
      interp2.push(`향후 공급 부담(종합 부담률 ${sup.combined.toFixed(2)})이 현실화되면 전세가격과 매매가격 지지력이 함께 약해질 수 있습니다.`);
    if (scores.living.total >= 78 && scores.attract.score < 55)
      interp2.push(`입지·주거 경쟁력은 높지만, 현재 가격도 이를 상당 부분 선반영하고 있어 가격매력도는 ${scores.attract.score}점에 머뭅니다.`);
    if (scores.attract.score >= 70)
      interp2.push(`지표 대비 상대적으로 낮은 가격 구간입니다. 동·층·향, 내부 상태 등 개별 물건 요인을 함께 확인하세요.`);

    /* 진단형 문장 4종 — 계산 결과(JSON)만으로 template 생성, AI 불필요 */
    const catNames = { transport: '교통', job: '직주근접', education: '교육', life: '생활편의', nature: '자연환경', product: '상품성' };
    const ranked = Object.entries(sub).filter(([, v]) => v != null).sort((a, b) => b[1] - a[1]);
    const top2 = ranked.slice(0, 2).filter(([, v]) => v >= 65);
    const coreBits = [];
    for (const [k] of top2) {
      if (k === 'transport' && res.transit) coreBits.push(`${res.transit.primary.st}(Station Value ${res.transit.primary.sv}) 이용과 강남 접근성(${res.transit.gangnamMin}분)`);
      else if (k === 'job') coreBits.push('주요 업무지까지의 짧은 이동시간');
      else if (k === 'education') coreBits.push(hed.eduDetail && hed.eduDetail.zoneName ? `${hed.eduDetail.zoneName} 교육 생활권` : '교육환경');
      else if (k === 'product') coreBits.push('신축급 상품성과 단지 규모');
      else if (k === 'nature') coreBits.push('공원·수변 자연환경');
      else if (k === 'life') coreBits.push('생활 인프라');
    }
    const core = top2.length
      ? `이 단지의 가장 큰 경쟁력은 ${top2.map(([k]) => catNames[k]).join('과 ')}입니다. ${josa(coreBits.join(', '), '이', '가')} 높은 평가를 받았습니다.`
      : `단일 항목의 두드러진 경쟁력보다는 요소들이 고르게 평균 수준인 단지입니다.`;

    const supBits = [];
    if (support && support.gradeIdx <= 1) supBits.push(`${support.label} 전세지지력`);
    if (sup.gradeIdx <= 1) supBits.push(`공급 ${sup.gradeLabel} 환경`);
    if (sub.job >= 70) supBits.push('직주근접 수요');
    if (sub.education >= 78) supBits.push('학군 수요');
    if (sub.product >= 78) supBits.push('신축·대단지 희소성');
    if (opt.gradeIdx <= 1) supBits.push(`정비사업 기대(${opt.label})`);
    const supportSentence = supBits.length
      ? `${josa(supBits.join(', '), '이', '가')} 현재 가격을 지지하고 있습니다.`
      : `현재 가격을 강하게 지지하는 구조적 요인은 뚜렷하지 않아, 시장 전반의 흐름에 더 민감할 수 있습니다.`;

    const weakBits = [];
    if (fin && res.combineOut.disagreement > 0.35) weakBits.push(`임대(사용)가치가 시장가격보다 크게 낮아(괴리 ${(res.combineOut.disagreement * 100).toFixed(0)}%) 현재 가격에는 향후 기대가 상당 부분 포함되어 있습니다`);
    else if (fin && fin.impliedG != null && fin.impliedG > CFG.financial.impliedGrowthConcernOver) weakBits.push(`현재가 유지에 연 ${(fin.impliedG * 100).toFixed(1)}%의 임대가치 성장이 필요해 기대 선반영 폭이 큽니다`);
    if (support && support.gradeIdx >= 3) weakBits.push(`전세지지력이 ${support.label} 수준입니다`);
    if (sup.gradeIdx >= 3) weakBits.push(`향후 공급이 ${sup.gradeLabel} 구간입니다`);
    if (sub.product < 58) weakBits.push('구축 연식·상품성이 열위입니다');
    if ((cx.parkingRatio ?? 1) < 0.7 && cx.fieldStatus?.parkingRatio !== 'UNKNOWN') weakBits.push('주차 경쟁력이 부족합니다');
    const weakness = weakBits.length ? weakBits.join('. ') + '.' : '지표상 두드러진 취약점은 확인되지 않았습니다.';

    const watchBits = [];
    if (sup.gradeIdx >= 2) watchBits.push('인접 생활권 공급 물량');
    watchBits.push('전세가격 흐름');
    if (opt.prob >= 0.2) watchBits.push('정비사업 진행 속도와 분담금');
    if (fin && fin.impliedG != null && fin.impliedG > fin.g) watchBits.push('금리 방향');
    const watch = `앞으로는 ${josa(watchBits.join(', '), '이', '가')} 이 단지의 가격·투자매력도에 가장 큰 영향을 줄 가능성이 높습니다.`;

    /* ── V3: 한 문장 요약(§59) + 가격을 만드는 핵심요인(§60) ── */
    const V = res.verdicts, ST = res.structural, FU = res.future;
    const driverPool = [];
    if (sub.transport != null && sub.transport >= 70) driverPool.push([sub.transport, res.transit ? `${res.transit.primary.st} 등 강한 역 접근성` : '교통 접근성']);
    if (sub.job != null && sub.job >= 70) driverPool.push([sub.job, '강남·핵심 업무지 접근성']);
    if (sub.education != null && sub.education >= 74) driverPool.push([sub.education, hed.eduDetail && hed.eduDetail.zoneName ? `${hed.eduDetail.zoneName} 교육환경` : '교육환경']);
    if (sub.product != null && sub.product >= 74) driverPool.push([sub.product, '신축·대단지 상품성']);
    if (sub.nature != null && sub.nature >= 78) driverPool.push([sub.nature, '한강·녹지 환경']);
    if (FU && FU.comps.scarcity >= 72) driverPool.push([FU.comps.scarcity, '공급 희소성']);
    if (support && support.gradeIdx <= 1) driverPool.push([support.score, '강한 전세수요']);
    if (opt.gradeIdx <= 1) driverPool.push([80, `정비사업 기대(${opt.label})`]);
    driverPool.sort((a, b) => b[0] - a[0]);
    const drivers = driverPool.slice(0, 4).map(d => d[1]);

    let detailLine = '';
    if (V) {
      const mPart = V.market.idx === 0 ? '현재 가격은 최근 실거래 대비 낮은 편이고'
        : V.market.idx === 2 ? '현재 가격은 최근 실거래 범위보다 높지만'
        : '현재 가격은 최근 실거래 기준 적정 범위이고';
      const fPart = V.financial.held
        ? '전세 실거래가 없어 금융·임대 지지력 판정은 보류했습니다'
        : V.financial.idx >= 2
          ? `금융·임대 수익만으로는 가격의 약 ${Math.round(V.financial.ratio * 100)}%만 설명됩니다`
          : `전세·금리 기준으로도 가격의 약 ${Math.round(V.financial.ratio * 100)}%가 지지됩니다`;
      const dPart = drivers.length ? `다만 ${josa(drivers.slice(0, 3).join(', '), '이', '가')} 나머지 프리미엄을 상당 부분 정당화합니다.` : '구조적 프리미엄 요인은 뚜렷하지 않습니다.';
      const ePart = V.expectation.idx != null && V.expectation.idx >= 2 ? ' 현재 가격에는 미래 성장 기대도 반영되어 있습니다.' : '';
      detailLine = `${mPart}, ${fPart}. ${dPart}${ePart}`;
    }

    /* ── V2 Layer 6 · PRICE INTERPRETATION (§9·§25) — 현재 가격을 사는 것은 무엇을 믿고 사는 것인가 ── */
    const fv = res.futureView || { confirmed: [], optional: [] };
    // 확인된 가치 (이 가격을 설명하는 요소): 구조·전세 등 현재 확인 가능한 것만
    const explains = [];
    for (const d of driverPool) if (!/정비사업 기대/.test(d[1])) explains.push(d[1]);
    if (support && support.gradeIdx <= 1 && !explains.some(x => /전세/.test(x))) explains.push('높은 전세가격과 실수요');
    if ((cx.households || 0) >= 2000 && !explains.some(x => /대단지|상품성/.test(x))) explains.push('대단지 규모');
    for (const c of fv.confirmed) explains.push(`${c.name} (확정·진행 중)`);
    // 이미 가격에 반영된 기대
    const reflected = [];
    if (V && V.expectation.idx != null && V.expectation.idx >= 2 && fin) reflected.push(`미래 임대가치 성장 기대 (현재가 유지에 연 ${(fin.impliedG * 100).toFixed(1)}% 성장 필요)`);
    if (scores.attract.premium >= 0.04) reflected.push('모델 종합가치 상단을 넘는 프리미엄');
    for (const o of fv.optional) reflected.push(`${o.name} 기대 (${o.likelihood})`);
    if (sub.product != null && sub.product >= 82) reflected.push('신축급 상품성 프리미엄');
    // 추가 상승을 위해 필요한 조건
    const upside = [];
    if (fin && fin.impliedG != null && fin.impliedG > fin.gScen.base) upside.push(`임대(전세)가치의 연 ${(fin.impliedG * 100).toFixed(1)}% 이상 성장 지속`);
    else if (fin) upside.push('전세가격의 완만한 상승 지속');
    if (sup.combined >= 0.9) upside.push('주변 공급 부담 완화');
    if (fv.optional.some(o => o.type === 'transit')) upside.push('교통 호재의 착공·개통 현실화');
    if (fin && fin.impliedG != null && fin.impliedG > 0) upside.push('금리 하락(요구수익률 부담 완화)');
    // 깨질 경우 위험한 조건
    const risks = [];
    if (sup.gradeIdx >= 2) risks.push(`향후 공급 부담 (종합 부담률 ${sup.combined.toFixed(2)})`);
    if (support ? support.gradeIdx >= 2 : true) risks.push('전세가격 하락 시 지지력 약화');
    else risks.push('전세가격이 꺾일 경우 지지력 둔화');
    if (V && V.expectation.idx != null && V.expectation.idx >= 2) risks.push('선반영된 성장 기대의 미실현');
    if (fv.optional.some(o => o.type === 'redev')) risks.push('정비사업 지연·분담금 증가');
    if (res.finHeld) risks.push('전세 데이터 미확인 — 지지력 검증 불가');
    const priceView = {
      explains: explains.slice(0, 3),
      reflected: reflected.slice(0, 3),
      upside: upside.slice(0, 3),
      risks: risks.slice(0, 3),
      cautions: risks.slice(0, 2)
    };
    const oneLiner = oneLinerV2(res.structural ? res.structural.score : null, scores.attract.score, CFG);

    return { up, down, contrib, interpretation: interp2, diagnosis: { core, support: supportSentence, weakness, watch }, oneLiner, detailLine, drivers, priceView };
  }

  /* ═══════════ 메인 파이프라인 ═══════════ */
  function analyze(rawInput, CFG, HUBS, JOBS, STN) {
    const input = {
      asOfYM: rawInput.asOfYM, asOfYear: Number(rawInput.asOfYM.split('-')[0]),
      overrides: rawInput.overrides || {}, useRent: !!rawInput.useRent,
      manualComplex: !!rawInput.manualComplex,
      // §25 기여도 재계산: neutralize = 중립화 카테고리, attribution = 속성 기여를 전액 측정
      // (잔차 감쇄 없이 — "이 가격에 얼마나 반영되어 있나"의 분해용. 일반 분석에는 사용 안 함)
      neutralize: Array.isArray(rawInput.neutralize) && rawInput.neutralize.length ? new Set(rawInput.neutralize) : null,
      attribution: !!rawInput.attribution
    };
    const cx = rawInput.complex;
    const area = cx.areas.find(a => a.key === rawInput.areaKey) || cx.areas[0];
    const gaps = [];
    if (Array.isArray(cx.dataGaps)) gaps.push(...cx.dataGaps);   // 자동 수집 단지의 결측 항목

    // Engine A: 비교거래 앵커(폴백용) + V3 시장 기준가(기간창 가중중앙값)
    const market = engineMarket(cx, area, input, CFG);
    if (!market.value) {
      // V2 §39: 억지로 계산하지 않는다 — 부족 데이터 목록과 함께 안내 (err.user로 시스템 오류와 구분)
      const err = new Error('현재 확보된 데이터만으로는 신뢰할 만한 진단을 제공하기 어렵습니다. 현재 시세를 입력하면 확보된 정보 기준으로 분석합니다.');
      err.user = true;
      err.missing = ['최근 실거래(또는 현재 시세 입력)'];
      if (!(cx.households > 0)) err.missing.push('세대수');
      if (!cx.stationLink) err.missing.push('역·위치 정보');
      if (!cx.areas.some(a => a.jeonse > 0)) err.missing.push('전세 실거래');
      throw err;
    }
    const marketRef = marketReference(area, input, CFG);

    // 현재 시장가격: 사용자 수정 > 대표 최근가 (V3.2 — 이상 저가 1건이면 3개월 최고가로 보정)
    const rep = repRecentPrice(area, input.asOfYM, CFG);
    const basePrice = input.overrides.price != null ? input.overrides.price : (rep ? rep.price : market.value);
    const currentPrice = basePrice * (input.overrides.priceMul || 1);

    // Engine D 수급 → Station → Engine C 히도닉 → Engine E 옵션
    const supplyE = engineSupply(cx, input, CFG);
    const transit = engineTransit(cx, input, CFG, JOBS, STN, gaps);
    const hedonic = engineHedonic(cx, area, input, CFG, HUBS, JOBS, gaps, transit);
    const option = engineOption(cx, input, CFG, gaps);
    // 미래가치 엔진 (5축 → g 시나리오) → Engine B 금융 (시나리오 범위)
    // 전세 없음 → fin=null (금융·전세지지력만 보류, 나머지 분석은 계속 — FR-03)
    const future = engineFuture(cx, supplyE, hedonic, option, CFG, input);
    const fin = engineFinancial(cx, area, input, CFG, currentPrice, future.g);
    const finHeld = !fin;
    if (finHeld) gaps.push('전세 실거래 없음 — 금융·임대 지지가치 분석 보류');
    const support = jeonseSupport(fin, cx.supply, supplyE.combined, CFG);

    // 데이터 충족률 (조망 등 결측 + 수동입력 단지 감안)
    const expectedGapBase = 10;
    const fillRate = clamp(1 - gaps.length / expectedGapBase - (input.manualComplex ? 0.15 : 0), 0.5, 1);

    // 결합 + 범위 (attribution 모드는 잔차 감쇄 없이 속성 반영분 전액을 측정 — §25 분해 전용)
    const combineOut = combine(market, fin, hedonic, supplyE, option, CFG, input.attribution ? 0 : market.compQuality);
    const range = valueRange(combineOut.center, market, combineOut.disagreement, fillRate, CFG);

    // 점수
    const living = { total: livingScore(hedonic, CFG), subs: hedonic.subs };
    const invest = investScore(cx, hedonic, supplyE, option, support, CFG);
    const attract = attractScore(currentPrice, combineOut.center, range, support, CFG);

    // V2 §15: 사용자 수정 합리성 검증 → 통과 시 감점 없음 (USER_VERIFIED)
    const marketCenter = marketRef ? marketRef.med : market.value;
    const editIssues = validateUserEdits(input, cx, area, marketCenter, CFG);
    const conf = confidence(market, combineOut.disagreement, fillRate, editIssues, CFG, marketRef, finHeld);

    // V2 §13: 카테고리별 데이터 충족도 (신뢰도 헤드라인)
    const fulfillment = fulfillmentOf(cx, area, marketRef, input, CFG);

    // 데이터 상태 집계 (VERIFIED / ESTIMATED / MANUAL / UNKNOWN — §39)
    let dataStatus = null;
    if (cx.fieldStatus) {
      dataStatus = { VERIFIED: 0, ESTIMATED: 0, MANUAL: 0, UNKNOWN: 0 };
      for (const v of Object.values(cx.fieldStatus)) if (dataStatus[v] != null) dataStatus[v]++;
    }

    // V2 판정 3종 + 구조 경쟁력 (미래 제외) + 확정/기대 미래 분리
    const structural = structuralScore(hedonic, scarcityBase(cx, CFG), CFG);
    const futureView = futureSplit(cx, option, CFG);
    const verdicts = {
      market: marketVerdict(currentPrice, marketRef, CFG),
      financial: financialGrade(fin, currentPrice, CFG),
      expectation: expectationGrade(fin, CFG)
    };

    // 계산 trace (§86 — debug 모드 표시용)
    const trace = [
      ['시장 기준가', marketRef ? `${round1(marketRef.low)}~${round1(marketRef.high)}억 (중앙 ${round1(marketRef.med)}, ${marketRef.windowDays}일창 ${marketRef.n}건, 이상치 ${marketRef.nOutlier})` : '없음 → 비교거래 폴백'],
      ['최근 실거래', marketRef ? `${marketRef.latest.date} · ${marketRef.latest.price}억 · ${marketRef.latest.floor}층${marketRef.latest.outlier ? ' [이상치]' : ''}` : '—'],
      ['현재가', `${round1(currentPrice)}억 (${input.overrides.price != null ? '사용자 입력' : '최근 실거래'}${rep && rep.anomalous ? ' · 이상 저가 가능성 — 사실 그대로 표시' : rep && rep.anomalousHigh ? ' · 이상 고가 가능성 — 사실 그대로 표시' : ''})`],
      ['R 연간주거서비스', fin ? `${(fin.R).toFixed(3)}억 = ${fin.rSourceText}` : '전세 없음 — 보류'],
      ['요구수익률 r', fin ? (fin.r * 100).toFixed(2) + '%' : '—'],
      ['g 시나리오', `보수 ${(future.g.low * 100).toFixed(1)}% / 기준 ${(future.g.base * 100).toFixed(1)}% / 우호 ${(future.g.high * 100).toFixed(1)}% (미래점수 ${future.score})`],
      ['금융지지가치', fin ? `${round1(fin.fsv.low)}~${round1(fin.fsv.high)}억 (기준 ${round1(fin.fsv.base)}, ${fin.mode})` : '전세 없음 — 분석 보류'],
      ['역산 g*', fin && fin.impliedG != null ? (fin.impliedG * 100).toFixed(2) + '%' : '—'],
      ['미래 5축', Object.entries(future.comps).map(([k, v]) => `${k}:${v == null ? '제외' : Math.round(v)}`).join(' ')],
      ['히도닉 조정', Object.entries(hedonic.adj).map(([k, v]) => `${k}:${(v * 100).toFixed(1)}%`).join(' ') + ` → 총 ${(hedonic.total * 100).toFixed(1)}% (잔차 ${(combineOut.hRes * 100).toFixed(1)}%)`],
      ['수급 조정', (supplyE.adj * 100).toFixed(1) + '%'],
      ['옵션 프리미엄', (option.premium * 100).toFixed(1) + '%'],
      ['구조 경쟁력', structural.score != null ? `${structural.score} (${structural.band})${structural.excluded.length ? ' · 제외: ' + structural.excluded.join(',') : ''}` : '데이터 부족 — 보류'],
      ['데이터 충족도', `${fulfillment.overall}% (${fulfillment.band}) — ` + Object.entries(fulfillment.cats).map(([k, v]) => `${k}:${v}`).join(' ')],
      ['판정', `시장 ${verdicts.market.label} / 금융 ${verdicts.financial.held ? verdicts.financial.label : verdicts.financial.label + '(' + Math.round(verdicts.financial.ratio * 100) + '%)'} / 기대 ${verdicts.expectation.label}`],
      ['신뢰도', `${conf.score} (${conf.label}) — ${conf.penalties.join('; ') || '감점 없음'}`]
    ];

    attract.sentence = attractSentence(attract.score, CFG);
    const res = {
      cx, area, input, currentPrice, repPrice: rep, market, marketRef, marketCenter, financial: fin, finHeld, support, hedonic, supplyE, option,
      future, futureView, structural, verdicts, transit, combineOut, range, gaps, fillRate, fulfillment, editIssues, dataStatus, trace,
      scores: { living, invest, attract },
      confidence: conf
    };
    res.explain = buildExplain(res, cx, area, CFG);
    return res;
  }

  /* ═══════════ V3.3 P0 헬퍼 (FR-01·02·04) — 순수함수, Node 테스트 가능 ═══════════ */

  /* FR-04 평형 기본선택: 거래 0건 평형은 기본선택하지 않는다.
     거래 있는 평형 중 ①84㎡ 최근접 → ②59㎡ 최근접 → ③거래량 많은 순. 거래가 전혀 없으면 첫 평형. */
  function pickDefaultAreaKey(areas, prefs) {
    const P = prefs || [84, 59];
    const list = (areas || []).filter(a => a && a.key != null);
    if (!list.length) return null;
    const m2Of = a => a.m2 > 0 ? a.m2 : Number(a.key) || 0;
    const traded = list.filter(a => (a.trades || []).length > 0);
    if (!traded.length) return list[0].key;
    const sorted = traded.slice().sort((a, b) =>
      Math.abs(m2Of(a) - P[0]) - Math.abs(m2Of(b) - P[0]) ||
      Math.abs(m2Of(a) - P[1]) - Math.abs(m2Of(b) - P[1]) ||
      (b.trades || []).length - (a.trades || []).length);
    return sorted[0].key;
  }

  /* FR-02 단지명 정규화 (K-apt 매칭·검색 공용): 공백·괄호 제거, 영문 브랜드 한글화, 아파트·맨션 접미어 제거
     — pipeline/complex_info.js normName과 반드시 동일해야 K-apt 매칭이 성립한다 */
  function normNameK(s) {
    return String(s || '').toLowerCase()
      .replace(/\s|\(.*?\)/g, '')
      .replace(/i-?park/g, '아이파크').replace(/e-?편한세상/g, '이편한세상')
      .replace(/(아파트|맨션)$/g, '');
  }

  /* FR-01 검색 정규화: 통칭(동이름+단지명)·브랜드 접두어·공백 차이를 흡수.
     entry: {n:단지명, gn:시군구, d:법정동}, opts: {brandPrefixes:[], aliases:[]} */
  function liveSearchHay(entry, aliases) {
    const dongPrefix = String(entry.d || '').replace(/동$/, '');
    const parts = [entry.n, entry.gn, entry.d, dongPrefix + entry.n, String(entry.gn || '').replace(/\s/g, '') + entry.n, ...(aliases || [])];
    return parts.map(normNameK).join('').toLowerCase();
  }
  function liveSearchMatch(q, entry, opts) {
    const o = opts || {};
    const hay = liveSearchHay(entry, o.aliases);
    const tokens = String(q || '').toLowerCase().split(/\s+/).map(normNameK).filter(Boolean);
    if (!tokens.length) return false;
    if (tokens.every(t => hay.includes(t))) return true;
    // 브랜드 접두어 제거 후 재시도 (예: "e편한세상옥수파크힐스" → "옥수파크힐스")
    const brands = o.brandPrefixes || [];
    if (!brands.length) return false;
    const re = new RegExp(`^(${brands.map(normNameK).join('|').toLowerCase()})`);
    const stripped = tokens.map(t => t.replace(re, '')).filter(Boolean);
    return stripped.length > 0 && stripped.every(t => hay.includes(t));
  }

  /* FR-01 분할 등재 단지 병합: 실거래명이 동 구간별로 나뉜 물리단지를 하나로 합친다.
     거래 원자료는 그대로 합산, 전세 대표값은 관측 수가 많은 쪽을 대표로 쓴다. */
  function mergeLiveEntries(displayName, entries) {
    const areas = {};
    for (const e of entries) {
      for (const [k, a] of Object.entries(e.areas || {})) {
        if (!areas[k]) areas[k] = { m2: a.m2, trades: [], jeonse: null };
        areas[k].trades.push(...(a.trades || []));
        if (a.jeonse && (!areas[k].jeonse || (a.jeonse.n || 0) > (areas[k].jeonse.n || 0))) areas[k].jeonse = a.jeonse;
      }
    }
    for (const k of Object.keys(areas)) areas[k].trades.sort((x, y) => (y.ym + '|' + String(y.d || 0).padStart(2, '0')).localeCompare(x.ym + '|' + String(x.d || 0).padStart(2, '0')));
    const first = entries[0] || {};
    return {
      name: displayName, dong: first.dong, builtYear: first.builtYear || null, aptSeq: first.aptSeq || null,
      areas, mergedFrom: entries.map(e => e.name)
    };
  }

  /* FR-02 K-apt 기본정보 매칭: complex_info 샤드(byName, normName 키)에서 실거래 단지명으로 조회.
     별칭(aliases — 예: 파크리오의 K-apt명 "잠실파크리오")도 시도. 동명 복수 후보(ambiguous)는
     자동 확정하지 않고 null(검수 대기). 기준일은 샤드 meta에서 보강. */
  function matchKaptInfo(info, entryName, aliases) {
    if (!info || !info.byName) return null;
    let rec = null;
    for (const cand of [entryName, ...(aliases || [])]) {
      const hit = info.byName[normNameK(cand)];
      if (hit && !hit.ambiguous && hit.households > 0) { rec = hit; break; }
    }
    if (!rec) return null;
    return rec.asOf || !info.meta ? rec : { ...rec, asOf: info.meta.asOf };
  }

  /* ═══ §23-26 가격 기여도 — 실제 재계산: 요소를 중립으로 바꿔 전체 모델을 다시 돌린 차이 ═══
     attribution 모드(잔차 감쇄 없이 속성 반영분 전액 측정)에서 기준 계산과 중립화 계산을
     각각 수행한다. 단순 설명용 문구 생성 금지(§25) — 금액은 전부 재계산 결과다. */
  function priceContributions(rawInput, CFG, HUBS, JOBS, STN) {
    const attrIn = Object.assign({}, rawInput, { attribution: true, neutralize: null });
    let base;
    try { base = analyze(attrIn, CFG, HUBS, JOBS, STN); } catch (e) { return null; }
    const sub = base.hedonic.subs;
    const defs = [
      { id: 'transit', label: '교통·직주근접', has: sub.transport != null || sub.job != null },
      { id: 'education', label: '교육환경', has: sub.education != null },
      { id: 'product', label: '단지·상품성', has: sub.product != null },
      { id: 'lifeNature', label: '생활·자연환경', has: sub.life != null || sub.nature != null },
      { id: 'supply', label: '수급(공급 부담)', has: true },
      { id: 'future', label: '미래 기대(정비·교통)', has: base.option.prob > 0 || !!(base.cx.location && base.cx.location.futureTransit) }
    ];
    const items = [];
    for (const d of defs) {
      if (!d.has) continue;
      let r2;
      try { r2 = analyze(Object.assign({}, attrIn, { neutralize: [d.id] }), CFG, HUBS, JOBS, STN); } catch (e) { continue; }
      const amt = base.combineOut.center - r2.combineOut.center;
      items.push({ id: d.id, label: d.label, amt: Math.round(amt * 100) / 100 });
    }
    items.sort((a, b) => b.amt - a.amt);
    return {
      center: base.combineOut.center,
      items,
      up: items.filter(i => i.amt >= 0.05).slice(0, 3),
      down: items.filter(i => i.amt <= -0.05).sort((a, b) => a.amt - b.amt).slice(0, 2),
      note: '각 금액은 해당 요소를 중립 기준으로 바꿔 전체 모델을 다시 계산했을 때의 차이 — 가격에 미친 추정 영향입니다. 요소 간 상호작용 때문에 합계가 전체 가격차와 정확히 일치하지 않을 수 있습니다.'
    };
  }

  /* ═══ 자동수집 단지 → 엔진 스키마 (ui에서 이동 — AC-09 Node E2E 테스트 가능) ═══
     entry: 샤드 단지 {name,dong,builtYear,aptSeq,areas}, region: regions.json 항목
     o: { edits:{households,redevStage,supplyNext3yAvg,station}, ovPrice, areaKey,
          conv, asOf, stations(STN), hubs(HUBS), dongLink([{st,min}]|null), kapt(rec|null), liveId } */
  function buildAutoComplex(entry, region, o) {
    const e = (o && o.edits) || {};
    const STN = o.stations, kapt = o.kapt || null;
    const gaps = [];
    // §12: 교육생활권 매칭 — 법정동 → (실패 시) 주력역 좌표 거리. 행정동 문자열 매칭 폐기
    const dl0 = o.dongLink;
    const stCoord = dl0 && dl0.length && STN && STN.stations[dl0[0].st] ? STN.stations[dl0[0].st].c : null;
    const zoneM = matchEduZone(o.hubs, { dong: entry.dong, district: region.district || region.name, coord: stCoord }, null);
    const hhManual = e.households > 0;
    const hhKapt = !hhManual && kapt ? kapt.households : null;
    const households = hhManual ? e.households : (hhKapt || null);
    // 준공연도: 실거래 원자료 우선, 없으면 K-apt 사용승인일(FR-02)
    const kaptYear = kapt && kapt.usedate ? Number(String(kapt.usedate).slice(0, 4)) || null : null;
    const builtYear = entry.builtYear || kaptYear || null;
    if (!households) gaps.push('세대수 미확인 (중립 가정)');
    if (!e.redevStage) gaps.push('정비사업 단계 미확인');
    if (!builtYear) gaps.push('준공연도 미확인');
    if (kapt && kapt.parkingRatio != null) gaps.push('브랜드·생활·자연환경 기본값 사용');
    else gaps.push('주차·브랜드·생활·자연환경 기본값 사용');
    if (!zoneM) gaps.push('교육생활권 미확인 — 교육 평가 제외');

    // 역 연결: 사용자 입력(MANUAL) > 법정동 자동 연결(ESTIMATED) > 미확인(UNKNOWN)
    let stationLink = null, unknownTransport = false, stStatus = 'UNKNOWN';
    const es = e.station;
    if (es && es.st && STN && STN.stations[es.st]) {
      stationLink = { primary: { st: es.st, min: es.min > 0 ? es.min : 8, status: 'MANUAL' } };
      stStatus = 'MANUAL';
    } else {
      const dl = o.dongLink;
      if (dl && dl.length && STN && STN.stations[dl[0].st]) {
        stationLink = {
          primary: { st: dl[0].st, min: dl[0].min, status: 'ESTIMATED' },
          secondary: dl[1] && STN.stations[dl[1].st] ? { st: dl[1].st, min: dl[1].min } : null
        };
        stStatus = 'ESTIMATED';
      } else { unknownTransport = true; }
    }

    const fieldStatus = {
      price: o.ovPrice != null ? 'MANUAL' : 'VERIFIED',
      jeonse: o.ovJeonse != null ? 'MANUAL' : (Object.values(entry.areas).some(a => a.jeonse) ? 'VERIFIED' : 'UNKNOWN'),
      builtYear: builtYear ? 'VERIFIED' : 'UNKNOWN',
      households: hhManual ? 'MANUAL' : (hhKapt ? 'VERIFIED' : 'UNKNOWN'),
      station: stStatus,
      redev: e.redevStage ? 'MANUAL' : 'UNKNOWN',
      supply: e.supplyNext3yAvg > 0 ? 'MANUAL' : 'ESTIMATED',
      education: zoneM ? 'ESTIMATED' : 'UNKNOWN',
      lifeNature: 'UNKNOWN',
      product: households || (kapt && kapt.parkingRatio != null) ? 'ESTIMATED' : 'UNKNOWN'
    };

    const areas = Object.entries(entry.areas).map(([k, a]) => ({
      key: k, label: `전용 ${k}㎡형`, m2: a.m2,
      trades: (a.trades || []).map(t => ({ ym: t.ym, price: t.price, floor: t.floor })),
      jeonse: a.jeonse ? a.jeonse.v : null, jeonseMeta: a.jeonse || null
    })).sort((x, y) => Number(x.key) - Number(y.key));

    // 이 단지에 매매 실거래가 전혀 없으면, 사용자가 입력한 시세를 앵커로 사용
    const totTrades = areas.reduce((s, a) => s + a.trades.length, 0);
    if (!totTrades && o.ovPrice > 0) {
      const sel = areas.find(a => a.key === o.areaKey) || areas[0];
      sel.trades = [{ ym: o.asOf, price: o.ovPrice, floor: 0 }];
      gaps.push('매매 실거래 없음 — 입력 시세 기준');
    }

    return {
      id: 'live|' + (o.liveId || `${region.code}|${entry.dong}|${entry.name}`), name: entry.name, aptSeq: entry.aptSeq || null,
      city: region.sido, district: region.name, dong: entry.dong,
      regionTier: region.tier, builtYear,
      // §10·12: 임의 기본값 폐기 — 미확인은 null로 두고 엔진이 해당 항목을 제외·재정규화한다
      households,
      householdsNote: hhManual ? null : (hhKapt ? `K-apt 확인${kapt.asOf ? ' · ' + kapt.asOf + ' 기준' : ''}` : null),
      householdsSource: hhManual ? 'MANUAL' : (hhKapt ? 'KAPT' : null),
      brandTier: null,
      parkingRatio: kapt && kapt.parkingRatio != null ? kapt.parkingRatio : null,
      far: null, rentalShare: null,
      redev: { stage: e.redevStage || 'none' },
      conversionRate: o.conv != null ? o.conv : region.conv,
      tags: ['실거래 자동'], dataGaps: gaps, fieldStatus, stationLink,
      areas,
      location: { subwayMin: stationLink ? stationLink.primary.min : null, unknownTransport, lines: [], transfer: false, express: false, futureTransit: null, jobMinutes: region.jobMinutes },
      // 교육 V2: 생활권 존 구성요소로만 평가 — 단지 수준 임의 기본값(elemM 400 등) 폐기(§53 평균값 임의 입력 금지)
      education: zoneM ? { zoneId: zoneM.zone.id, adjacent: zoneM.adjacent, matchedVia: zoneM.via } : null,
      life: null, nature: null,   // 시설 거리 데이터 미확보 — 평가 제외 (10분 기본값 폐기, §56)
      supply: {
        pop: region.pop, next3yAvg: e.supplyNext3yAvg > 0 ? e.supplyNext3yAvg : region.supplyNext3yAvg,
        adjacentRatio: region.adjacentRatio, metroRatio: region.metroRatio,
        unsoldLevel: 2, txVolumeLevel: 3, jeonseListingsLevel: 3, jeonseTrend: 'stable', regulated: region.regulated
      }
    };
  }

  /* 스트레스 테스트: 프리셋 id 배열 → 오버라이드 병합 후 재계산 */
  function applyStress(rawInput, presetIds, CFG, HUBS, JOBS, STN) {
    const ov = Object.assign({}, rawInput.overrides);
    for (const id of presetIds) {
      const p = CFG.stress.presets.find(x => x.id === id);
      if (!p) continue;
      for (const [k, v] of Object.entries(p.apply)) {
        if (k === 'rateDelta') ov.rateDelta = (ov.rateDelta || 0) + v;
        else ov[k] = v;
      }
    }
    return analyze(Object.assign({}, rawInput, { overrides: ov }), CFG, HUBS, JOBS, STN);
  }

  return {
    analyze, applyStress, repRecentPrice, interp, weightedMedian, weightedPercentile, monthsBetween, clamp, round1, havKm,
    josa, pickDefaultAreaKey, normNameK, liveSearchHay, liveSearchMatch, mergeLiveEntries, matchKaptInfo, buildAutoComplex,
    attractSentence, oneLinerV2, stationTier, stationReason, futureSplit, fulfillmentOf, validateUserEdits,
    eduScoreFromComponents, eduZoneScore, matchEduZone, eduDetailOf, priceContributions
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = AptEngine;
