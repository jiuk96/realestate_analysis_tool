/* ── 유틸 ──────────────────────────────────────────────── */
const COLORS = ['#38bdf8','#34d399','#818cf8','#fb923c','#f472b6','#a78bfa'];
const GOLD = '#fbbf24', GREEN = '#34d399', RED = '#f87171';

async function fetchJSON(url) {
  const r = await fetch(url);
  return r.json();
}

const scoreClass = v => v >= 65 ? 'good' : v >= 50 ? 'mid' : 'bad';
const mddClass   = v => v >= -10 ? 'good' : v >= -20 ? 'mid' : 'bad';

/* ── ① STEP 1: 데이터 필터링 ───────────────────────────── */
async function renderFilter() {
  const [q, p] = await Promise.all([fetchJSON('/api/quality'), fetchJSON('/api/pipeline')]);

  // 히어로 통계
  document.getElementById('statRaw').textContent    = q.total_raw.toLocaleString() + '건';
  document.getElementById('statClean').textContent  = q.total_clean.toLocaleString() + '건';
  document.getElementById('statApts').textContent   = '16개';
  document.getElementById('statPeriod').textContent = '2020~2025';

  // 파이프라인 플로우
  document.getElementById('pipelineRow').innerHTML = p.stages.map((s, i) => `
    ${i > 0 ? '<div class="pipe-arrow">▶</div>' : ''}
    <div class="pipe-stage">
      <div class="pipe-count">${s.count.toLocaleString()}<span class="pipe-unit">건</span></div>
      <div class="pipe-label">${s.label}</div>
      <div class="pipe-desc">${s.desc}</div>
    </div>
  `).join('');

  // 벌점 규칙
  const icons = ['🏢','🤝','📊','❓'];
  document.getElementById('penaltyGrid').innerHTML = p.penalty_rules.map((r, i) => `
    <div class="penalty-card">
      <div class="penalty-header">
        <span class="penalty-icon">${icons[i]}</span>
        <span class="penalty-rule">${r.rule}</span>
        <span class="penalty-score">+${r.score}점</span>
      </div>
      <div class="penalty-why">${r.reason}</div>
    </div>
  `).join('');
}

/* ── ② STEP 2: 점수 산출 방식 ──────────────────────────── */
function renderScoring() {
  const axes = [
    { key: '거래지속성', weight: 30, color: '#38bdf8',
      desc: '분석 기간 동안 꾸준히 거래된 단지를 높게 평가. 실수요가 받치는 단지는 하락장에도 버팁니다.' },
    { key: '가격방어력', weight: 25, color: '#34d399',
      desc: '2022~2023년 하락장의 MDD(최대낙폭)를 반영. 덜 빠진 단지가 높은 점수를 받습니다.' },
    { key: '상승참여도', weight: 20, color: '#818cf8',
      desc: '2021년 상승장 대비 얼마나 올랐는지. 방어도 하고 상승도 하는 단지가 진짜 우량 단지입니다.' },
    { key: '교통',      weight: 12, color: '#fb923c',
      desc: '지하철역까지 도보 소요 시간. 가까울수록 수요가 안정적으로 유지됩니다.' },
    { key: '인프라',    weight:  8, color: '#f472b6',
      desc: '백화점·대형마트·공원·병원 등 생활 인프라 밀도. 편의성이 높을수록 가격 하방이 견고합니다.' },
    { key: '학군',      weight:  5, color: '#a78bfa',
      desc: '주요 초·중·고 학군 수준. 학령기 실수요를 유인하는 장기 가격 지지 요인입니다.' },
  ];

  document.getElementById('scoreAxes').innerHTML = axes.map(a => `
    <div class="axis-card">
      <div class="axis-top">
        <span class="axis-key" style="color:${a.color}">${a.key}</span>
        <div class="axis-bar-wrap">
          <div class="axis-bar" style="width:${a.weight * 3}%;background:${a.color}"></div>
        </div>
        <span class="axis-weight" style="color:${a.color}">${a.weight}%</span>
      </div>
      <div class="axis-desc">${a.desc}</div>
    </div>
  `).join('');
}

