"""
전세 합리성 점수 산출 모듈 — 매매 종합점수(scorer.py)의 전세 버전 (v2, 5축)
─────────────────────────────────────────────────────
"어디 전세가 합리적인가?"를 세입자 관점 5개 지표로 정량화한다. 매매와 동일한
percentile-rank(0~100, 이상치에 견고) 정규화를 쓴다.

v1 감사에서 드러난 결함과 v2의 교정:
  ① 가성비가 '매매 종합점수÷전세가'였는데, 매매 점수에는 재건축 잠재력(노후
     가점)·모멘텀 같은 투자축이 섞여 있어 40년차 재건축 후보가 상위를 휩쓸었다
     (거주 품질과 정반대). → 세입자 관점 '거주가치'를 별도 구성:
     교통 + 직주근접 + 학군 + 연식(신축 가점). 투자축은 배제.
  ② 유동성이 거래건수 percentile이라 대단지가 기계적으로 만점(매매에서 이미
     고쳤던 규모 편향). → 회전율(연환산 전세거래 ÷ 추정 세대수) 중심으로 교정.
  ③ 수집해 둔 전세가 추세(jeonse_trend_pct)·구내 상대가를 안 쓰고 있었다.
     → '시세 안정' 축 신설, 구내 상대가를 저렴도에 반영.
  ④ 보증금 안전이 전세가율 하나뿐. 깡통 위험은 "전세가율이 높고 + 매매가가
     잘 빠지는 집"에서 커진다. → 매매 방어력·가격 변동성을 함께 반영.

지표                 비중   판단 근거 (세입자에게 '합리적' = ?)
① 가성비            30%  - 거주가치(교통25+직주25+학군20+연식30) ÷ 전세평단가.
                          "이 거주 품질을 이 전세금에?" — 같은 값이면 살기 좋은 집.
② 전세 저렴도       15%  - ㎡당 전세금: 서울 전체(60%) + 같은 구 안(40%) 상대가.
③ 보증금 안전       25%  - 전세가율 낮음(55%) + 매매 방어력(25%) + 매매가
                          변동성 낮음(20%). 보증금을 돌려받을 안전판.
④ 시세 안정         10%  - 전세가 추세(연율 %)의 절대값이 작을수록. 급등은 재계약
                          부담, 급락은 역전세(보증금 미반환) 신호 — 양쪽 다 리스크.
⑤ 전세 유동성       20%  - 회전율(연환산 전세거래÷추정세대수, 60%) + 절대 건수
                          (40%). 매물이 꾸준히 돌아야 구하기도, 나가기도 쉽다.

입력 df는 build_data의 score_df(매매 축 점수 포함) + 전세 통계.
households(추정 세대수)가 없으면 회전율은 건수만으로 대체(자동 재정규화).
"""

import logging
import numpy as np
import pandas as pd

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))
sys.path.insert(0, str(Path(__file__).parent))
from scorer import _pct_rank   # 매매와 동일한 정규화 재사용

log = logging.getLogger(__name__)

# 지표 가중치 (합 1.0) — 하드코딩 금지 원칙에 따라 여기서만 조정
JEONSE_WEIGHTS = {
    "value":     0.30,   # 가성비 (거주가치 대비 전세 저렴)
    "cheap":     0.15,   # 전세 저렴도 (서울+구내 상대가)
    "safety":    0.25,   # 보증금 안전 (전세가율+매매 방어력+변동성)
    "stability": 0.10,   # 시세 안정 (전세가 추세 절대값)
    "liquidity": 0.20,   # 전세 유동성 (회전율+건수)
}

JEONSE_AXIS_KR = {
    "value": "가성비", "cheap": "전세저렴도", "safety": "보증금안전",
    "stability": "시세안정", "liquidity": "전세유동성",
}

# 전세 데이터는 최근 18개월치 → 연환산 계수 (회전율 계산용)
JEONSE_WINDOW_YEARS = 18 / 12.0


def _living_quality(d: pd.DataFrame) -> pd.Series:
    """세입자 관점 거주가치 0~100 — 투자축(재건축·모멘텀·방어력) 배제.
    교통(25) + 직주근접(25) + 학군(20) + 연식·신축(30).
    축 결측(좌표·학교 데이터 없음)은 중립 50으로 채워 비교 불이익을 없앤다."""
    transit = pd.to_numeric(d.get("transit_score"), errors="coerce")
    hub     = pd.to_numeric(d.get("hub_score"), errors="coerce")
    school  = pd.to_numeric(d.get("school_score"), errors="coerce")
    # 연식: 신축일수록 높음 (매매의 재건축축과 정반대 방향 — 세입자는 새 집이 좋다)
    newness = _pct_rank(pd.to_numeric(d.get("build_year"), errors="coerce"))
    parts = [
        (transit if transit is not None else pd.Series(dtype=float)).fillna(50.0) * 0.25,
        (hub     if hub     is not None else pd.Series(dtype=float)).fillna(50.0) * 0.25,
        (school  if school  is not None else pd.Series(dtype=float)).fillna(50.0) * 0.20,
        newness.fillna(50.0) * 0.30,
    ]
    return sum(parts).clip(0, 100)


