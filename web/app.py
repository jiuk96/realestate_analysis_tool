"""
Flask 웹 대시보드 백엔드
미리 계산된 JSON 파일을 서빙 (빠른 시작)
"""

import json
import logging
from pathlib import Path
from flask import Flask, jsonify, render_template

app = Flask(__name__)
log = logging.getLogger(__name__)

DATA_DIR = Path(__file__).parent.parent / "data" / "processed"


def _load(name: str) -> dict:
    return json.loads((DATA_DIR / name).read_text(encoding="utf-8"))


@app.context_processor
def inject_asset_version():
    """정적 파일 캐시 무효화: dashboard.js 수정 시각을 버전으로 사용"""
    try:
        v = int((Path(__file__).parent / "static" / "dashboard.js").stat().st_mtime)
    except OSError:
        v = 0
    return {"asset_v": v}


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/quality")
def api_quality():
    return jsonify(_load("quality.json"))


@app.route("/api/pipeline")
def api_pipeline():
    return jsonify(_load("pipeline.json"))


@app.route("/api/timeseries")
def api_timeseries():
    return jsonify(_load("timeseries.json"))


@app.route("/api/mdd_ranking")
def api_mdd_ranking():
    return jsonify(_load("mdd_ranking.json"))


@app.route("/api/traits")
def api_traits():
    return jsonify(_load("traits.json"))


@app.route("/api/composite_score")
def api_composite_score():
    return jsonify(_load("composite_score.json"))


@app.route("/api/backtest")
def api_backtest():
    """점수 백테스트 결과 (backtest_scores.py 산출). 없으면 빈 dict."""
    try:
        return jsonify(_load("backtest.json"))
    except FileNotFoundError:
        return jsonify({})


@app.route("/api/trades")
def api_trades():
    """단지별 최근 실거래 내역: /api/trades?district=성동구&apt=행당한진타운"""
    from flask import request
    district = request.args.get("district", "")
    apt = request.args.get("apt", "")
    trades = _load("trades.json")
    return jsonify({"trades": trades.get(f"{district}|{apt}", [])})


@app.route("/api/apartments")
def api_apartments():
    """지도 탐색기용: 단지별 좌표 + 가격 + 점수 통합"""
    # ⚠️ "현대"·"삼성"처럼 여러 구에 겹치는 단지명이 있어 (구, 단지명) 복합키로
    # 조회해야 한다. apt_name만으로 키를 만들면 동명이인 단지끼리 덮어써진다.
    comp = _load("composite_score.json")
    mdd  = {(r["district"], r["apt_name"]): r for r in _load("mdd_ranking.json")["ranking"]}
    ts   = {(a["district"], a["apt_name"]): a["monthly"] for a in _load("timeseries.json")["apartments"]}

    loc_path = DATA_DIR.parent / "static" / "apt_locations.json"
    locs = json.loads(loc_path.read_text(encoding="utf-8")) if loc_path.exists() else {}

    out = []
    for r in comp["ranking"]:
        key = (r["district"], r["apt_name"])
        loc = locs.get(f"{r['district']}|{r['apt_name']}", {})
        monthly = ts.get(key, [])
        latest = monthly[-1]["median"] if monthly else None
        m = mdd.get(key, {})
        out.append({
            "apt_name": r["apt_name"],
            "district": r["district"],
            "rank": r.get("rank"),
            "composite_score": r.get("composite_score"),
            "defense_score": r.get("defense_score"),
            "liquidity_score": r.get("liquidity_score"),
            "upside_score": r.get("upside_score"),
            "momentum_score": r.get("momentum_score"),
            "premium_score": r.get("premium_score"),
            "scale_score": r.get("scale_score"),
            "transit_score": r.get("transit_score"),
            "mdd": r.get("mdd"),
            "momentum_pct": r.get("momentum_pct"),
            "build_year": r.get("build_year"),
            "area_exclusive": r.get("area_exclusive"),
            "latest_price": latest,
            "peak_price": m.get("peak_price"),
            "trough_price": m.get("trough_price"),
            "lat": loc.get("lat"),
            "lng": loc.get("lng"),
            "nearest_station": loc.get("nearest_station"),
            "nearest_station_m": loc.get("nearest_station_m"),
            "walk_min": r.get("walk_min"),
            "coord_source": loc.get("source", "geocoded"),
            "dong": loc.get("dong"),
            "downturn_experienced": r.get("downturn_experienced"),
            "turnover": r.get("turnover"),
            "jeonse_score": r.get("jeonse_score"),
            "jeonse_ratio": r.get("jeonse_ratio"),
        })
    return jsonify({"apartments": out})


@app.route("/api/districts")
def api_districts():
    """구별 정보 + 실데이터 합산"""
    info   = _load("district_info.json")
    comp   = _load("composite_score.json")
    qual   = _load("quality.json")

    # 구별 top 단지 집계
    district_top: dict = {}
    for r in comp["ranking"]:
        district_top.setdefault(r["district"], []).append(r)

    # peak_price 매핑은 루프 밖에서 1회만 로드
    price_map = {r["apt_name"]: r["peak_price"] for r in _load("mdd_ranking.json")["ranking"]}

    result = []
    for name, meta in info.items():
        entry = dict(meta)
        entry["name"] = name

        tops = district_top.get(name, [])
        entry["top_apts"] = tops[:3]                              # 상위 3개
        entry["top_score"] = tops[0]["composite_score"] if tops else None
        entry["top_apt_name"] = tops[0]["apt_name"] if tops else None
        entry["apt_count"] = len(tops)

        # 실데이터 평균 가격 (peak_price 기준, 억 단위)
        prices = [price_map[a["apt_name"]] for a in tops if a["apt_name"] in price_map]
        entry["avg_peak_price"] = round(sum(prices) / len(prices) / 10000, 1) if prices else None

        result.append(entry)

    # 분석 구 순서 (데이터 있는 구 먼저)
    result.sort(key=lambda x: (not x["has_data"], x["name"]))

    return jsonify({
        "districts": result,
        "total_districts": len(result),
        "districts_with_data": sum(1 for d in result if d["has_data"]),
        "collection_period": qual.get("collection_period", ""),
    })


if __name__ == "__main__":
    import os
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
