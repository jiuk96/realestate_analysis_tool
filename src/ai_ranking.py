"""
AI 추천 매물 순위 — 스펙 §2 기반 (데이터 보유분에 맞춰 5축으로 축소)
─────────────────────────────────────────────────────
기존 '우량 단지 점수'(방어력 중심)와 달리, 저평가·상품성·유동성 중심의 다른
렌즈로 매물을 랭킹한다. 새 데이터를 받지 않고 이미 산출된 중간값
(data/processed/composite_score.json)을 재사용한다.

축(원 스펙 7축 → 데이터 없는 2축 제외 후 재정규화, 가중치는 config에서만 조정):
  · 저평가도 (26.7%) : 전세가율(높을수록 저평가) + 구내 ㎡당가(낮을수록 저평가)
  · 유동성   (20.0%) : 기존 liquidity_score 재사용 (공백률+유지율+변동+회전율)
  · 교통입지 (20.0%) : 기존 transit_score 재사용 (역 도보 + 역세권 밀도)
  · 모멘텀   (20.0%) : 기존 momentum_score 재사용 (Theil-Sen 추세)
  · 상품성   (13.3%) : 준공연도(신축일수록 높음)
제외: 수요·관심도(검색 트렌드 없음), 학군·생활(단지별 학교거리 없음)

정규화: 보유 단지 전체 대상 percentile rank(0~100).
methodology_version = "heuristic_v1_5axis" (표본 394로 작아 ML 미사용, §2 보조지표 사용)

실행: python src/ai_ranking.py   (build_data.py로 composite_score.json 생성된 뒤)
출력: data/processed/ai_ranking.json
"""

import json
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "src"))
import config
from scorer import _pct_rank   # 기존 정규화 재사용 (percentile-rank 0~100)

PROCESSED = ROOT / "data" / "processed"
SRC = PROCESSED / "composite_score.json"
OUT = PROCESSED / "ai_ranking.json"

METHODOLOGY = "heuristic_v1_5axis"

# 축 한글 라벨 (UI 표시용)
AXIS_KR = {
    "undervalued": "저평가도",
    "liquidity":   "유동성",
    "transit":     "교통입지",
    "momentum":    "모멘텀",
    "product":     "상품성",
}


def _highlight_phrase(axis: str, row: pd.Series) -> str:
    """상위 축 1개에 대한 한 줄 근거 문구 (실수치 인용)."""
    if axis == "undervalued":
        jr = row.get("jeonse_ratio")
        indist = row.get("premium_in_district_top_pct")
        bits = []
        if pd.notna(jr):
            bits.append(f"전세가율 {round(jr*100)}%")
        if pd.notna(indist):
            bits.append(f"{row['district']} 내 평단가 하위 {round(indist)}%")
        return "저평가 매력 — " + (", ".join(bits) if bits else "전세가·평단가 기준 저평가권")
    if axis == "liquidity":
        return f"거래가 활발해 환금성 우수 (누적 {int(row.get('total_trades', 0)):,}건)"
    if axis == "transit":
        st = row.get("nearest_station")
        wm = row.get("walk_min")
        if pd.notna(st) and pd.notna(wm):
            return f"{st} 도보 {round(wm)}분의 역세권 입지"
        return "교통 접근성 우수"
    if axis == "momentum":
        m = row.get("momentum_pct")
        if pd.notna(m):
            return f"최근 가격이 연 {'+' if m >= 0 else ''}{m:.1f}% 추세로 상승 흐름"
        return "가격 상승 모멘텀"
    if axis == "product":
        by = row.get("build_year")
        age = row.get("apt_age")
        if pd.notna(by):
            return f"{int(by)}년 준공({int(age)}년차)의 상품성"
        return "상품성 우수"
    return AXIS_KR.get(axis, axis)