/* ── ③ STEP 3: 종합 랭킹 ───────────────────────────────── */
async function renderRanking() {
  const d = await fetchJSON('/api/composite_score');
  const items = d.ranking;

  // 수평 바 차트
  const sorted = [...items].sort((a, b) => b.composite_score - a.composite_score);
  const colors = sorted.map(r =>
    r.composite_score >= 65 ? GREEN : r.composite_score >= 50 ? '#38bdf8' : '#475569'
  );

  Plotly.newPlot('chartRanking', [{
    type: 'bar', orientation: 'h',
    y: sorted.map(r => r.apt_name),
    x: sorted.map(r => r.composite_score),
    marker: { color: colors },
    text: sorted.map(r => r.composite_score.toFixed(1) + '점'),
    textposition: 'outside',
    textfont: { color: '#e2e8f0', size: 12 },
    hovertemplate: '<b>%{y}</b><br>종합 점수: %{x:.1f}점<extra></extra>',
  }], {
    paper_bgcolor: 'transparent', plot_bgcolor: 'rgba(30,41,59,.5)',
    font: { color: '#94a3b8', size: 12 },
    xaxis: { range: [0, 105], gridcolor: '#334155', ticksuffix: '점', title: '종합 입지 점수 (0~100)' },
    yaxis: { autorange: 'reversed', automargin: true, tickfont: { size: 12 } },
    margin: { l: 160, r: 80, t: 10, b: 50 },
    height: Math.max(320, sorted.length * 42),
  }, { responsive: true, displayModeBar: false });

  // 테이블
  document.getElementById('rankingBody').innerHTML = items.map(r => `
    <tr>
      <td><strong>${r.rank}</strong></td>
      <td><strong>${r.apt_name}</strong></td>
      <td><span class="district-tag district-${r.district}">${r.district}</span></td>
      <td class="score-cell ${scoreClass(r.composite_score)}">${r.composite_score.toFixed(1)}</td>
      <td class="${mddClass(r.mdd_pct)}">${r.mdd_pct.toFixed(1)}%</td>
      <td>${r.consistency_score.toFixed(1)}</td>
      <td>${r.resilience_score.toFixed(1)}</td>
      <td>${r.upside_score.toFixed(1)}</td>
      <td>${r.subway_score.toFixed(1)}</td>
      <td>${r.infra_score.toFixed(1)}</td>
      <td>${r.school_score.toFixed(1)}</td>
    </tr>
  `).join('');
}

/* ── ④ STEP 4: 구별 TOP 단지 ───────────────────────────── */
async function renderDistrict() {
  const d = await fetchJSON('/api/composite_score');
  const items = d.ranking;

  const districts = ['마포구', '용산구', '성동구'];
  const districtColors = { '마포구': '#38bdf8', '용산구': '#34d399', '성동구': '#818cf8' };
  const districtEmoji  = { '마포구': '🏙️', '용산구': '🌿', '성동구': '🌊' };

  const html = districts.map(dist => {
    const group = items
      .filter(r => r.district === dist)
      .sort((a, b) => b.composite_score - a.composite_score);

    if (!group.length) return '';
    const top = group[0];
    const rest = group.slice(1, 4);
    const color = districtColors[dist];

    const bars = [
      { label: '거래지속성', val: top.consistency_score },
      { label: '가격방어력', val: top.resilience_score },
      { label: '상승참여도', val: top.upside_score },
      { label: '교통',       val: top.subway_score },
    ];

    return `
      <div class="district-card" style="--dc:${color}">
        <div class="dc-header">
          <span class="dc-emoji">${districtEmoji[dist]}</span>
          <span class="dc-name">${dist}</span>
        </div>
        <div class="dc-top">
          <div class="dc-rank">1위</div>
          <div class="dc-apt">${top.apt_name}</div>
          <div class="dc-score">${top.composite_score.toFixed(1)}<span>점</span></div>
        </div>
        <div class="dc-bars">
          ${bars.map(b => `
            <div class="dc-bar-row">
              <span class="dc-bar-label">${b.label}</span>
              <div class="dc-bar-wrap"><div class="dc-bar-fill" style="width:${b.val}%;background:${color}"></div></div>
              <span class="dc-bar-val">${b.val.toFixed(0)}</span>
            </div>
          `).join('')}
        </div>
        ${rest.length ? `
          <div class="dc-rest">
            ${rest.map((r, i) => `
              <div class="dc-rest-row">
                <span class="dc-rest-rank">${i + 2}위</span>
                <span class="dc-rest-name">${r.apt_name}</span>
                <span class="dc-rest-score">${r.composite_score.toFixed(1)}점</span>
              </div>
            `).join('')}
          </div>
        ` : ''}
      </div>
    `;
  }).join('');

  document.getElementById('districtGrid').innerHTML = html;
}

