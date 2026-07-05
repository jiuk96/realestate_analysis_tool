"""
전세 합리성 점수 산출 모듈 — 매매 종합점수(scorer.py)의 전세 버전
─────────────────────────────────────────────────────
"어디 전세가 합리적인가?"를 세입자 관점의 4개 지표로 정량화한다. 매매와 동일한
percentile-rank(0~100, 이상치에 견고) 정규화를 쓴다.

지표                 비중   판단 근거 (세입자에게 '합리적' = ?)
① 가성비            40%  - 입지·품질(매매 종합점수) 대비 전세평단가가 쌀수록.
                          즉 "이 정도 입지를 이 전세금에?" — 같은 값이면 더 좋은 집.
② 전세 평단가 저렴   20%  - ㎡당 전세금이 절대적으로 낮을수록(같은 크기를 싸게).
③ 보증금 안전       20%  - 전세가율(전세÷매매)이 낮을수록 깡통전세 위험이 작다.
                          (매매가가 전세금을 넉넉히 위에서 받쳐주는 상태)
④ 전세 유동성       20%  - 전세 거래가 많을수록 매물 구하기 쉽고 시세가 투명하다.

⚠️ ③은 "적은 돈으로 상급지 거주"(전세가율 높은 곳)와는 반대 관점이다. 이 점수는
   보증금 안전을 '합리적'으로 보므로 낮은 전세가율에 가점한다(상세에 트레이드오프
   고지). 입력은 build_data가 매매 분석과 함께 계산한 단지별 전세 통계를 쓴다.
"""

import logging
import pandas as pd

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))
sys.path.insert(0, str(Path(__file__).parent))
from scorer import _pct_rank   # 매매와 동일한 정규화 재사용

log = logging.getLogger(__name__)

# 지표 가중치 (합 1.0) — 하드코딩 금지 원칙에 따라 여기서만 조정
JEONSE_WEIGHTS = {
    "value":     0.40,   # 가성비 (입지 대비 전세 저렴)
    "cheap":     0.20,   # 전세 평단가 저렴도
    "safety":    0.20,   # 보증금 안전 (낮은 전세가율)
    "liquidity": 0.20,   # 전세 유동성 (거래 활발)
}

JEONSE_AXIS_KR = {
    "value": "가성비", "cheap": "전세평단가", "safety": "보증금안전", "liquidity": "전세유동성",
}


def compute_jeonse_score(df: pd.DataFrame) -> tuple[pd.DataFrame, dict]:
    """
    전세 합리성 점수 계산 (0~100).
    입력 df 필수 컬럼: district, apt_name, area_exclusive, composite_score,
      jeonse_median(만원), jeonse_ratio(0~1), jeonse_count, jeonse_gap(만원),
      jeonse_trend_pct(연율 %, 결측 가능).
    전세 데이터(jeonse_median)가 있는 단지만 대상으로 한다.
    반환: (ranking_df, weights_used)
    """
    d = df[df["jeonse_median"].notna() & (df["jeonse_median"] > 0)].copy()
    if d.empty:
        return d, {}

    # ㎡당 전세금(만원) — 전세 평단가
    d["jeonse_ppm"] = d["jeonse_median"] / d["area_exclusive"]

    # ① 가성비: 입지·품질(매매 종합점수) 대비 전세평단가.
    #    quality_per_cost = 종합점수 / 전세평단가 → 높을수록 "싼 값에 좋은 집".
    quality = pd.to_numeric(d["composite_score"], errors="coerce").fillna(50.0)
    d["quality_per_cost"] = quality / d["jeonse_ppm"].replace(0, pd.NA)
    d["axis_value"] = _pct_rank(d["quality_per_cost"]).fillna(50.0)

    # ② 전세 평단가 저렴도 (낮을수록 좋음)
    d["axis_cheap"] = _pct_rank(d["jeonse_ppm"], low_is_good=True)

    # ③ 보증금 안전 = 낮은 전세가율 (깡통전세 위험 작음)
    d["axis_safety"] = _pct_rank(d["jeonse_ratio"].clip(0, 1.0), low_is_good=True)

    # ④ 전세 유동성 = 전세 거래 건수 많을수록
    d["axis_liquidity"] = _pct_rank(pd.to_numeric(d["jeonse_count"], errors="coerce").fillna(0))

    w = JEONSE_WEIGHTS
    d["jeonse_total"] = (
        d["axis_value"]     * w["value"] +
        d["axis_cheap"]     * w["cheap"] +
        d["axis_safety"]    * w["safety"] +
        d["axis_liquidity"] * w["liquidity"]
    ).round(1)

    # 구내 전세 평단가 상대 순위(하위 %일수록 그 구에서 싼 전세)
    d["jeonse_ppm_district_top_pct"] = (
        d.groupby("district")["jeonse_ppm"].rank(pct=True, ascending=True) * 100
    ).round(0)

    d = d.sort_values("jeonse_total", ascending=False).reset_index(drop=True)
    d["jeonse_rank"] = d.index + 1

    log.info(f"전세 합리성 점수: {len(d)}개 단지")
    return d, dict(w)
