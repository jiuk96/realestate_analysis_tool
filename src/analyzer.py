"""
MDD(Maximum Drawdown) 계산 및 하락장 방어력 분석
- 단지별 최고점/최저점 월 자동 탐지
- MDD(%) 계산 및 방어력 상위 10% 추출
- 공통 특성 도출 (연식, 구, 세대수 추정)
"""

import logging
import numpy as np
import pandas as pd

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))
import config

log = logging.getLogger(__name__)


# ── 1. 월별 중앙가 시계열 생성 ────────────────────────────────

def build_monthly_median(df: pd.DataFrame) -> pd.DataFrame:
    """
    단지 × 면적 그룹별 월별 중앙 거래가 산출.
    단지마다 주력 면적이 달라 비교가 왜곡되므로, 전 단지를 동일 평형
    (전용 59㎡ = 18평대, config.TARGET_AREA_MIN~MAX)으로 통일한다.
    해당 평형대 거래 중 최다 면적을 각 단지의 대표 타입으로 사용하며,
    이 평형대 거래가 없는 단지는 분석에서 제외된다.
    반환: [apt_name, deal_date, median_price, area_exclusive, district_name, build_year]
    """
    # 전용 59㎡대(18평)만 남김 — 전 단지 동일 평형 비교
    df = df[
        (df["area_exclusive"] >= config.TARGET_AREA_MIN) &
        (df["area_exclusive"] <= config.TARGET_AREA_MAX)
    ].copy()

    # 59㎡대 안에서 단지별 최다 거래 면적을 대표 타입으로 선정
    # ⚠️ "현대"·"삼성"처럼 여러 구에 겹치는 단지명이 많아 district_name을
    # 반드시 함께 키로 써야 한다(안 그러면 서로 다른 단지의 거래가 섞인다).
    key = ["district_name", "apt_name"]
    dominant_area = (
        df.groupby(key + ["area_exclusive"], observed=True)
        .size()
        .reset_index(name="cnt")
        .sort_values("cnt", ascending=False)
        .drop_duplicates(key)
        [key + ["area_exclusive"]]
    )

    df = df.merge(dominant_area, on=key + ["area_exclusive"], how="inner")

    monthly = (
        df.groupby(key + ["deal_date"], observed=True)
        .agg(
            median_price   = ("deal_amount", "median"),
            trade_count    = ("deal_amount", "count"),
            build_year     = ("build_year", "first"),
            area_exclusive = ("area_exclusive", "first"),
        )
        .reset_index()
    )

    # ⚠️ 예전에는 "거래 1건뿐인 달은 노이즈"라며 trade_count>=2인 달만 남겼으나,
    # 59㎡ 대표평형은 초고가·저유동 단지일수록 한 달에 1건만 거래되는 경우가
    # 대부분이라(예: 흑석한강센트레빌Ⅱ는 12건 중 2건만 같은 달에 2건 거래),
    # 이 필터를 적용하면 최근 실거래(예: 19억)가 통째로 빠지고 몇 년 전 거래만
    # 남아 현재가가 실제보다 크게 낮게 표시되는 문제가 있었다. 노이즈 억제는
    # 이후 이상치 필터(_filter_price_outlier_months)와 3개월 스무딩으로 충분히
    # 처리되므로, 거래 건수 자체로 달을 통째로 버리지 않는다.

    # 주변 기간 대비 비정상적으로 낮은 달(다운계약·지분거래·동명이인 단지 혼입 등
    # 의심) 제거 — 3개월 스무딩만으로는 이상거래가 2~3개월 연속으로 몰리면
    # 못 걸러지므로, 그 전에 넓은 이웃 구간 기준으로 먼저 걸러낸다.
    monthly = monthly.sort_values(key + ["deal_date"])
    monthly = _filter_price_outlier_months(monthly)

    # 3개월 이동 중앙값으로 스무딩 (단기 스파이크 완화)
    monthly["smoothed_price"] = (
        monthly.groupby(key, observed=True)["median_price"]
        .transform(lambda s: s.rolling(3, min_periods=1, center=True).median())
    )

    return monthly


