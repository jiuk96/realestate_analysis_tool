/* 전세 안전성 참고 지표 (Additive-Only 모듈)
   ─────────────────────────────────────────
   기존 점수와 합산하지 않는 '표시 전용' 안전성 카드/배지.
   - A. 전세가율 위험등급: ≤70 안전 / 70~80 주의 / 80~90 위험 / ≥90 매우 위험
        (서울시 전세사기 예방 가이드 80% 초과 위험 · 전문가 권고 70% 안전선)
   - B. 역전세 경고: 최근 24개월 신규계약 중 계약 시점 전세가율 90%+ 이력
        (국토연구원 2023 — 90%+ 계약은 만기 역전세 이행 확률 급증)
   - C. HUG 126%: 전세 중앙값 ÷ (공시가×1.26) > 1.0 → 보증보험 거절 가능성
        (공시가 데이터 있을 때만 표시)
   스타일: 기존 디자인 토큰(.ct-box/.ct-row/.conf-badge, CSS 변수)만 사용.
   데이터 없는 단지는 해당 행/카드 자체를 숨긴다(0점·에러 처리 금지). */
(function () {
  let cache = null;

  async function loadSafety() {
    if (cache === null) {
      try { cache = (await (await fetch('/api/jeonse_safety')).json()) || {}; }
      catch (e) { cache = {}; }
    }
    return cache;
  }

  // A. 전세가율 절대 위험등급 (표시 전용 — 기존 percentile 평가와 별개)
  function ratioGrade(ratio) {
    const p = ratio * 100;
    if (p >= 90) return { label: '매우 위험', color: 'var(--red)',    bg: 'rgba(229,72,77,.10)' };
    if (p > 80)  return { label: '위험',      color: 'var(--accent)', bg: 'rgba(255,116,38,.10)' };
    if (p > 70)  return { label: '주의',      color: 'var(--gold)',   bg: 'rgba(217,130,43,.10)' };
    return         { label: '안전',      color: 'var(--green)',  bg: 'rgba(3,165,82,.08)' };
  }

  function gradeBadge(a) {
    if (!a || a.jeonse_ratio == null) return '';
    const g = ratioGrade(a.jeonse_ratio);
    return `<span class="conf-badge" style="color:${g.color};background:${g.bg};border:1px solid ${g.color}">` +
           `🛡️ 전세가율 ${Math.round(a.jeonse_ratio * 100)}% · ${g.label}</span>`;
  }

  // 안전성 카드 (전세 상세 모달용) — 데이터 있는 지표만 행으로 추가
  async function renderCard(elId, a) {
    const el = document.getElementById(elId);
    if (!el || !a) return;
    const safety = await loadSafety();
    const s = (safety.apartments || {})[`${a.district}|${a.apt_name}`];
    const rows = [];

    // A. 위험등급 (jeonse_ratio 있으면 항상)
    if (a.jeonse_ratio != null) {
      const g = ratioGrade(a.jeonse_ratio);
      rows.push(`
        <div class="ct-row">
          <div class="ct-head"><span class="ct-who">전세가율 위험등급</span>
            <span style="margin-left:auto;font-weight:800;color:${g.color}">${Math.round(a.jeonse_ratio * 100)}% · ${g.label}</span></div>
          <div class="jz-reason">기준: 70% 이하 안전 · 70~80% 주의 · 80% 초과 위험 · 90% 이상 매우 위험
            (서울시 전세사기 예방 가이드). 단지 시세 기준이므로 실제 계약가로 다시 확인하세요.</div>
        </div>`);
    }

    // B. 역전세 경고 (산출된 단지만)
    if (s && s.total_cnt > 0) {
      const warn = s.flag;
      rows.push(`
        <div class="ct-row">
          <div class="ct-head"><span class="ct-who">역전세 이력 신호</span>
            <span style="margin-left:auto;font-weight:800;color:${warn ? 'var(--red)' : 'var(--green)'}">${warn ? '⚠️ 주의' : '✓ 없음'}</span></div>
          <div class="jz-reason">${warn
            ? `최근 ${cache.lookback_months}개월 신규 전세 ${s.total_cnt}건 중 <b>계약 시점 전세가율 90% 초과가 ${s.high_cnt}건(${s.high_share}%)</b> — 이런 계약은 만기 때 보증금 반환 분쟁으로 이어진 사례가 많습니다(국토연구원 2023).`
            : `최근 ${cache.lookback_months}개월 신규 전세 ${s.total_cnt}건 중 전세가율 90% 초과 계약이 없습니다.`}</div>
        </div>`);
    }

    // C. HUG 126% (공시가 있는 단지만 — 없으면 행 자체 숨김)
    if (s && s.hug_ratio != null) {
      const over = s.hug_ratio > 1.0;
      rows.push(`
        <div class="ct-row">
          <div class="ct-head"><span class="ct-who">HUG 보증보험 126% 기준</span>
            <span style="margin-left:auto;font-weight:800;color:${over ? 'var(--red)' : 'var(--green)'}">${over ? '⚠️ 초과' : '✓ 이내'} (${s.hug_ratio})</span></div>
          <div class="jz-reason">전세 중앙값 ÷ (공시가격 ${s.gongsi_median.toLocaleString()}만원 × 1.26) = ${s.hug_ratio}.
            ${over ? '1.0을 넘어 <b>보증보험 가입이 거절될 수 있습니다</b>.' : '1.0 이내로 보증보험 가입 요건을 충족할 가능성이 높습니다.'}
            단지 중앙값 근사치이므로 해당 호의 공시가로 재확인하세요.</div>
        </div>`);
    }

    if (!rows.length) { el.innerHTML = ''; return; }
    el.innerHTML = `
      <div class="ct-box">
        <div class="ct-title">🛡️ 전세 안전성 <span class="ct-note">점수 미반영 참고 지표 · 공공데이터 기반</span></div>
        ${rows.join('')}
      </div>`;
  }

  window.JeonseSafety = { gradeBadge, renderCard };
})();
