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
from src.scorer import compute_composite_score

DISTRICTS = {
    '마포구': '11440', '용산구': '11170', '성동구': '11200',
    '광진구': '11215', '동대문구': '11230', '은평구': '11380',
    '서대문구': '11410', '양천구': '11470', '강서구': '11500',
    '영등포구': '11560', '동작구': '11590', '관악구': '11620',
    '강동구': '11740', '종로구': '11110',
}
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

# ── 5. 종합 점수 ──────────────────────────────────────────────
print('=== 5. 종합 점수 계산 ===')
score_df = compute_composite_score(mdd_df, monthly)
score_df = score_df.rename(columns={'district_name': 'district'})
# mdd 컬럼 추가 (dashboard.js에서 a.mdd 참조)
if 'mdd_pct' in score_df.columns and 'mdd' not in score_df.columns:
    score_df['mdd'] = score_df['mdd_pct']
# scorer 출력 컬럼 → dashboard 기대 컬럼 매핑
col_map = {
    'consistency_score': 'continuity_score',
    'resilience_score': 'mdd_score',
    'upside_score': 'recovery_score',
    'subway_score': 'transport_score',
}
score_df = score_df.rename(columns=col_map)
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
    'min_households': 500,
    'smoothing': '3개월 이동 중앙값',
    'outlier_method': 'z-score > 3.0 제거',
})

# pipeline.json
stages = [
    {'label': '원본 거래', 'count': len(df_raw), 'desc': 'API 수집 전체'},
    {'label': '필터 후', 'count': len(df), 'desc': '벌점 5점 미만'},
    {'label': '500세대+', 'count': len(df[df['apt_name'].isin(mdd_df['apt_name'])]),
     'desc': '대단지 기준'},
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
mdd_out['total_trades'] = mdd_out['apt_name'].map(df.groupby('apt_name').size())
save('mdd_ranking.json', {'ranking': mdd_out.sort_values('mdd', ascending=False).to_dict('records')})

# composite_score.json
weights = {'거래지속성': 0.30, '가격방어력': 0.25, '상승참여도': 0.20, '교통': 0.12, '인프라': 0.08, '학군': 0.05}
save('composite_score.json', {'ranking': score_df.to_dict('records'), 'weights': weights})

# timeseries.json
apt_list = []
for apt_name, grp in monthly.groupby('apt_name'):
    records = grp.sort_values('deal_date')[['deal_date', 'smoothed_price']].rename(columns={'deal_date': 'ym', 'smoothed_price': 'median'}).to_dict('records')
    for r in records:
        r['ym'] = str(r['ym'])
    apt_list.append({'apt_name': apt_name, 'monthly': records})
save('timeseries.json', {'apartments': apt_list})

# traits.json
save('traits.json', traits if isinstance(traits, dict) else {})

print()
print('=== 완료 ===')
print(f'분석 구: {sorted(score_df["district"].unique())}')
print(f'총 단지: {len(score_df)}개')