def build() -> dict:
    if not SRC.exists():
        raise FileNotFoundError(f"{SRC} 없음 — build_data.py를 먼저 실행하세요.")
    comp = json.loads(SRC.read_text(encoding="utf-8"))
    df = pd.DataFrame(comp["ranking"])
    n = len(df)

    # ── 축별 0~100 점수 ──────────────────────────────────────
    # 저평가도: 전세가율(높을수록 저평가) 60% + 구내 평단가 하위(낮을수록 저평가) 40%.
    #  전세가율 결측 단지는 그 하위지표만 중립(50)으로 두고 나머지로 평가.
    jr_score = _pct_rank(df["jeonse_ratio"]) if "jeonse_ratio" in df else pd.Series([50.0] * n)
    jr_score = jr_score.fillna(50.0)
    # premium_in_district_top_pct: 100=구내 최저가(가장 저평가), 1=구내 최고가
    if "premium_in_district_top_pct" in df:
        indist_cheap = _pct_rank(df["premium_in_district_top_pct"]).fillna(50.0)
    else:
        indist_cheap = pd.Series([50.0] * n)
    df["score_undervalued"] = (jr_score * 0.6 + indist_cheap * 0.4).clip(0, 100)

    # 유동성·교통·모멘텀: 기존 percentile 점수 그대로 재사용 (결측은 중립 50)
    df["score_liquidity"] = pd.to_numeric(df.get("liquidity_score"), errors="coerce").fillna(50.0).clip(0, 100)
    df["score_transit"]   = pd.to_numeric(df.get("transit_score"),   errors="coerce").fillna(50.0).clip(0, 100)
    df["score_momentum"]  = pd.to_numeric(df.get("momentum_score"),  errors="coerce").fillna(50.0).clip(0, 100)

    # 상품성: 준공연도(신축일수록 높음)
    df["score_product"] = _pct_rank(pd.to_numeric(df["build_year"], errors="coerce")).fillna(50.0).clip(0, 100)

    # ── 종합 (config 가중치, 합=1.0) ─────────────────────────
    w = config.AI_RANKING_WEIGHTS
    df["ai_score"] = (
        df["score_undervalued"] * w["undervalued"] +
        df["score_liquidity"]   * w["liquidity"] +
        df["score_transit"]     * w["transit"] +
        df["score_momentum"]    * w["momentum"] +
        df["score_product"]     * w["product"]
    ).clip(0, 100).round(1)

    df["low_confidence"] = (df.get("data_confidence") == "low")

    df = df.sort_values("ai_score", ascending=False).reset_index(drop=True)
    df["ai_rank"] = df.index + 1

    axis_keys = ["undervalued", "liquidity", "transit", "momentum", "product"]
    ranking = []
    for _, r in df.iterrows():
        axes = {ax: round(float(r[f"score_{ax}"]), 1) for ax in axis_keys}
        # 상위 2개 축으로 highlight 문구
        top2 = sorted(axis_keys, key=lambda ax: axes[ax], reverse=True)[:2]
        highlights = [_highlight_phrase(ax, r) for ax in top2]
        ranking.append({
            "ai_rank": int(r["ai_rank"]),
            "district": r["district"],
            "apt_name": r["apt_name"],
            "ai_score": float(r["ai_score"]),
            "axes": axes,
            "highlights": highlights,
            "low_confidence": bool(r["low_confidence"]),
            # 표시용 부가 정보 (기존 필드 재사용)
            "build_year": int(r["build_year"]) if pd.notna(r.get("build_year")) else None,
            "area_exclusive": float(r["area_exclusive"]) if pd.notna(r.get("area_exclusive")) else None,
            "dong": r.get("dong"),
            "lat": r.get("lat"), "lng": r.get("lng"),
        })

    result = {
        "methodology_version": METHODOLOGY,
        "weights": {AXIS_KR[k]: round(v, 4) for k, v in w.items()},
        "excluded_axes": config.AI_RANKING_EXCLUDED_AXES,
        "n_axes": len(w),
        "total_apts": len(ranking),
        "ranking": ranking,
    }
    OUT.write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
    return result


if __name__ == "__main__":
    res = build()
    print(f"AI 순위 저장: {OUT}  ({res['total_apts']}개 단지, {res['n_axes']}축, {res['methodology_version']})")
    print(f"가중치: {res['weights']} (합 {round(sum(config.AI_RANKING_WEIGHTS.values()),4)})")
    print("\n상위 10개 (상식 점검):")
    hdr = f"{'순':>2} {'구':<6} {'단지':<16} {'AI':>5} | {'저평가':>5} {'유동':>5} {'교통':>5} {'모멘':>5} {'상품':>5}  conf"
    print(hdr)
    for r in res["ranking"][:10]:
        a = r["axes"]
        conf = "표본부족" if r["low_confidence"] else ""
        print(f"{r['ai_rank']:>2} {r['district']:<6} {r['apt_name'][:15]:<16} {r['ai_score']:>5} | "
              f"{a['undervalued']:>5} {a['liquidity']:>5} {a['transit']:>5} {a['momentum']:>5} {a['product']:>5}  {conf}")
