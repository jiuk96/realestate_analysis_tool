"""
점수 백테스트 — "이 점수, 실제로 맞았나?"
─────────────────────────────────────────────────────
가중치·지표가 자의적이라는 비판에 대한 실증 검증:
① 2022-06까지의 데이터만으로(하락장 직전 시점) 종합점수를 다시 계산하고
② 그 점수가 이후 실제 하락(2022-07~2023-12 실현 낙폭)과 회복(최신가)을
   얼마나 잘 예측했는지 상관·분위 분석으로 확인한다.

결과는 data/processed/backtest.json 으로 저장돼 웹의 '점수 근거' 챕터에
"점수 상위 단지가 실제로 덜 떨어졌는가"를 보여주는 데 쓰인다.

주의(정직한 한계):
- 교통 축은 현재 좌표 캐시(정적 입지 특성)를 쓰므로 미래정보 누수가 아니라고
  간주한다. 전세가율 축은 훈련 시점 데이터가 없으므로 제외된다.
- 세대수 추정은 훈련 구간 거래만으로 다시 계산한다.

실행: python backtest_scores.py  (build_data.py 이후, 원본 parquet 필요)
"""

import json
import sys
import warnings
from pathlib import Path

import numpy as np
import pandas as pd

warnings.filterwarnings("ignore")
ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT))

from config import DISTRICTS
from src.preprocessor import run as preprocess_run, _estimate_households
from src.analyzer import build_monthly_median, detect_peak_trough
from src.scorer import compute_composite_score

CODE2NAME = {v: k for k, v in DISTRICTS.items()}
OUT = ROOT / "data" / "processed" / "backtest.json"

TRAIN_END   = pd.Period("2022-06", freq="M")   # 이 시점까지의 정보만으로 점수 산출
CRASH_END   = pd.Period("2023-12", freq="M")   # 실현 낙폭 측정 창의 끝
MIN_TRAIN_MONTHS = 8                            # 훈련 구간 관측이 이보다 적으면 평가 제외


def spearman(a: np.ndarray, b: np.ndarray) -> float:
    ra = pd.Series(a).rank().to_numpy()
    rb = pd.Series(b).rank().to_numpy()
    ra = (ra - ra.mean()) / (ra.std() + 1e-12)
    rb = (rb - rb.mean()) / (rb.std() + 1e-12)
    return float((ra * rb).mean())


