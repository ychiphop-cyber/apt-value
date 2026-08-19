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
    return {
      med, low: med - half, high: med + half,
      windowDays, extended: windowDays != null && windowDays > M.windowsDays[0],
      n: win.length, nOutlier: win.filter(t => t.o).length,
      latest: { date: `${latest.ym}-${String(latest.d || 15).padStart(2, '0')}`, price: latest.price, floor: latest.floor, outlier: !!latest.o, daysAgo: latest.days },
      dispersion: med > 0 ? Math.max(0, (p75 - p25) / med / 2) : 0.04
    };
  }

  /* ═══════════ 대표 최근가 (V3.2) ═══════════
     '최근 실거래 1건'이 특수관계인 거래 등 이상 저가면 그 값이 현재가로 표기되는
     문제 보정: 직전 거래가 최근 3개월 또래 거래 중앙값보다 뚜렷이 낮으면(또는
     이상거래 플래그) 최근 3개월 내 최고가로 표기한다. 최근 거래가 우선 원칙 유지. */
  function repRecentPrice(area, asOfYM, CFG) {
    const A = (CFG.marketRef && CFG.marketRef.anomalyLow) || { windowDays: 92, ratio: 0.85, minPeers: 2 };
    const all = (area.trades || []).slice().sort((a, b) => dateOf(b) - dateOf(a));
    if (!all.length) return null;
    const latest = all[0];
    const base = { price: latest.price, latest, anomalous: false };
    const t0 = dateOf(latest);
    const win = all.filter(t => (t0 - dateOf(t)) / 86400000 <= A.windowDays && !t.o);
    const peers = win.filter(t => t !== latest);
    if (peers.length < A.minPeers) return base;
    const sortedP = peers.map(t => t.price).sort((a, b) => a - b);
    const peerMed = sortedP.length % 2 ? sortedP[(sortedP.length - 1) / 2]
      : (sortedP[sortedP.length / 2 - 1] + sortedP[sortedP.length / 2]) / 2;
    if (latest.o || latest.price < A.ratio * peerMed) {
      const top = win.reduce((m, t) => Math.max(m, t.price), 0);
      return { price: top, latest, anomalous: true, peerMed: round1(peerMed), windowDays: A.windowDays };
    }
    return base;
  }

  /* ═══════════ 미래가치 엔진 (V3 §24~28) — 5축 → g 시나리오 ═══════════ */
  function engineFuture(cx, supplyE, hedonic, option, CFG) {
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
    // 요구수익률 r (합성)
    const r = F.altReturn + F.liquidityPremium + F.assetRiskPremium + (F.regionRiskPremium[cx.regionTier] ?? F.regionRiskPremium['기타']) + rateDelta;
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
    return { R, r, g: gs.base, gScen: gs, conv, mode: base.mode, value: base.v, fsv, impliedG, jeonse, jeonseRatio, equity, rSourceText };
  }

  /* 금융 지지력 등급 (V3 §21) */
  function financialGrade(fin, currentPrice, CFG) {
    const G = CFG.financialGrade;
    const ratio = currentPrice > 0 ? fin.fsv.base / currentPrice : 0;
    let i = G.bands.length;
    for (let k = 0; k < G.bands.length; k++) if (ratio >= G.bands[k]) { i = k; break; }
    return { ratio, label: G.labels[i], idx: i };
  }

  /* 미래 기대 반영도 (V3 §21·29): 역산 g* vs 시나리오 밴드 */
  function expectationGrade(fin, CFG) {
    const L = CFG.verdicts.expectationLabels;
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

  /* 장기 경쟁력 Score (V3 §19) — 미확인 카테고리 제외·재정규화 */
  function structuralScore(hedonic, future, CFG) {
    const W = CFG.structural.weights;
    const comps = {
      transit: hedonic.subs.transport, job: hedonic.subs.job, education: hedonic.subs.education,
      product: hedonic.subs.product, nature: hedonic.subs.nature, life: hedonic.subs.life,
      scarcity: future.comps.scarcity, future: 0.6 * future.comps.transitChange + 0.4 * future.comps.redevOption
    };
    let sum = 0, wsum = 0;
    const used = {};
    for (const k of Object.keys(W)) {
      if (comps[k] == null || !isFinite(comps[k])) continue;
      sum += W[k] * comps[k]; wsum += W[k]; used[k] = Math.round(comps[k]);
    }
    const score = wsum > 0 ? clamp(sum / wsum, 0, 100) : 50;
    const band = CFG.structural.bands.find(b => score >= b.min) || CFG.structural.bands[CFG.structural.bands.length - 1];
    return { score: Math.round(score), band: band.label, comps: used, excluded: Object.keys(W).filter(k => comps[k] == null) };
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
    if (cx.location && cx.location.futureTransit) {
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
      if (loc.futureTransit) {
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

    // 교육 (4개 하위 모듈) — 정보 전체 미확인이면 항목 제외 + 재정규화 (§12)
    let eduScore = null, eduCoeff = 0, school = null, academy = null, access = null, demand = null, hub = null;
    if (edu) {
      const elemBase = edu.elemM <= 300 ? 95 : edu.elemM <= 500 ? 85 : edu.elemM <= 800 ? 72 : 55;
      school = clamp(0.45 * (elemBase + (edu.chopuma ? 3 : 0)) + 0.55 * [40, 55, 70, 84, 95][(edu.middlePref || 3) - 1], 0, 100);
      hub = edu.inHub && edu.hubId ? HUBS.hubs.find(h => h.id === edu.hubId) : null;
      academy = hub ? hub.initial_strength
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
      access = clamp(accessCands[0].v, 0, 100);
      demand = interp(edu.age3049 || 0.28, [[0.24, 45], [0.27, 58], [0.30, 72], [0.33, 84], [0.36, 92]]);
      demand += edu.studentTrend === 'up' ? 5 : edu.studentTrend === 'down' ? -7 : 0;
      demand = clamp(demand, 0, 100);
      eduScore = E.subWeights.school * school + E.subWeights.academy * academy + E.subWeights.access * access + E.subWeights.demand * demand;
      const coeffTier = hub ? hub.tier : Math.min(4, (accessCands[0].tier || 4) + 1);
      eduCoeff = E.coefficientByTier[String(coeffTier)] ?? 0.55;
      notes.education = [
        `학교환경 ${Math.round(school)} · 학원가 ${Math.round(academy)} · 교육접근성 ${Math.round(access)} · 수요지속성 ${Math.round(demand)}`,
        hub ? `${hub.hub_name} 허브 생활권 (계수 ×${eduCoeff})` : `주요 교육 허브 비생활권 (계수 ×${eduCoeff})`
      ];
    } else {
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
    let s = 0, w = 0;
    for (const k of Object.keys(W)) {
      if (hed.subs[k] == null) continue;   // 미확인 카테고리 제외 + 재정규화 (§12)
      s += W[k] * hed.subs[k]; w += W[k];
    }
    return w > 0 ? clamp(s / w, 0, 100) : 50;
  }

  function investScore(cx, hed, sup, opt, support, CFG) {
    const W = CFG.scores.invest;
    const tierScore = { '서울핵심': 88, '서울': 78, '수도권핵심': 72, '수도권': 60, '지방광역': 52, '기타': 46 }[cx.regionTier] ?? 50;
    // 희소성: 미확인 구성요소는 제외·재정규화
    const sc = [
      [0.4, cx.households > 0 ? clamp(35 + 14 * Math.log(cx.households / 100), 40, 95) : null],
      [0.25, cx.brandTier ? [92, 82, 70, 58][cx.brandTier - 1] : null],
      [0.35, tierScore]
    ].filter(x => x[1] != null);
    const scW = sc.reduce((a, x) => a + x[0], 0);
    const scarcity = clamp(sc.reduce((a, x) => a + x[0] * x[1], 0) / scW + (opt.gradeIdx <= 1 ? 5 : 0), 0, 100);
    let future = [88, 74, 60, 48][opt.gradeIdx];
    if (cx.location.futureTransit && /확정|공사/.test(cx.location.futureTransit)) future = clamp(future + 6, 0, 100);
    const location = hed.subs.transport != null ? clamp(0.55 * hed.subs.job + 0.45 * hed.subs.transport, 0, 100) : clamp(hed.subs.job, 0, 100);
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
  function confidence(market, disagreement, fillRate, manualCount, CFG, marketRef) {
    const C = CFG.confidence.penalties, penalties = [];
    let s = 100;
    if (!marketRef) { s -= 15; penalties.push('시장 기준가 산출 불가 — 비교거래 폴백'); }
    else if (marketRef.windowDays > 180) { s -= 10; penalties.push(`거래 부족으로 기준가 기간 ${marketRef.windowDays}일로 확장`); }
    else if (marketRef.windowDays > 90) { s -= 5; penalties.push(`거래 부족으로 기준가 기간 ${marketRef.windowDays}일로 확장`); }
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

    // 상대적 가치 기여도 (평균적 아파트 60점 대비, 개념적 지표 — 미확인 카테고리 제외)
    const mv = res.marketRef ? res.marketRef.med : res.market.value;
    const contrib = [
      { k: '금융·임대 지지력', v: clamp((fin.value / mv - 1) * 100, -40, 40) },
      sub.transport != null ? { k: '교통·직주 프리미엄', v: clamp((0.5 * (sub.transport + sub.job) - 60) * 0.9, -40, 40) } : null,
      sub.education != null ? { k: '교육 프리미엄', v: clamp((sub.education - 60) * 0.9 * hed.eduDetail.eduCoeff, -40, 40) } : null,
      (sub.life != null && sub.nature != null) ? { k: '생활·자연환경', v: clamp((0.5 * (sub.life + sub.nature) - 60) * 0.9, -40, 40) } : null,
      sub.product != null ? { k: '상품성·희소성', v: clamp((0.5 * (sub.product + scores.invest.subs.scarcity) - 60) * 0.9, -40, 40) } : null,
      { k: '수급 구조', v: clamp((sup.score - 60) * 0.9, -40, 40) },
      { k: '미래 기대(정비·교통)', v: clamp([30, 18, 5, 0][opt.gradeIdx] + (cx.location.futureTransit && /확정|공사/.test(cx.location.futureTransit) ? 8 : 0), -40, 40) }
    ].filter(Boolean);

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

    /* 진단형 문장 4종 — 계산 결과(JSON)만으로 template 생성, AI 불필요 */
    const catNames = { transport: '교통', job: '직주근접', education: '교육', life: '생활편의', nature: '자연환경', product: '상품성' };
    const ranked = Object.entries(sub).filter(([, v]) => v != null).sort((a, b) => b[1] - a[1]);
    const top2 = ranked.slice(0, 2).filter(([, v]) => v >= 65);
    const coreBits = [];
    for (const [k] of top2) {
      if (k === 'transport' && res.transit) coreBits.push(`${res.transit.primary.st}(Station Value ${res.transit.primary.sv}) 이용과 강남 접근성(${res.transit.gangnamMin}분)`);
      else if (k === 'job') coreBits.push('주요 업무지까지의 짧은 이동시간');
      else if (k === 'education') coreBits.push(hed.eduDetail.hubName ? `${hed.eduDetail.hubName} 교육 생활권` : '교육환경');
      else if (k === 'product') coreBits.push('신축급 상품성과 단지 규모');
      else if (k === 'nature') coreBits.push('공원·수변 자연환경');
      else if (k === 'life') coreBits.push('생활 인프라');
    }
    const core = top2.length
      ? `이 단지의 가장 큰 경쟁력은 ${top2.map(([k]) => catNames[k]).join('과 ')}입니다. ${coreBits.join(', ')}이 높은 평가를 받았습니다.`
      : `단일 항목의 두드러진 경쟁력보다는 요소들이 고르게 평균 수준인 단지입니다.`;

    const supBits = [];
    if (support.gradeIdx <= 1) supBits.push(`${support.label} 전세지지력`);
    if (sup.gradeIdx <= 1) supBits.push(`공급 ${sup.gradeLabel} 환경`);
    if (sub.job >= 70) supBits.push('직주근접 수요');
    if (sub.education >= 78) supBits.push('학군 수요');
    if (sub.product >= 78) supBits.push('신축·대단지 희소성');
    if (opt.gradeIdx <= 1) supBits.push(`정비사업 기대(${opt.label})`);
    const supportSentence = supBits.length
      ? `${supBits.join(', ')}가 현재 가격을 지지하고 있습니다.`
      : `현재 가격을 강하게 지지하는 구조적 요인은 뚜렷하지 않아, 시장 전반의 흐름에 더 민감할 수 있습니다.`;

    const weakBits = [];
    if (res.combineOut.disagreement > 0.35) weakBits.push(`임대(사용)가치가 시장가격보다 크게 낮아(괴리 ${(res.combineOut.disagreement * 100).toFixed(0)}%) 현재 가격에는 향후 기대가 상당 부분 포함되어 있습니다`);
    else if (fin.impliedG != null && fin.impliedG > CFG.financial.impliedGrowthConcernOver) weakBits.push(`현재가 유지에 연 ${(fin.impliedG * 100).toFixed(1)}%의 임대가치 성장이 필요해 기대 선반영 폭이 큽니다`);
    if (support.gradeIdx >= 3) weakBits.push(`전세지지력이 ${support.label} 수준입니다`);
    if (sup.gradeIdx >= 3) weakBits.push(`향후 공급이 ${sup.gradeLabel} 구간입니다`);
    if (sub.product < 58) weakBits.push('구축 연식·상품성이 열위입니다');
    if ((cx.parkingRatio ?? 1) < 0.7 && cx.fieldStatus?.parkingRatio !== 'UNKNOWN') weakBits.push('주차 경쟁력이 부족합니다');
    const weakness = weakBits.length ? weakBits.join('. ') + '.' : '지표상 두드러진 취약점은 확인되지 않았습니다.';

    const watchBits = [];
    if (sup.gradeIdx >= 2) watchBits.push('인접 생활권 공급 물량');
    watchBits.push('전세가격 흐름');
    if (opt.prob >= 0.2) watchBits.push('정비사업 진행 속도와 분담금');
    if (fin.impliedG != null && fin.impliedG > fin.g) watchBits.push('금리 방향');
    const watch = `앞으로는 ${watchBits.join(', ')}이 이 단지의 가격·투자매력도에 가장 큰 영향을 줄 가능성이 높습니다.`;

    /* ── V3: 한 문장 요약(§59) + 가격을 만드는 핵심요인(§60) ── */
    const V = res.verdicts, ST = res.structural, FU = res.future;
    const driverPool = [];
    if (sub.transport != null && sub.transport >= 70) driverPool.push([sub.transport, res.transit ? `${res.transit.primary.st} 등 강한 역 접근성` : '교통 접근성']);
    if (sub.job != null && sub.job >= 70) driverPool.push([sub.job, '강남·핵심 업무지 접근성']);
    if (sub.education != null && sub.education >= 74) driverPool.push([sub.education, hed.eduDetail.hubName ? `${hed.eduDetail.hubName} 교육환경` : '교육환경']);
    if (sub.product != null && sub.product >= 74) driverPool.push([sub.product, '신축·대단지 상품성']);
    if (sub.nature != null && sub.nature >= 78) driverPool.push([sub.nature, '한강·녹지 환경']);
    if (FU && FU.comps.scarcity >= 72) driverPool.push([FU.comps.scarcity, '공급 희소성']);
    if (support.gradeIdx <= 1) driverPool.push([support.score, '강한 전세수요']);
    if (opt.gradeIdx <= 1) driverPool.push([80, `정비사업 기대(${opt.label})`]);
    driverPool.sort((a, b) => b[0] - a[0]);
    const drivers = driverPool.slice(0, 4).map(d => d[1]);

    let oneLiner = '';
    if (V) {
      const mPart = V.market.idx === 0 ? '현재 가격은 최근 실거래 대비 낮은 편이고'
        : V.market.idx === 2 ? '현재 가격은 최근 실거래 범위보다 높지만'
        : '현재 가격은 최근 실거래 기준 적정 범위이고';
      const fPart = V.financial.idx >= 2
        ? `금융·임대 수익만으로는 가격의 약 ${Math.round(V.financial.ratio * 100)}%만 설명됩니다`
        : `전세·금리 기준으로도 가격의 약 ${Math.round(V.financial.ratio * 100)}%가 지지됩니다`;
      const dPart = drivers.length ? `다만 ${drivers.slice(0, 3).join(', ')}이 나머지 프리미엄을 상당 부분 정당화합니다.` : '구조적 프리미엄 요인은 뚜렷하지 않습니다.';
      const ePart = V.expectation.idx >= 2 ? ' 현재 가격에는 미래 성장 기대도 반영되어 있습니다.' : '';
      oneLiner = `${mPart}, ${fPart}. ${dPart}${ePart}`;
    }

    return { up, down, contrib, interpretation: interp2, diagnosis: { core, support: supportSentence, weakness, watch }, oneLiner, drivers };
  }

  /* ═══════════ 메인 파이프라인 ═══════════ */
  function analyze(rawInput, CFG, HUBS, JOBS, STN) {
    const input = {
      asOfYM: rawInput.asOfYM, asOfYear: Number(rawInput.asOfYM.split('-')[0]),
      overrides: rawInput.overrides || {}, useRent: !!rawInput.useRent,
      manualComplex: !!rawInput.manualComplex
    };
    const cx = rawInput.complex;
    const area = cx.areas.find(a => a.key === rawInput.areaKey) || cx.areas[0];
    const gaps = [];
    if (Array.isArray(cx.dataGaps)) gaps.push(...cx.dataGaps);   // 자동 수집 단지의 결측 항목

    // Engine A: 비교거래 앵커(폴백용) + V3 시장 기준가(기간창 가중중앙값)
    const market = engineMarket(cx, area, input, CFG);
    if (!market.value) throw new Error('비교거래 없음 — 현재 가격을 직접 입력해 주세요.');
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
    const future = engineFuture(cx, supplyE, hedonic, option, CFG);
    const fin = engineFinancial(cx, area, input, CFG, currentPrice, future.g);
    const support = jeonseSupport(fin, cx.supply, supplyE.combined, CFG);

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
    const conf = confidence(market, combineOut.disagreement, fillRate, manualCount, CFG, marketRef);

    // 데이터 상태 집계 (VERIFIED / ESTIMATED / MANUAL / UNKNOWN — §39)
    let dataStatus = null;
    if (cx.fieldStatus) {
      dataStatus = { VERIFIED: 0, ESTIMATED: 0, MANUAL: 0, UNKNOWN: 0 };
      for (const v of Object.values(cx.fieldStatus)) if (dataStatus[v] != null) dataStatus[v]++;
    }

    // V3 판정 3종 + 장기 경쟁력
    const structural = structuralScore(hedonic, future, CFG);
    const verdicts = {
      market: marketVerdict(currentPrice, marketRef, CFG),
      financial: financialGrade(fin, currentPrice, CFG),
      expectation: expectationGrade(fin, CFG)
    };

    // 계산 trace (§86 — debug 모드 표시용)
    const trace = [
      ['시장 기준가', marketRef ? `${round1(marketRef.low)}~${round1(marketRef.high)}억 (중앙 ${round1(marketRef.med)}, ${marketRef.windowDays}일창 ${marketRef.n}건, 이상치 ${marketRef.nOutlier})` : '없음 → 비교거래 폴백'],
      ['최근 실거래', marketRef ? `${marketRef.latest.date} · ${marketRef.latest.price}억 · ${marketRef.latest.floor}층${marketRef.latest.outlier ? ' [이상치]' : ''}` : '—'],
      ['현재가', `${round1(currentPrice)}억 (${input.overrides.price != null ? '수동' : (rep && rep.anomalous ? '이상 저가 보정 — 최근 3개월 최고가' : '최근 실거래')})`],
      ['R 연간주거서비스', `${(fin.R).toFixed(3)}억 = ${fin.rSourceText}`],
      ['요구수익률 r', (fin.r * 100).toFixed(2) + '%'],
      ['g 시나리오', `보수 ${(fin.gScen.low * 100).toFixed(1)}% / 기준 ${(fin.gScen.base * 100).toFixed(1)}% / 우호 ${(fin.gScen.high * 100).toFixed(1)}% (미래점수 ${future.score})`],
      ['금융지지가치', `${round1(fin.fsv.low)}~${round1(fin.fsv.high)}억 (기준 ${round1(fin.fsv.base)}, ${fin.mode})`],
      ['역산 g*', fin.impliedG != null ? (fin.impliedG * 100).toFixed(2) + '%' : '—'],
      ['미래 5축', Object.entries(future.comps).map(([k, v]) => `${k}:${v == null ? '제외' : Math.round(v)}`).join(' ')],
      ['히도닉 조정', Object.entries(hedonic.adj).map(([k, v]) => `${k}:${(v * 100).toFixed(1)}%`).join(' ') + ` → 총 ${(hedonic.total * 100).toFixed(1)}% (잔차 ${(combineOut.hRes * 100).toFixed(1)}%)`],
      ['수급 조정', (supplyE.adj * 100).toFixed(1) + '%'],
      ['옵션 프리미엄', (option.premium * 100).toFixed(1) + '%'],
      ['장기 경쟁력', `${structural.score} (${structural.band})${structural.excluded.length ? ' · 제외: ' + structural.excluded.join(',') : ''}`],
      ['판정', `시장 ${verdicts.market.label} / 금융 ${verdicts.financial.label}(${Math.round(verdicts.financial.ratio * 100)}%) / 기대 ${verdicts.expectation.label}`],
      ['신뢰도', `${conf.score} (${conf.label}) — ${conf.penalties.join('; ') || '감점 없음'}`]
    ];

    const res = {
      cx, area, input, currentPrice, repPrice: rep, market, marketRef, financial: fin, support, hedonic, supplyE, option,
      future, structural, verdicts, transit, combineOut, range, gaps, fillRate, dataStatus, trace,
      scores: { living, invest, attract },
      confidence: conf
    };
    res.explain = buildExplain(res, cx, area, CFG);
    return res;
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

  return { analyze, applyStress, repRecentPrice, interp, weightedMedian, weightedPercentile, monthsBetween, clamp, round1 };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = AptEngine;
