/* ── 유틸 ──────────────────────────────────────────────── */
const fmt만  = v => (v / 10000).toFixed(1) + '억';
const fmt억  = v => v.toFixed(2) + '억';
const fmtPct = v => (v >= 0 ? '+' : '') + v.toFixed(1) + '%';

const COLORS = ['#38bdf8','#818cf8','#34d399','#fb923c','#f472b6','#a78bfa'];
const GOLD   = '#fbbf24';
const RED    = '#f87171';
const GREEN  = '#34d399';

async function fetchJSON(url) {
  const r = await fetch(url);
  return r.json();
}

/* ── ① 신뢰도 배지 ────────────────────────────────────── */
async function renderQuality() {
  const d = await fetchJSON('/api/quality');
  document.getElementById('heroMeta').innerHTML = `
    <span>${d.collection_period}</span>
    <span>대상: ${d.target_districts.join(' · ')}</span>
    <span>최소 세대수: ${d.min_households}세대 이상</span>
  `;

  const cards = [
    { icon: '🏛️', label: '데이터 출처',     value: '국토교통부',           sub: '실거래가 공개시스템 (공공데이터포털)' },
    { icon: '📦', label: '원본 거래 건수',   value: `${d.total_raw.toLocaleString()}건`,  sub: `${d.collection_period}` },
    { icon: '🧹', label: '정제 후 거래 건수',value: `${d.total_clean.toLocaleString()}건`, sub: `벌점 제거 후 사용 데이터` },
    { icon: '📊', label: '데이터 유효율',    value: `${(100 - d.filter_rate_pct).toFixed(1)}%`, sub: `(필터 제거율 ${d.filter_rate_pct}%)` },
    { icon: '🔍', label: '이상치 탐지',      value: 'z-score > 3.0',       sub: '단지×면적 그룹 내 표준화' },
    { icon: '📈', label: '스무딩 방식',      value: '3개월 이동 중앙값',    sub: '단기 스파이크 완화' },
    { icon: '🏠', label: '최소 세대수 기준', value: `${d.min_households}세대 이상`, sub: '소규모 단지 분석 제외' },
    { icon: '✅', label: '직거래 필터',      value: '중앙값 60% 이하 제외', sub: '증여·특수관계 거래 제거' },
  ];

  document.getElementById('qualityBadges').innerHTML = cards.map(c => `
    <div class="badge-card">
      <div class="badge-icon">${c.icon}</div>
      <div class="badge-label">${c.label}</div>
      <div class="badge-value">${c.value}</div>
      <div class="badge-sub">${c.sub}</div>
    </div>
  `).join('');
}

/* ── ② 파이프라인 플로우 ──────────────────────────────── */
async function renderPipeline() {
  const d = await fetchJSON('/api/pipeline');

  document.getElementById('pipelineFlow').innerHTML = d.stages.map((s, i) => `
    ${i > 0 ? '<div class="pipe-arrow">→</div>' : ''}
    <div class="pipe-stage">
      <div class="pipe-count">${s.count.toLocaleString()}</div>
      <div class="pipe-label">${s.label}</div>
      <div class="pipe-desc">${s.desc}</div>
    </div>
  `).join('');

  document.getElementById('penaltyGrid').innerHTML = d.penalty_rules.map(r => `
    <div class="penalty-card">
      <span class="penalty-score">+${r.score}점</span>
      <div class="penalty-rule">${r.rule}</div>
      <div class="penalty-why">${r.reason}</div>
    </div>
  `).join('');
}