def main():
    print("=== 백테스트: 2022-06 시점 점수 vs 이후 실제 성과 ===")
    raw_dir = ROOT / "data" / "raw"
    dfs = [pd.read_parquet(f) for f in sorted(raw_dir.glob("*.parquet"))]
    df_raw = pd.concat(dfs, ignore_index=True)
    df_raw["district_name"] = df_raw["district_code"].astype(str).map(CODE2NAME)

    df = preprocess_run(df_raw)
    monthly_full = build_monthly_median(df)

    # ── 훈련: TRAIN_END까지만 아는 상태로 점수 계산 ──────────
    monthly_train = monthly_full[monthly_full["deal_date"] <= TRAIN_END].copy()
    df_train = df[df["deal_date"] <= TRAIN_END]
    mdd_train = detect_peak_trough(monthly_train)
    hh_train = _estimate_households(df_train)
    scores = compute_composite_score(mdd_train, monthly_train, hh_train)
    print(f"  훈련 시점 점수 산출: {len(scores)}개 단지")

    # ── 실현 성과: 훈련 이후 실제로 얼마나 떨어졌고, 회복했나 ──
    rows = []
    full_by_key = dict(tuple(monthly_full.groupby(["district_name", "apt_name"], observed=True)))
    for _, s in scores.iterrows():
        key = (s["district_name"], s["apt_name"])
        g = full_by_key.get(key)
        if g is None:
            continue
        g = g.sort_values("deal_date")
        train_g = g[g["deal_date"] <= TRAIN_END]
        crash_g = g[(g["deal_date"] > TRAIN_END) & (g["deal_date"] <= CRASH_END)]
        after_g = g[g["deal_date"] > TRAIN_END]
        if len(train_g) < MIN_TRAIN_MONTHS or crash_g.empty:
            continue
        base = float(train_g["smoothed_price"].iloc[-1])
        if base <= 0:
            continue
        realized_dd = (float(crash_g["smoothed_price"].min()) / base - 1) * 100     # 하락창 실현 낙폭(%)
        total_ret   = (float(after_g["smoothed_price"].iloc[-1]) / base - 1) * 100  # 최신가까지 총수익률(%)
        rows.append({
            "district": s["district_name"], "apt_name": s["apt_name"],
            "score": float(s["composite_score"]),
            "defense": float(s["defense_score"]) if pd.notna(s["defense_score"]) else np.nan,
            "momentum": float(s["momentum_score"]) if pd.notna(s.get("momentum_score")) else np.nan,
            "upside": float(s["upside_score"]) if pd.notna(s.get("upside_score")) else np.nan,
            "liquidity": float(s["liquidity_score"]) if pd.notna(s.get("liquidity_score")) else np.nan,
            "realized_dd": realized_dd, "total_ret": total_ret,
        })

    bt = pd.DataFrame(rows)
    print(f"  평가 가능 단지: {len(bt)}개 (훈련 {MIN_TRAIN_MONTHS}개월+ & 하락창 관측 보유)")
    if len(bt) < 30:
        print("  표본이 너무 적어 백테스트 결과를 저장하지 않습니다.")
        return

    corr_dd  = spearman(bt["score"].to_numpy(), bt["realized_dd"].to_numpy())
    corr_ret = spearman(bt["score"].to_numpy(), bt["total_ret"].to_numpy())

    # 축별로 "하락 예측력"을 분해 — 어떤 축이 실제로 방어를 예측했는지 확인
    axis_corr = {}
    for ax in ("defense", "momentum", "upside", "liquidity"):
        sub = bt.dropna(subset=[ax])
        if len(sub) >= 30:
            axis_corr[ax] = {
                "vs_dd": round(spearman(sub[ax].to_numpy(), sub["realized_dd"].to_numpy()), 3),
                "vs_ret": round(spearman(sub[ax].to_numpy(), sub["total_ret"].to_numpy()), 3),
            }

    # 점수 5분위별 평균 실현 낙폭/수익률 (Q5=점수 상위 20%)
    bt["q"] = pd.qcut(bt["score"], 5, labels=[1, 2, 3, 4, 5])
    quintiles = []
    for q in [5, 4, 3, 2, 1]:
        sub = bt[bt["q"] == q]
        quintiles.append({
            "quintile": int(q),
            "label": {5: "상위 20%", 4: "상위 20~40%", 3: "중위", 2: "하위 20~40%", 1: "하위 20%"}[q],
            "n": int(len(sub)),
            "avg_realized_dd": round(float(sub["realized_dd"].mean()), 2),
            "avg_total_ret": round(float(sub["total_ret"].mean()), 2),
        })

    top = quintiles[0]; bot = quintiles[-1]
    result = {
        "train_cutoff": str(TRAIN_END), "crash_window_end": str(CRASH_END),
        "n_apts": int(len(bt)),
        "spearman_score_vs_dd": round(corr_dd, 3),
        "spearman_score_vs_ret": round(corr_ret, 3),
        "axis_corr": axis_corr,
        "quintiles": quintiles,
        "headline": {
            "top20_dd": top["avg_realized_dd"], "bottom20_dd": bot["avg_realized_dd"],
            "top20_ret": top["avg_total_ret"], "bottom20_ret": bot["avg_total_ret"],
        },
    }
    OUT.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n  Spearman(점수↔실현낙폭): {corr_dd:+.3f}  (양수=점수 높을수록 덜 떨어짐)")
    print(f"  Spearman(점수↔총수익률): {corr_ret:+.3f}")
    for ax, c in axis_corr.items():
        print(f"    축 {ax:<10} vs낙폭 {c['vs_dd']:+.3f}  vs총수익 {c['vs_ret']:+.3f}")
    for q in quintiles:
        print(f"    {q['label']:<10} n={q['n']:>3}  실현낙폭 {q['avg_realized_dd']:+6.2f}%  총수익 {q['avg_total_ret']:+6.2f}%")
    print(f"  저장 → {OUT}")


if __name__ == "__main__":
    main()