OUTLIER_WINDOW = 9        # 이웃 구간 폭(개월, 짝수면 자동으로 +1)
OUTLIER_MIN_PERIODS = 3   # 이웃 구간에 최소 이 정도는 있어야 판단
OUTLIER_DROP_RATIO = 0.70 # 이웃 구간 중앙값 대비 이 비율 미만이면 이상치로 제외


def _filter_price_outlier_months(monthly: pd.DataFrame) -> pd.DataFrame:
    """
    단지별 월별 시세 중 "넓은 이웃 구간(±4개월, 총 9개월)" 중앙값 대비
    OUTLIER_DROP_RATIO(기본 70%) 미만으로 뚝 떨어진 달을 통계에서 제외한다.

    바로 앞뒤 1개월만 비교하면 다운계약·지분거래·동일 단지명 다른 건물 혼입 등의
    이상거래가 2~3개월 연속으로 몰릴 때 놓칠 수 있다. 예: A월 165,000 → B월
    52,250 → C월 51,500 → D월 162,150 처럼 이상 저가가 2개월 이어지면 인접
    1개월 비교로는 "그 다음 달에도 낮으니 정상 하락"으로 오판하지만, 9개월
    폭의 중앙값과 비교하면 주변 시세(약 15만원대)에서 크게 벗어난 것이 드러난다.
    """
    def _flag(s: pd.Series) -> pd.Series:
        baseline = s.rolling(OUTLIER_WINDOW, center=True, min_periods=OUTLIER_MIN_PERIODS).median()
        return (s < baseline * OUTLIER_DROP_RATIO) & baseline.notna()

    is_outlier = (
        monthly.groupby(["district_name", "apt_name"], observed=True)["median_price"]
        .transform(_flag)
    )
    removed = int(is_outlier.sum())
    if removed:
        log.info(f"이상 저가 월 제외: {removed}건 (주변 9개월 중앙값 대비 70% 미만)")
    return monthly[~is_outlier].copy()


# ── 2. 최고점 / 최저점 탐지 ───────────────────────────────────

def _period_to_str(p) -> str:
    return str(p) if p is not None else "N/A"


ISOLATED_DIP_RATIO = 0.85   # 전/후 관측치 대비 이 비율 미만이면 '고립 저가' 의심


def _is_isolated_dip(prices: pd.Series, i: int, drop_ratio: float = ISOLATED_DIP_RATIO) -> bool:
    """
    i번째 지점이 바로 이전·이후 관측치보다 급격히(기본 15%↑) 낮았다가 바로 회복되는
    '고립된 저가'인지 판단한다.

    다운계약·특수관계인 간 거래·급전 필요에 의한 저가 처분 등은 대개 한두 달만
    반짝 나타나고 다음 관측치에서 곧바로 정상 시세로 돌아온다. 이런 패턴은
    실제 "시장이 하락했다가 그 가격에서 유지"된 것이 아니라 개별 이상거래일
    가능성이 높으므로 저점(trough) 후보에서 제외한다.
    맨 앞/맨 뒤 지점은 비교할 이웃이 한쪽뿐이라 판단을 보류(고립 아님으로 간주)한다.
    """
    if i <= 0 or i >= len(prices) - 1:
        return False
    price = prices.iloc[i]
    prev_p = prices.iloc[i - 1]
    next_p = prices.iloc[i + 1]
    return price < prev_p * drop_ratio and price < next_p * drop_ratio