/* ── ④ 가격 시계열 차트 ───────────────────────────────── */
async function renderTimeseries() {
  const d = await fetchJSON('/api/timeseries');

  const traces = [];
  const annotations = [];

  d.series.forEach((s, i) => {
    const color = COLORS[i % COLORS.length];

    // 스무딩 라인
    traces.push({
      x: s.dates, y: s.prices,
      name: s.apt_name,
      type: 'scatter', mode: 'lines',
      line: { color, width: 2.5 },
      hovertemplate: `%{x}<br>${s.apt_name}: %{y:.2f}억<extra></extra>`,
    });

    // 최고점 마커
    if (s.peak_date) {
      const pi = s.dates.indexOf(s.peak_date);
      if (pi >= 0) {
        traces.push({
          x: [s.peak_date], y: [s.prices[pi]],
          name: `${s.apt_name} 최고점`,
          showlegend: false,
          type: 'scatter', mode: 'markers',
          marker: { color: GOLD, size: 12, symbol: 'triangle-up' },
          hovertemplate: `최고점 ${s.peak_date}<br>${s.prices[pi].toFixed(2)}억<extra></extra>`,
        });
        annotations.push({
          x: s.peak_date, y: s.prices[pi],
          text: `▲고점<br>${s.prices[pi].toFixed(1)}억`,
          showarrow: true, arrowhead: 0, arrowcolor: GOLD,
          font: { size: 10, color: GOLD }, ax: 0, ay: -36,
          bgcolor: 'rgba(15,23,42,.8)', bordercolor: GOLD, borderwidth: 1,
        });
      }
    }

    // 최저점 마커
    if (s.trough_date) {
      const ti = s.dates.indexOf(s.trough_date);
      if (ti >= 0) {
        traces.push({
          x: [s.trough_date], y: [s.prices[ti]],
          name: `${s.apt_name} 최저점`,
          showlegend: false,
          type: 'scatter', mode: 'markers',
          marker: { color: RED, size: 12, symbol: 'triangle-down' },
          hovertemplate: `최저점 ${s.trough_date}<br>${s.prices[ti].toFixed(2)}억 (MDD ${s.mdd_pct?.toFixed(1)}%)<extra></extra>`,
        });
        annotations.push({
          x: s.trough_date, y: s.prices[ti],
          text: `▼저점<br>${s.prices[ti].toFixed(1)}억<br>${s.mdd_pct?.toFixed(1)}%`,
          showarrow: true, arrowhead: 0, arrowcolor: RED,
          font: { size: 10, color: RED }, ax: 0, ay: 44,
          bgcolor: 'rgba(15,23,42,.8)', bordercolor: RED, borderwidth: 1,
        });
      }
    }
  });

  // 하락장 구간 음영
  const shapes = [{
    type: 'rect',
    x0: '2022-07', x1: '2023-06',
    y0: 0, y1: 1, yref: 'paper',
    fillcolor: 'rgba(248,113,113,.08)',
    line: { width: 0 },
  }, {
    type: 'rect',
    x0: '2021-01', x1: '2021-12',
    y0: 0, y1: 1, yref: 'paper',
    fillcolor: 'rgba(251,191,36,.06)',
    line: { width: 0 },
  }];

  const layout = {
    paper_bgcolor: 'transparent', plot_bgcolor: 'rgba(30,41,59,.5)',
    font: { color: '#94a3b8', size: 12 },
    xaxis: { gridcolor: '#334155', tickfont: { size: 11 } },
    yaxis: { gridcolor: '#334155', ticksuffix: '억', tickfont: { size: 11 } },
    legend: { bgcolor: 'rgba(15,23,42,.7)', bordercolor: '#334155', borderwidth: 1 },
    margin: { t: 30, b: 50, l: 60, r: 20 },
    hovermode: 'x unified',
    annotations: [
      ...annotations,
      { x: '2021-06', y: 1.04, xref: 'x', yref: 'paper',
        text: '🔶 고점 구간', showarrow: false, font: { size: 10, color: GOLD } },
      { x: '2022-12', y: 1.04, xref: 'x', yref: 'paper',
        text: '🔴 하락장 구간', showarrow: false, font: { size: 10, color: RED } },
    ],
    shapes,
  };

  Plotly.newPlot('chartTimeseries', traces, layout, { responsive: true, displayModeBar: false });
}

