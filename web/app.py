"""
Flask 웹 대시보드 백엔드
샘플 데이터(또는 실제 수집 데이터)를 JSON으로 서빙
"""

import sys
import json
import logging
from pathlib import Path

from flask import Flask, jsonify, render_template

sys.path.insert(0, str(Path(__file__).parent.parent))

from tests.fixtures import make_sample_df
from src.preprocessor import run as preprocess, compute_penalties
from src.analyzer import build_monthly_median, run as analyze

app = Flask(__name__)
log = logging.getLogger(__name__)

# ── 데이터 캐시 (앱 시작 시 1회 계산) ────────────────────────
_cache: dict = {}

def _load_data():
    if _cache:
        return
    raw_df = make_sample_df()

    # 벌점 계산 전 원본 건수 기록
    penalized = compute_penalties(raw_df.copy())
    _cache["raw_count"]       = len(raw_df)
    _cache["raw_apts"]        = int(raw_df["apt_name"].nunique())
    _cache["penalty_removed"] = int((penalized["penalty"] >= 5).sum())

    clean_df = preprocess(raw_df)
    _cache["clean_count"] = len(clean_df)
    _cache["clean_apts"]  = int(clean_df["apt_name"].nunique())

    monthly = build_monthly_median(clean_df)
    mdd_df, top_df, traits = analyze(clean_df)

    _cache["monthly"]  = monthly
    _cache["mdd_df"]   = mdd_df
    _cache["top_df"]   = top_df
    _cache["traits"]   = traits
    _cache["clean_df"] = clean_df


@app.before_request
def ensure_data():
    _load_data()


# ── 라우트 ────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/pipeline")
def api_pipeline():
    """데이터 파이프라인 단계별 건수"""
    raw      = _cache["raw_count"]
    removed  = _cache["penalty_removed"]
    clean    = _cache["clean_count"]
    return jsonify({
        "stages": [
            {"label": "원본 수집",      "count": raw,     "desc": f"API에서 수집한 전체 거래"},
            {"label": "벌점 제거",      "count": raw - removed, "desc": f"벌점 ≥5점 거래 {removed:,}건 제외"},
            {"label": "단지 필터",      "count": clean,   "desc": f"500세대 미만·불량 단지 제외 후"},
        ],
        "apt_counts": {
            "raw":   _cache["raw_apts"],
            "clean": _cache["clean_apts"],
        },
        "penalty_rules": [
            {"rule": "1층 거래",           "score": 2, "reason": "저층 특수 거래로 시세 왜곡 가능"},
            {"rule": "직거래 의심",         "score": 3, "reason": "중앙값 60% 이하 → 증여·특수관계 거래 의심"},
            {"rule": "z-score 이상치",      "score": 2, "reason": "단지 내 분포 기준 극단값"},
            {"rule": "핵심 컬럼 결측",      "score": 2, "reason": "금액·면적·층수 중 하나 이상 없음"},
        ],
    })


@app.route("/api/timeseries")
def api_timeseries():
    """단지별 월별 중앙가 시계열 + 최고점/최저점"""
    monthly = _cache["monthly"]
    mdd_df  = _cache["mdd_df"]

    series = []
    for apt_name, grp in monthly.groupby("apt_name", observed=True):
        grp = grp.sort_values("deal_date")
        mdd_row = mdd_df[mdd_df["apt_name"] == apt_name]

        peak_date   = str(mdd_row["peak_date"].iloc[0])   if not mdd_row.empty else None
        trough_date = str(mdd_row["trough_date"].iloc[0]) if not mdd_row.empty else None
        mdd_pct     = float(mdd_row["mdd_pct"].iloc[0])   if not mdd_row.empty else None

        series.append({
            "apt_name":   str(apt_name),
            "dates":      [str(d) for d in grp["deal_date"]],
            "prices":     [round(p / 10000, 2) for p in grp["smoothed_price"]],   # 억 단위
            "raw_prices": [round(p / 10000, 2) for p in grp["median_price"]],
            "peak_date":   peak_date,
            "trough_date": trough_date,
            "mdd_pct":     mdd_pct,
        })

    return jsonify({"series": series})


@app.route("/api/mdd_ranking")
def api_mdd_ranking():
    """MDD 랭킹 (방어력 순)"""
    mdd_df = _cache["mdd_df"]
    top_df = _cache["top_df"]
    top_names = set(top_df["apt_name"].tolist())

    ranked = mdd_df.sort_values("mdd_pct", ascending=False).reset_index(drop=True)
    result = []
    for _, row in ranked.iterrows():
        result.append({
            "rank":          int(_ + 1),
            "apt_name":      str(row["apt_name"]),
            "district":      str(row["district_name"]),
            "mdd_pct":       float(row["mdd_pct"]),
            "peak_price":    int(row["peak_price"]),
            "trough_price":  int(row["trough_price"]),
            "peak_date":     str(row["peak_date"]),
            "trough_date":   str(row["trough_date"]),
            "build_year":    int(row["build_year"]),
            "area":          float(row["area_exclusive"]),
            "is_top":        str(row["apt_name"]) in top_names,
        })
    return jsonify({"ranking": result})


@app.route("/api/traits")
def api_traits():
    """공통 특성 비교"""
    traits = _cache["traits"]
    def _to_native(val):
        if isinstance(val, dict):
            return {str(kk): _to_native(vv) for kk, vv in val.items()}
        if hasattr(val, 'item'):   # numpy / pandas scalar
            return val.item()
        return val

    safe = {k: {sub: _to_native(val) for sub, val in v.items()} for k, v in traits.items()}
    return jsonify(safe)


@app.route("/api/quality")
def api_quality():
    """데이터 신뢰도 지표"""
    raw    = _cache["raw_count"]
    clean  = _cache["clean_count"]
    removed = _cache["penalty_removed"]

    return jsonify({
        "total_raw":          raw,
        "total_clean":        clean,
        "penalty_removed":    removed,
        "filter_rate_pct":    round((raw - clean) / raw * 100, 1) if raw else 0,
        "data_source":        "국토교통부 실거래가 공개시스템 (공공데이터포털)",
        "collection_period":  "2020년 1월 ~ 2025년 12월",
        "target_districts":   ["마포구", "용산구", "성동구"],
        "min_households":     500,
        "smoothing":          "3개월 이동 중앙값",
        "outlier_method":     "z-score > 3.0 제거",
    })


if __name__ == "__main__":
    app.run(debug=True, port=5000)