def _max_drawdown_indices(prices: np.ndarray, excluded: np.ndarray) -> tuple[int, int, float]:
    """
    표준 MDD(Maximum Drawdown) 알고리즘.
    시계열을 한 번 훑으며 "그 시점까지의 최고가(running max) → 현재가"의 낙폭을
    매 시점마다 계산해, 낙폭이 가장 컸던 (고점, 저점) 쌍을 찾는다.

    특정 연도로 고점을 고정하는 대신 전체 기간에서 "실제로 있었던 가장 큰
    하락 구간"을 그대로 찾아내므로, 특정 캘린더 구간에 거래가 적어 고점이
    엉뚱하게(예: 최근 신고가) 잡히는 문제가 없다.

    excluded=True인 지점(고립된 이상 저가)은 저점 후보에서 제외하되,
    고점(running max) 갱신에는 계속 사용할 수 있게 한다 — 이상거래가 고점을
    부풀리는 경우는 드물고(대개 저가 다운계약이 문제), 오히려 고점 후보에서
    빼면 그 시점 이후의 정상적인 하락 구간을 놓칠 수 있기 때문이다.

    반환: (peak_idx, trough_idx, worst_drawdown) — 하락이 전혀 없으면
          worst_drawdown=0.0, peak_idx=trough_idx=전체 최고가 지점.
    """
    running_max = -np.inf
    running_max_idx = 0
    worst_dd = 0.0
    peak_idx = trough_idx = 0

    for i, price in enumerate(prices):
        if price > running_max:
            running_max = price
            running_max_idx = i
        if excluded[i] or running_max <= 0:
            continue
        dd = (price - running_max) / running_max
        if dd < worst_dd:
            worst_dd = dd
            peak_idx = running_max_idx
            trough_idx = i

    if worst_dd == 0.0:
        # 관측 기간 내내 하락을 겪지 않은 단지 → 현재까지의 최고가를 고점=저점으로 취급(MDD 0%)
        best_i = int(np.argmax(prices))
        peak_idx = trough_idx = best_i

    return peak_idx, trough_idx, worst_dd


def detect_peak_trough(monthly: pd.DataFrame) -> pd.DataFrame:
    """
    단지별 최고점(peak)과 최저점(trough) 탐지 — 전체 수집 기간 기준 MDD.

    특정 연도 구간(예: 2021년)에 국한해 고점을 찾던 예전 방식은, 그 구간에
    거래가 적은 고가·저유동 단지(강남3구 등)의 경우 "고점 이후 데이터가 없다"는
    이유로 통째로 분석에서 빠지는 문제가 있었음. 전체 기간을 대상으로 표준 MDD
    알고리즘(_max_drawdown_indices)을 적용해 실제 겪은 가장 큰 하락 구간을 찾고,
    다운계약 등으로 의심되는 '고립된 저가'는 _is_isolated_dip()로 걸러 저점
    후보에서 제외한다.

    반환: [apt_name, peak_date, peak_price, trough_date, trough_price,
           mdd_pct, district_name, build_year, area_exclusive, downturn_experienced]
    """
    results = []

    # 하락장 경험 판정 기준: 시장은 2021년 말 고점 → 2022 하반기~2023 중반 저점을
    # 겪었다. 데이터로 하락장을 "겪었다"고 보려면, 급락 전(고점기) 관측과 저점기
    # 관측이 모두 있어야 한다. 2024년에야 첫 거래가 잡힌 신축 등은 애초에 하락을
    # 겪을 기회가 없었으므로 MDD 0%가 방어력 근거가 될 수 없다(생존 편향).
    predrop_cutoff = pd.Period("2022-06", freq="M")   # 이 시점 이전 관측이 있어야 '고점기 목격'
    trough_lo = pd.Period(config.TROUGH_START, freq="M")
    trough_hi = pd.Period("2023-12", freq="M")

    # ⚠️ apt_name만으로 묶으면 "현대"·"삼성"처럼 여러 구에 겹치는 단지명이
    # 서로 다른 단지인데도 하나로 합쳐진다. district_name까지 함께 묶어야 한다.
    for (district_name, apt_name), grp in monthly.groupby(["district_name", "apt_name"], observed=True):
        grp = grp.sort_values("deal_date").reset_index(drop=True)
        if grp.empty:
            continue

        prices = grp["smoothed_price"]
        prices_arr = prices.to_numpy()

        # 고립된 이상 저가(다운계약·특수관계 거래 의심) 플래그
        isolated = np.array([_is_isolated_dip(prices, i) for i in range(len(prices))])

        peak_idx, trough_idx, _ = _max_drawdown_indices(prices_arr, isolated)

        peak_row   = grp.loc[peak_idx]
        trough_row = grp.loc[trough_idx]
        peak_price   = peak_row["smoothed_price"]
        trough_price = trough_row["smoothed_price"]
        if peak_price <= 0:
            continue

        mdd_pct = (trough_price - peak_price) / peak_price * 100  # 음수

        dates = grp["deal_date"]
        downturn_experienced = bool(
            (dates.min() <= predrop_cutoff) and
            ((dates >= trough_lo) & (dates <= trough_hi)).any()
        )

        results.append({
            "apt_name":      apt_name,
            "peak_date":     peak_row["deal_date"],
            "peak_price":    round(peak_price),
            "trough_date":   trough_row["deal_date"],
            "trough_price":  round(trough_price),
            "mdd_pct":       round(mdd_pct, 2),
            "district_name": district_name,
            "build_year":    peak_row["build_year"],
            "area_exclusive": round(float(peak_row["area_exclusive"]), 1),  # float32 꼬리자리 제거
            "downturn_experienced": downturn_experienced,
        })

    result_df = pd.DataFrame(results)
    log.info(f"MDD 계산 완료: {len(result_df)}개 단지")
    return result_df