/* ── ⑤ MDD 랭킹 차트 + 테이블 ────────────────────────── */
async function renderRanking() {
  const d = await fetchJSON('/api/mdd_ranking');
  const items = d.ranking;

  const colors = items.map(r => r.is_top ? GOLD : '#475569');
  const labels = items.map(r => r.apt_name + (r.is_top ? ' ★' : ''));

  const trace = {
    type: 'bar', orientation: 'h',
    x: items.map(r => r.mdd_pct),
    y: labels,
    marker: { color: colors },
    text: items.map(r => `${r.mdd_pct.toFixed(1)}%`),
    textposition: 'outside',
    textfont: { color: '#e2e8f0', size: 12 },
    hovertemplate: '%{y}<br>MDD: %{x:.1f}%<extra></extra>',
  };

  const layout = {
    paper_bgcolor: 'transparent', plot_bgcolor: 'rgba(30,41,59,.5)',
    font: { color: '#94a3b8', size: 12 },
    xaxis: { gridcolor: '#334155', ticksuffix: '%', zeroline: true, zerolinecolor: '#475569', range: [Math.min(...items.map(r=>r.mdd_pct)) - 5, 5] },
    yaxis: { gridcolor: '#334155', automargin: true },
    margin: { t: 20, b: 50, l: 10, r: 80 },
    height: Math.max(300, items.length * 52),
    shapes: [{ type: 'line', x0: 0, x1: 0, y0: -0.5, y1: items.length - 0.5,
      line: { color: '#94a3b8', width: 1, dash: 'dot' } }],
  };

  Plotly.newPlot('chartRanking', [trace], layout, { responsive: true, displayModeBar: false });

  // 테이블
  const mddClass = v => v >= -10 ? 'good' : v >= -20 ? 'mid' : 'bad';
  document.getElementById('rankingBody').innerHTML = items.map(r => `
    <tr class="${r.is_top ? 'is-top' : ''}">
      <td>${r.rank}</td>
      <td>${r.apt_name}${r.is_top ? '<span class="star-badge">★</span>' : ''}</td>
      <td>${r.district}</td>
      <td class="mdd-cell ${mddClass(r.mdd_pct)}">${r.mdd_pct.toFixed(1)}%</td>
      <td>${r.peak_date}</td>
      <td>${(r.peak_price / 10000).toFixed(1)}억</td>
      <td>${r.trough_date}</td>
      <td>${(r.trough_price / 10000).toFixed(1)}억</td>
      <td>${r.build_year}년</td>
    </tr>
  `).join('');
}

/* ── ⑥ 공통 특성 ─────────────────────────────────────── */
async function renderTraits() {
  const d = await fetchJSON('/api/traits');

  const cards = [];

  if (d['평균_준공연도']) {
    const { top, all } = d['평균_준공연도'];
    const pct = Math.min(100, ((top - 1990) / (2025 - 1990)) * 100);
    cards.push({ label: '📅 평균 준공연도', top: `${top}년`, all: `${all}년`, pct });
  }
  if (d['평균_MDD']) {
    const { top, all } = d['평균_MDD'];
    const pct = Math.min(100, Math.abs(top) / Math.abs(all) * 100);
    cards.push({ label: '📉 평균 MDD', top: `${top}%`, all: `${all}%`, pct: 100 - pct, note: '낮을수록 방어력 ↑' });
  }
  if (d['주력_면적']) {
    const { top, all } = d['주력_면적'];
    cards.push({ label: '📐 대표 전용면적', top: `${top}㎡`, all: `${all}㎡`, pct: 70 });
  }
  if (d['구별_분포']) {
    const { top } = d['구별_분포'];
    const topStr = Object.entries(top).map(([k,v]) => `${k} ${v}개`).join(', ');
    cards.push({ label: '🗺️ 주력 지역 (상위)', top: topStr, all: '─', pct: 80 });
  }

  document.getElementById('traitsGrid').innerHTML = cards.map(c => `
    <div class="trait-card">
      <div class="trait-label">${c.label}</div>
      <div class="trait-compare">
        <div class="trait-row"><span class="who">방어 상위 10%</span><span class="val-top">${c.top}</span></div>
        <div class="trait-row"><span class="who">전체 평균</span><span class="val-all">${c.all}</span></div>
        ${c.note ? `<div style="font-size:.72rem;color:#94a3b8">${c.note}</div>` : ''}
        <div class="trait-bar-wrap"><div class="trait-bar" style="width:${c.pct}%"></div></div>
      </div>
    </div>
  `).join('');
}

/* ── 진입점 ──────────────────────────────────────────── */
(async () => {
  await Promise.all([
    renderQuality(),
    renderPipeline(),
    renderTimeseries(),
    renderRanking(),
    renderTraits(),
  ]);
})();
