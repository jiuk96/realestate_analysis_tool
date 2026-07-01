"""
실제 API 응답과 동일한 구조의 샘플 DataFrame 생성기.
API 없이 전체 파이프라인을 테스트하는 데 사용.
"""

import numpy as np
import pandas as pd


def make_sample_df(seed: int = 42) -> pd.DataFrame:
    """
    마용성 3개 단지 × 2020~2023 가상 거래 데이터 생성.
    - 래미안마포리버웰: 600세대, 정상 단지
    - 아크로서울포레스트: 800세대, 정상 단지
    - 소규모빌라(300세대 추정): 필터 아웃 대상
    """
    rng = np.random.default_rng(seed)
    rows = []

    apartments = [
        # (이름, 기준가_만원, 연간거래건수, 구, 동)
        ("래미안마포리버웰",    90000, 120, "마포구", "상암동"),    # 연 120건 → 추정 세대수 ~200(6년치)→600
        ("아크로서울포레스트", 200000, 160, "성동구", "성수동1가"), # 연 160건 → 추정 세대수 ~800
        ("소규모빌라",          40000,  10, "용산구", "이촌동"),   # 세대수 미달 → 필터 아웃
    ]

    years  = list(range(2020, 2024))
    months = list(range(1, 13))

    for apt_name, base_price, yearly_trades, district, dong in apartments:
        monthly_trades = max(1, yearly_trades // 12)
        for year in years:
            # 2021 하반기 고점, 2022~2023 하락 반영
            cycle_factor = {
                2020: 0.85, 2021: 1.00, 2022: 0.90, 2023: 0.80
            }[year]
            for month in months:
                n = rng.integers(max(1, monthly_trades - 2), monthly_trades + 3)
                for _ in range(n):
                    price = base_price * cycle_factor * rng.uniform(0.95, 1.05)
                    floor = int(rng.integers(1, 30))
                    rows.append({
                        "apt_name":       apt_name,
                        "deal_amount":    round(price),
                        "deal_year":      year,
                        "deal_month":     month,
                        "deal_day":       int(rng.integers(1, 28)),
                        "deal_ym":        f"{year}{month:02d}",
                        "floor":          floor,
                        "area_exclusive": float(rng.choice([59.0, 84.0, 114.0])),
                        "build_year":     2015,
                        "umd_name":       dong,
                        "district_name":  district,
                        "deal_type":      "중개거래",
                    })

    df = pd.DataFrame(rows)

    # 이상치 주입: 래미안마포리버웰 5건에 직거래 의심 저가
    outlier_idx = df[df["apt_name"] == "래미안마포리버웰"].sample(5, random_state=seed).index
    df.loc[outlier_idx, "deal_amount"] = 10000   # 극단 저가

    # 1층 거래 10건 주입
    floor1_idx = df[df["floor"] > 1].sample(10, random_state=seed).index
    df.loc[floor1_idx, "floor"] = 1

    # 카테고리 변환 (collector 와 동일)
    for col in ["apt_name", "umd_name", "district_name", "deal_type"]:
        df[col] = df[col].astype("category")
    df["area_exclusive"] = df["area_exclusive"].astype("float32")
    for col in ["deal_year", "deal_month", "deal_day", "floor", "build_year"]:
        df[col] = df[col].astype("int16")

    return df