# ── 3. 방어력 상위 단지 추출 ──────────────────────────────────

def extract_top_defenders(mdd_df: pd.DataFrame, top_pct: float = 0.10) -> pd.DataFrame:
    """
    MDD가 작은(하락폭이 적은) 상위 top_pct 단지 추출.
    mdd_pct는 음수이므로 값이 클수록(0에 가까울수록) 방어력이 높음.
    """
    if mdd_df.empty:
        return mdd_df

    threshold = mdd_df["mdd_pct"].quantile(1 - top_pct)
    top = mdd_df[mdd_df["mdd_pct"] >= threshold].copy()
    top = top.sort_values("mdd_pct", ascending=False)
    log.info(f"방어력 상위 {top_pct*100:.0f}%: {len(top)}개 단지 (MDD ≥ {threshold:.1f}%)")
    return top


# ── 4. 공통 특성 도출 ─────────────────────────────────────────

def derive_common_traits(top_df: pd.DataFrame, full_df: pd.DataFrame) -> dict:
    """
    상위 방어 단지와 전체 단지의 특성 비교.
    반환: {특성명: {top: 값, all: 값}} 형태의 dict
    """
    if top_df.empty or full_df.empty:
        return {}

    traits = {}

    # 평균 연식
    traits["평균_준공연도"] = {
        "top": round(top_df["build_year"].mean(), 1),
        "all": round(full_df["build_year"].mean(), 1),
    }

    # 구별 분포
    traits["구별_분포"] = {
        "top": top_df["district_name"].value_counts().to_dict(),
        "all": full_df["district_name"].value_counts().to_dict(),
    }

    # 평균 MDD
    traits["평균_MDD"] = {
        "top": round(top_df["mdd_pct"].mean(), 2),
        "all": round(full_df["mdd_pct"].mean(), 2),
    }

    # 면적 분포
    traits["주력_면적"] = {
        "top": top_df["area_exclusive"].median(),
        "all": full_df["area_exclusive"].median(),
    }

    return traits


# ── 5. 전체 분석 파이프라인 ───────────────────────────────────

def run(df: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame, dict]:
    """
    preprocessor.run() 결과를 받아 분석 완료된 결과 반환.

    반환:
        mdd_df   - 전체 단지 MDD 결과
        top_df   - 방어력 상위 10% 단지
        traits   - 공통 특성 dict
    """
    log.info("분석 시작...")
    monthly = build_monthly_median(df)
    mdd_df  = detect_peak_trough(monthly)

    if mdd_df.empty:
        log.warning("MDD 계산 결과가 없습니다.")
        return mdd_df, pd.DataFrame(), {}

    top_df = extract_top_defenders(mdd_df)
    traits = derive_common_traits(top_df, mdd_df)

    return mdd_df, top_df, traits