def compute_jeonse_score(df: pd.DataFrame, households: pd.DataFrame | None = None) -> tuple[pd.DataFrame, dict]:
    """
    전세 합리성 점수 계산 (0~100), v2 5축.
    입력 df 필수: district, apt_name, area_exclusive, jeonse_median(만원),
      jeonse_ratio, jeonse_count, jeonse_trend_pct(결측 가능)
    선택(있으면 정밀도↑): transit_score, hub_score, school_score, build_year,
      defense_score, price_vol_annual
    households: district_name/apt_name/est_households (회전율용, 없으면 건수만)
    반환: (ranking_df, weights_used)
    """
    d = df[df["jeonse_median"].notna() & (df["jeonse_median"] > 0)].copy()
    if d.empty:
        return d, {}

    # ㎡당 전세금(만원) — 전세 평단가
    d["jeonse_ppm"] = d["jeonse_median"] / d["area_exclusive"]

    # ── ① 가성비: 거주가치 ÷ 전세평단가 ──────────────────────
    d["living_quality"] = _living_quality(d)
    d["quality_per_cost"] = d["living_quality"] / d["jeonse_ppm"].replace(0, np.nan)
    d["axis_value"] = _pct_rank(d["quality_per_cost"]).fillna(50.0)

    # ── ② 전세 저렴도: 서울 전체(60%) + 구내 상대(40%) ────────
    seoul_cheap = _pct_rank(d["jeonse_ppm"], low_is_good=True)
    indist_rank = (d.groupby("district")["jeonse_ppm"]
                     .rank(pct=True, ascending=True) * 100)          # 낮을수록 구내에서 싼 전세
    d["jeonse_ppm_district_top_pct"] = indist_rank.round(0)
    d["axis_cheap"] = (seoul_cheap * 0.6 + (100 - indist_rank) * 0.4).clip(0, 100)

    # ── ③ 보증금 안전: 전세가율(55) + 매매 방어력(25) + 변동성(20) ─
    ratio_score = _pct_rank(d["jeonse_ratio"].clip(0, 1.0), low_is_good=True)
    defense = pd.to_numeric(d.get("defense_score"), errors="coerce")
    vol = pd.to_numeric(d.get("price_vol_annual"), errors="coerce")
    if defense is not None and defense.notna().any():
        vol_score = _pct_rank(vol, low_is_good=True).fillna(50.0)
        d["axis_safety"] = (ratio_score * 0.55 + defense.fillna(50.0) * 0.25 + vol_score * 0.20).clip(0, 100)
    else:
        d["axis_safety"] = ratio_score

    # ── ④ 시세 안정: 전세가 추세 |연율%| 작을수록 ─────────────
    trend = pd.to_numeric(d.get("jeonse_trend_pct"), errors="coerce")
    d["axis_stability"] = _pct_rank(trend.abs(), low_is_good=True).fillna(50.0)

    # ── ⑤ 전세 유동성: 회전율(60) + 건수(40) ─────────────────
    cnt = pd.to_numeric(d["jeonse_count"], errors="coerce").fillna(0)
    cnt_score = _pct_rank(cnt)
    hh_map = {}
    if households is not None and not households.empty:
        hh_map = {(r["district_name"], r["apt_name"]): r["est_households"]
                  for _, r in households.iterrows()}
    if hh_map:
        d["jeonse_turnover"] = [
            (c / JEONSE_WINDOW_YEARS) / hh_map[(dist, apt)]
            if hh_map.get((dist, apt), 0) > 0 else np.nan
            for c, dist, apt in zip(cnt, d["district"], d["apt_name"])
        ]
        turn_score = _pct_rank(d["jeonse_turnover"]).fillna(50.0)
        d["axis_liquidity"] = (turn_score * 0.6 + cnt_score * 0.4).clip(0, 100)
    else:
        d["jeonse_turnover"] = np.nan
        d["axis_liquidity"] = cnt_score   # 세대수 정보가 없으면 건수만 (규모 편향 감수)

    # ── 종합 ─────────────────────────────────────────────────
    w = JEONSE_WEIGHTS
    d["jeonse_total"] = (
        d["axis_value"]     * w["value"] +
        d["axis_cheap"]     * w["cheap"] +
        d["axis_safety"]    * w["safety"] +
        d["axis_stability"] * w["stability"] +
        d["axis_liquidity"] * w["liquidity"]
    ).round(1)

    d = d.sort_values("jeonse_total", ascending=False).reset_index(drop=True)
    d["jeonse_rank"] = d.index + 1

    n_turn = int(d["jeonse_turnover"].notna().sum()) if "jeonse_turnover" in d else 0
    log.info(f"전세 합리성 v2: {len(d)}개 단지 (회전율 산출 {n_turn}개)")
    return d, dict(w)
