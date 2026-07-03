"""
전체 분석 파이프라인 - data/raw/*.parquet → data/processed/*.json
"""
import sys, json, warnings
warnings.filterwarnings('ignore')
sys.path.insert(0, '.')
import pandas as pd
import numpy as np
from pathlib import Path

from src.preprocessor import run as preprocess_run
from src.analyzer import run as analyzer_run, build_monthly_median
from src.scorer import compute_composite_score, WEIGHTS, WEIGHTS_TRANSIT
from config import DISTRICTS, MIN_HOUSEHOLDS

CODE2NAME = {v: k for k, v in DISTRICTS.items()}
OUT = Path('data/processed')


def _clean(obj):
    """nan/NaT → None, Period → str"""
    if isinstance(obj, float) and obj != obj:
        return None
    if isinstance(obj, dict):
        return {k: _clean(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_clean(i) for i in obj]
    if hasattr(obj, 'isoformat'):
        return str(obj)
    return obj


def save(name, data):
    path = OUT / name
    path.write_text(json.dumps(_clean(data), ensure_ascii=False, default=str), encoding='utf-8')
    print(f'  저장: {name}')


# ── 1. 로드 ──────────────────────────────────────────────────
print('=== 1. 데이터 로드 ===')
raw_dir = Path('data/raw')
dfs = [pd.read_parquet(f) for f in sorted(raw_dir.glob('*.parquet'))]
df_raw = pd.concat(dfs, ignore_index=True)
df_raw['district_name'] = df_raw['district_code'].astype(str).map(CODE2NAME)
print(f'  원본: {len(df_raw):,}건')

# ── 2. 전처리 ─────────────────────────────────────────────────
print('=== 2. 전처리 ===')
df = preprocess_run(df_raw)
print(f'  정제: {len(df):,}건, {df["apt_name"].nunique()}개 단지')

# ── 3. 분석 (MDD) ─────────────────────────────────────────────
print('=== 3. MDD 분석 ===')
mdd_df, top_df, traits = analyzer_run(df)
print(f'  분석 단지: {len(mdd_df)}개')
for dist, cnt in mdd_df['district_name'].value_counts().items():
    print(f'    {dist}: {cnt}개')

# ── 4. 월별 시계열 ────────────────────────────────────────────
print('=== 4. 시계열 구성 ===')
monthly = build_monthly_median(df)

# ── 4b. 전세가율 (전월세 데이터 있을 때만) ────────────────────
def compute_jeonse_ratio(monthly_df):
    """data/rent/*.parquet(collect_rent.py 수집)에서 전용 59㎡ 전세가율 계산.
    전세가율 = 최근 전세 중앙값 / 최근 매매 중앙값. 데이터 없으면 None."""
    rent_dir = Path('data/rent')
    files = sorted(rent_dir.glob('*.parquet')) if rent_dir.exists() else []
    if not files:
        print('  (전월세 데이터 없음 — 전세가율 축 비활성. collect_rent.py 수집 후 활성화됨)')
        return None
    rent = pd.concat([pd.read_parquet(f) for f in files], ignore_index=True)
    rent['district_name'] = rent['district_code'].astype(str).map(CODE2NAME)
    # 순수 전세(월세 0) + 전용 59㎡대만
    import config as _cfg
    rent = rent[(rent.get('monthly_rent', 0).fillna(0) == 0) &
                (rent['area_exclusive'] >= _cfg.TARGET_AREA_MIN) &
                (rent['area_exclusive'] <= _cfg.TARGET_AREA_MAX)].copy()
    if rent.empty:
        return None
    # 최근 18개월만 (전세가율은 최신 시세가 중요)
    rent['ym'] = rent['deal_year'].astype(str) + rent['deal_month'].astype(str).str.zfill(2)
    recent_cut = sorted(rent['ym'].unique())[-18:] if rent['ym'].nunique() > 18 else rent['ym'].unique()
    rent = rent[rent['ym'].isin(recent_cut)]
    jeonse_med = (rent.groupby(['district_name', 'apt_name'], observed=True)['deposit']
                  .median().rename('jeonse_median').reset_index())
    jeonse_cnt = (rent.groupby(['district_name', 'apt_name'], observed=True)['deposit']
                  .count().rename('jeonse_count').reset_index())

    # 매매 최근 18개월 중앙값 (monthly는 이미 59㎡ 대표값)
    m = monthly_df.copy()
    m['ym'] = m['deal_date'].astype(str).str.replace('-', '')
    recent_m = sorted(m['ym'].unique())[-18:]
    m = m[m['ym'].isin(recent_m)]
    sale_med = (m.groupby(['district_name', 'apt_name'], observed=True)['median_price']
                .median().rename('sale_median').reset_index())

    j = jeonse_med.merge(jeonse_cnt, on=['district_name', 'apt_name']) \
                  .merge(sale_med, on=['district_name', 'apt_name'], how='inner')
    j = j[(j['sale_median'] > 0) & (j['jeonse_count'] >= 2)]   # 전세 2건 이상만 신뢰
    if j.empty:
        return None
    j['jeonse_ratio'] = j['jeonse_median'] / j['sale_median']
    print(f'  전세가율 계산: {len(j)}개 단지 (중앙값 {j["jeonse_ratio"].median():.1%})')
    return j[['district_name', 'apt_name', 'jeonse_ratio', 'jeonse_median', 'jeonse_count']]

print('=== 4b. 전세가율 ===')
jeonse = compute_jeonse_ratio(monthly)

# ── 5. 종합 점수 ──────────────────────────────────────────────
print('=== 5. 종합 점수 계산 ===')
# 유동성 축의 '회전율' 계산에 쓸 추정세대수 (전 평형 거래 기준, preprocessor와 동일 로직)
from src.preprocessor import _estimate_households
households = _estimate_households(df)
score_df = compute_composite_score(mdd_df, monthly, households, jeonse)
weights_used = dict(score_df.attrs.get('weights_used', {}))   # rename 전에 보존
score_df = score_df.rename(columns={'district_name': 'district'})
# mdd 컬럼 추가 (dashboard.js에서 a.mdd 참조)
if 'mdd_pct' in score_df.columns and 'mdd' not in score_df.columns:
    score_df['mdd'] = score_df['mdd_pct']
print(f'  상위 10:')
print(score_df[['apt_name', 'district', 'composite_score']].head(10).to_string(index=False))

# ── 6. JSON 저장 ──────────────────────────────────────────────
print('=== 6. JSON 저장 ===')

# quality.json
save('quality.json', {
    'total_raw': len(df_raw),
    'total_clean': len(df),
    'total_apts': len(mdd_df),
    'penalty_removed': len(df_raw) - len(df),
    'filter_rate_pct': round((1 - len(df)/len(df_raw))*100, 1),
    'data_source': '국토교통부 실거래가 공개시스템',
    'collection_period': '2020.01 ~ 2026.06',
    'target_districts': list(DISTRICTS.keys()),
    'min_households': MIN_HOUSEHOLDS,
    'smoothing': '3개월 이동 중앙값',
    'outlier_method': 'z-score > 3.0 제거',
    'representative_area': '전용 59㎡ (18평)',
})

# pipeline.json
_mdd_keys = pd.MultiIndex.from_frame(mdd_df[['district_name', 'apt_name']])
stages = [
    {'label': '원본 거래', 'count': len(df_raw), 'desc': 'API 수집 전체'},
    {'label': '필터 후', 'count': len(df), 'desc': '벌점 5점 미만'},
    {'label': f'{MIN_HOUSEHOLDS}세대+', 'count': len(df[pd.MultiIndex.from_frame(df[['district_name', 'apt_name']]).isin(_mdd_keys)]),
     'desc': '대단지 기준 (대장아파트 일부 예외 포함)'},
]
penalty_rules = [
    {'rule': '1층', 'score': 2, 'reason': '1층 거래는 시세보다 낮아 가격 왜곡 가능'},
    {'rule': '직거래', 'score': 3, 'reason': '직거래는 비정상 가격 포함 가능성'},
    {'rule': '이상치(z>3)', 'score': 2, 'reason': '통계적 이상 거래'},
    {'rule': '결측', 'score': 2, 'reason': '핵심 필드 누락'},
]
save('pipeline.json', {'stages': stages, 'penalty_rules': penalty_rules, 'apt_counts': {}})

# mdd_ranking.json
mdd_out = mdd_df.rename(columns={'district_name': 'district', 'mdd_pct': 'mdd'})
_trades_by_key = df.groupby(['district_name', 'apt_name']).size()
mdd_out['total_trades'] = mdd_out.apply(
    lambda r: _trades_by_key.get((r['district'], r['apt_name']), 0), axis=1
)
save('mdd_ranking.json', {'ranking': mdd_out.sort_values('mdd', ascending=False).to_dict('records')})

# composite_score.json
# 실제로 사용된(재정규화된) 가중치를 그대로 반영 — 축 활성 여부에 따라 달라진다.
from src.scorer import AXIS_KR
weights = {AXIS_KR.get(k, k): round(v, 4) for k, v in weights_used.items()}
# 네이버 검색 정확도용 법정동(洞) 병합 (apt_locations 캐시가 있으면)
_locpath = Path('data/static/apt_locations.json')
if _locpath.exists():
    _loc = json.loads(_locpath.read_text(encoding='utf-8'))
    def _locget(r, k):
        return (_loc.get(f"{r['district']}|{r['apt_name']}") or {}).get(k)
    score_df['dong'] = score_df.apply(lambda r: _locget(r, 'dong'), axis=1)
    score_df['lat'] = score_df.apply(lambda r: _locget(r, 'lat'), axis=1)
    score_df['lng'] = score_df.apply(lambda r: _locget(r, 'lng'), axis=1)
save('composite_score.json', {'ranking': score_df.to_dict('records'), 'weights': weights})

# timeseries.json
# ⚠️ "현대"·"삼성"처럼 여러 구에 겹치는 단지명이 있어 district까지 함께 키로 써야
# 서로 다른 단지의 시계열이 하나로 합쳐지지 않는다.
apt_list = []
for (district_name, apt_name), grp in monthly.groupby(['district_name', 'apt_name']):
    g = grp.sort_values('deal_date')
    # median=스무딩 가격(라인용), raw=해당 월 실제 중앙 거래가, vol=월 거래 건수(거래량 바용)
    records = g[['deal_date', 'smoothed_price', 'median_price', 'trade_count']].rename(
        columns={'deal_date': 'ym', 'smoothed_price': 'median', 'median_price': 'raw', 'trade_count': 'vol'}
    ).to_dict('records')
    for r in records:
        r['ym'] = str(r['ym'])
        r['vol'] = int(r['vol']) if r['vol'] == r['vol'] else 0
        r['raw'] = round(float(r['raw'])) if r['raw'] == r['raw'] else None
    apt_list.append({'district': district_name, 'apt_name': apt_name, 'monthly': records})
save('timeseries.json', {'apartments': apt_list})

# traits.json
save('traits.json', traits if isinstance(traits, dict) else {})

# trades.json — 단지별 최근 실거래 내역 (상세 페이지 raw data 조회용)
analyzed = set(zip(score_df['district'], score_df['apt_name']))
tr = df[df.apply(lambda r: (r['district_name'], r['apt_name']) in analyzed, axis=1)].copy()
tr = tr.sort_values('deal_date', ascending=False)
trades = {}
for (dist, apt), grp in tr.groupby(['district_name', 'apt_name'], observed=True):
    recent = grp.head(60)
    trades[f'{dist}|{apt}'] = [
        {
            'ym': str(r['deal_date']),
            'day': int(r['deal_day']) if str(r['deal_day']).strip().isdigit() else None,
            'price': int(r['deal_amount']),
            'floor': int(r['floor']) if str(r['floor']).strip().lstrip('-').isdigit() else None,
            'area': round(float(r['area_exclusive']), 2),
        }
        for _, r in recent.iterrows()
    ]
save('trades.json', trades)

# district_info.json: 가격대·has_data를 실데이터로 갱신
info_path = OUT / 'district_info.json'
if info_path.exists():
    info = json.loads(info_path.read_text(encoding='utf-8'))
    latest_by_key = {}
    for a in apt_list:
        if a['monthly']:
            latest_by_key[(a['district'], a['apt_name'])] = a['monthly'][-1]['median']
    by_dist = {}
    for _, r in score_df.iterrows():
        p = latest_by_key.get((r['district'], r['apt_name']))
        if p:
            by_dist.setdefault(r['district'], []).append(p / 10000)
    for name, meta in info.items():
        prices = by_dist.get(name)
        meta['has_data'] = bool(prices)
        if prices:
            meta['price_low'] = round(min(prices))
            meta['price_high'] = round(max(prices))
    info_path.write_text(json.dumps(info, ensure_ascii=False, indent=2), encoding='utf-8')
    print('  갱신: district_info.json (실거래 최신가 기반 가격대)')

print()
print('=== 완료 ===')
print(f'분석 구: {sorted(score_df["district"].unique())}')
print(f'총 단지: {len(score_df)}개')