/* ── ⑤ STEP 5: 공통점 분석 ─────────────────────────────── */
async function renderInsight() {
  const [comp, traits] = await Promise.all([
    fetchJSON('/api/composite_score'),
    fetchJSON('/api/traits'),
  ]);

  const items = comp.ranking;
  const top3  = items.slice(0, 3);
  const all   = items;

  // 공통점 도출
  const avgSubwayTop = top3.reduce((s, r) => s + r.subway_min, 0) / top3.length;
  const avgSubwayAll = all.reduce((s, r) => s + r.subway_min, 0) / all.length;
  const avgMddTop    = top3.reduce((s, r) => s + r.mdd_pct, 0) / top3.length;
  const avgMddAll    = all.reduce((s, r) => s + r.mdd_pct, 0) / all.length;
  const avgMonthsTop = top3.reduce((s, r) => s + r.active_months, 0) / top3.length;
  const avgMonthsAll = all.reduce((s, r) => s + r.active_months, 0) / all.length;
  const avgUpsideTop = top3.reduce((s, r) => s + r.upside_pct, 0) / top3.length;
  const avgUpsideAll = all.reduce((s, r) => s + r.upside_pct, 0) / all.length;

  const topYears = traits['평균_준공연도'] ? traits['평균_준공연도']['top'] : null;
  const allYears = traits['평균_준공연도'] ? traits['평균_준공연도']['all'] : null;

  const insights = [
    {
      icon: '🚇',
      title: '역세권 집중',
      highlight: `평균 ${avgSubwayTop.toFixed(0)}분`,
      sub: `전체 평균 ${avgSubwayAll.toFixed(0)}분 대비`,
      desc: `상위 3개 단지 모두 지하철역 도보 ${avgSubwayTop.toFixed(0)}분 이내에 위치합니다. 교통 접근성이 실수요의 핵심 지지선 역할을 합니다.`,
      good: avgSubwayTop < avgSubwayAll,
    },
    {
      icon: '🛡️',
      title: '하락폭이 작다',
      highlight: `MDD ${avgMddTop.toFixed(1)}%`,
      sub: `전체 평균 ${avgMddAll.toFixed(1)}%`,
      desc: `상위 단지의 평균 최대낙폭은 ${avgMddTop.toFixed(1)}%로, 전체 평균(${avgMddAll.toFixed(1)}%)보다 하락폭이 ${(avgMddAll - avgMddTop).toFixed(1)}%p 낮습니다.`,
      good: avgMddTop > avgMddAll,
    },
    {
      icon: '🔄',
      title: '꾸준한 거래량',
      highlight: `${avgMonthsTop.toFixed(0)}개월`,
      sub: `전체 평균 ${avgMonthsAll.toFixed(0)}개월`,
      desc: `분석 기간(약 60개월) 중 상위 단지는 평균 ${avgMonthsTop.toFixed(0)}개월 동안 거래가 있었습니다. 거래가 끊기지 않는 단지는 가격 왜곡이 적습니다.`,
      good: avgMonthsTop > avgMonthsAll,
    },
    {
      icon: '📈',
      title: '상승장에도 참여',
      highlight: `+${avgUpsideTop.toFixed(0)}%`,
      sub: `전체 평균 +${avgUpsideAll.toFixed(0)}%`,
      desc: `상위 단지의 2021년 상승률은 평균 +${avgUpsideTop.toFixed(0)}%로, 하락도 덜 하고 상승도 충분히 참여한 우량 단지입니다.`,
      good: avgUpsideTop >= avgUpsideAll,
    },
    ...(topYears && allYears ? [{
      icon: '🏗️',
      title: '신축 선호',
      highlight: `평균 ${Math.round(topYears)}년식`,
      sub: `전체 평균 ${Math.round(allYears)}년식`,
      desc: `상위 단지의 평균 준공연도는 ${Math.round(topYears)}년으로, 전체 평균(${Math.round(allYears)}년)보다 최신입니다. 신축일수록 커뮤니티·품질 프리미엄이 붙어 하방이 견고합니다.`,
      good: topYears > allYears,
    }] : []),
  ];

  document.getElementById('insightGrid').innerHTML = insights.map(ins => `
    <div class="insight-card">
      <div class="insight-icon">${ins.icon}</div>
      <div class="insight-body">
        <div class="insight-title">${ins.title}</div>
        <div class="insight-numbers">
          <span class="insight-highlight ${ins.good ? 'good' : 'bad'}">${ins.highlight}</span>
          <span class="insight-sub">${ins.sub}</span>
        </div>
        <div class="insight-desc">${ins.desc}</div>
      </div>
    </div>
  `).join('');
}

/* ── 진입점 ──────────────────────────────────────────── */
(async () => {
  renderScoring();
  await Promise.all([
    renderFilter(),
    renderRanking(),
    renderDistrict(),
    renderInsight(),
  ]);
})();
