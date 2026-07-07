"""
빌라(연립·다세대) 동네 단위 매수 분석 → data/processed/villa.json
─────────────────────────────────────────────────────
빌라는 한 건물 세대수가 적어 아파트식 '단지별' 점수가 불가능하다(표본 1~3건짜리
유령 점수가 됨). 대신 법정동(동네) 단위로 묶어 표본을 확보하고, 빌라 매수에서
실제로 판단 가능한 지표만 세분화한다:

  ① 가격 접근성  — 최근 12개월 ㎡당 매매가 중앙값 (싼 동네일수록 ↑)
  ② 유동성       — 최근 12개월 거래량 + 전년 대비 증감 (되팔기 쉬운가)
  ③ 가격 흐름    — 36개월 ㎡당가 Theil-Sen 추세 (연 % — 하락 동네 경고)
  ④ 아파트 갭    — 같은 구 아파트 ㎡당가 대비 빌라 ㎡당가 비율
                   (갭이 클수록 할인 폭·재개발 기대 여지 ↑)
  ⑤ 깡통 안전    — 빌라 전세가율(전세 ㎡당가 ÷ 매매 ㎡당가, 최근 12개월)
                   80% 이상이면 역전세·전세사기 위험 동네로 경고
  보조 배지      — 신축(5년 이내) 거래 비중: 높으면 '신축 고평가 주의'
                   (신축 빌라 감정가 부풀리기가 전세사기의 전형 패턴)

종합점수 = 접근성 .25 + 유동성 .20 + 아파트갭 .20 + 흐름 .15 + 깡통안전 .20
(결측 축은 가중치 재정규화 — 아파트 종합점수와 동일한 방식)

주의: 동네 단위 통계다. 같은 동 안에서도 개별 빌라의 상태(위반건축물·주차·
근저당)는 데이터에 없으므로, 후보 동네를 고르는 용도까지만 쓰고 개별 매물은
등기부·건축물대장 확인이 필수다 — 이 한계를 JSON에 명시해 UI에 노출한다.
"""

import json
import os
import sys
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "src"))
import config
from src.scorer import _theil_sen_slope

TRADE_DIR = Path(os.environ.get("VILLA_TRADE_DIR", ROOT / "data" / "villa_trade"))
RENT_DIR = Path(os.environ.get("VILLA_RENT_DIR", ROOT / "data" / "villa_rent"))
OUT_PATH = Path(os.environ.get("VILLA_OUT", ROOT / "data" / "processed" / "villa.json"))

MIN_TRADES_TOTAL = 30    # 동네 채택 최소 전체 표본
MIN_TRADES_12M = 8       # 최근 12개월 최소 표본 (시세 대표성)
TREND_MONTHS = 36
JR_DANGER = 0.80         # 전세가율 경고선

WEIGHTS = {"afford": 0.25, "liquidity": 0.20, "gap": 0.20, "trend": 0.15, "safety": 0.20}

CODE2NAME = {v: k for k, v in config.DISTRICTS.items()}


def _load_dir(d: Path) -> pd.DataFrame:
    files = sorted(d.glob("*.parquet"))
    if not files:
        return pd.DataFrame()
    dfs = [pd.read_parquet(f) for f in files]
    dfs = [x for x in dfs if len(x)]
    return pd.concat(dfs, ignore_index=True) if dfs else pd.DataFrame()


def _clean_trades(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    # 해제 신고된 계약 제외 (cancel_type 'O' 등 비어있지 않으면 해제)
    if "cancel_type" in df.columns:
        c = df["cancel_type"].astype(str).str.strip()
        df = df[(c == "") | (c == "nan") | (c == "None")]
    df = df.dropna(subset=["amount", "area_exclusive", "umd_name"])
    df = df[(df["area_exclusive"] >= 20) & (df["area_exclusive"] <= 150)]
    df = df[df["amount"] >= 3000]                    # 3천만원 미만 특수거래 제외
    df["ppm2"] = df["amount"] / df["area_exclusive"]  # 만원/㎡
    # ㎡당가 극단치(지분거래·입력오류) 제거: 서울 빌라 상식 범위
    df = df[(df["ppm2"] >= 100) & (df["ppm2"] <= 5000)]
    df["district"] = df["district_code"].astype(str).map(CODE2NAME)
    df["ym"] = df["deal_ym"].astype(str)
    return df.dropna(subset=["district"])


def _clean_rent(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    need = {"deposit", "area_exclusive", "umd_name"}
    if not need.issubset(df.columns):
        return pd.DataFrame()
    # 순수 전세 + 갱신 제외(5% 상한 왜곡 — 아파트 전세 정제와 동일 원칙)
    if "monthly_rent" in df.columns:
        df = df[df["monthly_rent"].fillna(0) == 0]
    if "contract_type" in df.columns:
        df = df[df["contract_type"].astype(str) != "갱신"]
    df = df.dropna(subset=["deposit", "area_exclusive", "umd_name"])
    df = df[(df["area_exclusive"] >= 20) & (df["area_exclusive"] <= 150)]
    df = df[df["deposit"] >= 3000]
    df["jppm2"] = df["deposit"] / df["area_exclusive"]
    df["district"] = df["district_code"].astype(str).map(CODE2NAME)
    df["ym"] = df["deal_ym"].astype(str)
    return df.dropna(subset=["district"])


def _apt_ppm2_by_district() -> dict:
    """아파트 ㎡당가(구별 중앙값) — 기존 산출물(composite+timeseries)에서 도출."""
    try:
        comp = json.loads((ROOT / "data" / "processed" / "composite_score.json").read_text(encoding="utf-8"))
        ts = json.loads((ROOT / "data" / "processed" / "timeseries.json").read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    latest = {}
    for a in ts.get("apartments", []):
        m = a.get("monthly") or []
        if m:
            latest[(a["district"], a["apt_name"])] = m[-1].get("median")
    vals: dict = {}
    for r in comp.get("ranking", []):
        area = r.get("area_exclusive")
        price = latest.get((r["district"], r["apt_name"]))
        if area and price:
            vals.setdefault(r["district"], []).append(price / area)
    return {d: float(np.median(v)) for d, v in vals.items() if v}


DONG_LOC_PATH = ROOT / "data" / "static" / "dong_locations.json"


def _dong_locations(keys: list) -> dict:
    """동 중심 좌표: ① 캐시 → ② 분석 아파트 좌표의 동별 평균 → ③ Kakao 주소검색.
    Kakao는 KAKAO_REST_KEY가 있을 때만(CI) 시도하고 결과는 캐시에 누적한다."""
    cache = {}
    if DONG_LOC_PATH.exists():
        cache = json.loads(DONG_LOC_PATH.read_text(encoding="utf-8"))

    # 아파트 좌표 fallback (동별 평균)
    apt_path = ROOT / "data" / "static" / "apt_locations.json"
    if apt_path.exists():
        acc: dict = {}
        for k, v in json.loads(apt_path.read_text(encoding="utf-8")).items():
            if v.get("dong") and v.get("lat"):
                acc.setdefault(f"{k.split('|')[0]}|{v['dong']}", []).append((v["lat"], v["lng"]))
        for k, pts in acc.items():
            cache.setdefault(k, {
                "lat": round(sum(p[0] for p in pts) / len(pts), 6),
                "lng": round(sum(p[1] for p in pts) / len(pts), 6),
                "source": "apt_avg",
            })

    kakao = os.environ.get("KAKAO_REST_KEY", "").strip()
    missing = [k for k in keys if k not in cache]
    if missing:
        import time
        import requests
        n_ok = 0
        session = requests.Session()
        for k in missing:
            gu, dong = k.split("|", 1)
            try:
                if kakao:
                    r = session.get(
                        "https://dapi.kakao.com/v2/local/search/address.json",
                        params={"query": f"서울특별시 {gu} {dong}"},
                        headers={"Authorization": f"KakaoAK {kakao}"}, timeout=10)
                    docs = r.json().get("documents", [])
                    if docs:
                        cache[k] = {"lat": round(float(docs[0]["y"]), 6),
                                    "lng": round(float(docs[0]["x"]), 6), "source": "kakao"}
                        n_ok += 1
                        continue
                # Kakao 키가 없거나 실패 시: Nominatim(OSM) — 아파트 지오코딩과 동일 경로.
                # 정책상 1 req/s 준수. 법정동명은 대부분 해석된다.
                r = session.get("https://nominatim.openstreetmap.org/search",
                                params={"q": f"{dong}, {gu}, 서울", "format": "json",
                                        "limit": 1, "countrycodes": "kr"},
                                headers={"User-Agent": "seoul-apt-tool/1.0"}, timeout=15)
                time.sleep(1.1)
                docs = r.json() if r.status_code == 200 else []
                if docs:
                    cache[k] = {"lat": round(float(docs[0]["lat"]), 6),
                                "lng": round(float(docs[0]["lon"]), 6), "source": "osm"}
                    n_ok += 1
            except Exception:
                pass
        print(f"동 좌표 지오코딩: 신규 {n_ok}/{len(missing)}")

    DONG_LOC_PATH.parent.mkdir(parents=True, exist_ok=True)
    DONG_LOC_PATH.write_text(json.dumps(cache, ensure_ascii=False, indent=1), encoding="utf-8")
    return cache


def _pct_rank(s: pd.Series, invert: bool = False) -> pd.Series:
    r = s.rank(pct=True) * 100
    return (100 - r) if invert else r


def main() -> int:
    trades = _load_dir(TRADE_DIR)
    if trades.empty:
        print("빌라 매매 데이터 없음 — collect_villa.py 실행 후 다시 시도하세요.")
        return 0
    trades = _clean_trades(trades)
    rent = _clean_rent(_load_dir(RENT_DIR)) if RENT_DIR.exists() else pd.DataFrame()

    yms = sorted(trades["ym"].unique())
    last12 = set(yms[-12:])
    prev12 = set(yms[-24:-12])
    trend_yms = yms[-TREND_MONTHS:]
    this_year = date.today().year

    apt_ppm2 = _apt_ppm2_by_district()

    rows = []
    for (dist, dong), g in trades.groupby(["district", "umd_name"], observed=True):
        if len(g) < MIN_TRADES_TOTAL:
            continue
        g12 = g[g["ym"].isin(last12)]
        if len(g12) < MIN_TRADES_12M:
            continue

        ppm2 = float(g12["ppm2"].median())
        med_amt = float(g12["amount"].median())
        med_area = float(g12["area_exclusive"].median())

        # 36개월 월별 중앙값 추세 (연 %)
        gt = g[g["ym"].isin(trend_yms)]
        monthly = gt.groupby("ym")["ppm2"].median()
        trend_pct = None
        if len(monthly) >= 18:   # 월별 중앙값 18개 미만이면 구성효과 왜곡이 커 추세 미산출
            x = np.arange(len(monthly), dtype=float)
            slope = _theil_sen_slope(x, monthly.values)          # 만원/㎡ per month
            base = float(np.median(monthly.values))
            if base > 0:
                trend_pct = float(slope * 12 / base * 100)

        # 유동성: 최근 12개월 건수 + 전년 대비
        n12 = int(len(g12))
        n_prev = int(len(g[g["ym"].isin(prev12)]))
        liq_chg = float((n12 - n_prev) / n_prev * 100) if n_prev >= 5 else None

        # 신축 비중·연식
        by = pd.to_numeric(g12["build_year"], errors="coerce") if "build_year" in g12.columns else pd.Series(dtype=float)
        new_share = float((by >= this_year - 5).mean()) if by.notna().sum() >= 5 else None
        med_age = float(this_year - by.median()) if by.notna().sum() >= 5 else None

        # 전세가율 (동네 ㎡당가 기준)
        jr = None
        if not rent.empty:
            r12 = rent[(rent["district"] == dist) & (rent["umd_name"].astype(str) == str(dong))
                       & (rent["ym"].isin(last12))]
            if len(r12) >= MIN_TRADES_12M:
                jr = float(r12["jppm2"].median() / ppm2)

        gap = float(ppm2 / apt_ppm2[dist]) if dist in apt_ppm2 else None

        recent = g12.sort_values(["ym", "deal_day"] if "deal_day" in g12.columns else "ym",
                                 ascending=False).head(5)
        sample = [{
            "ym": t.ym, "name": str(getattr(t, "bldg_name", "") or ""),
            "area": round(float(t.area_exclusive), 1), "floor": int(t.floor) if pd.notna(getattr(t, "floor", None)) else None,
            "amount": round(float(t.amount) / 10000, 2),   # 억
            "build_year": int(t.build_year) if pd.notna(getattr(t, "build_year", None)) else None,
        } for t in recent.itertuples()]

        rows.append({
            "district": dist, "dong": str(dong),
            "ppm2": round(ppm2, 1), "py_price": round(ppm2 * 3.3058 / 10000, 2),  # 억/평
            "median_amount_eok": round(med_amt / 10000, 2), "median_area": round(med_area, 1),
            "n_trades_12m": n12, "liq_chg_pct": None if liq_chg is None else round(liq_chg, 1),
            "trend_pct_yr": None if trend_pct is None else round(trend_pct, 2),
            "apt_gap": None if gap is None else round(gap, 3),
            "jeonse_ratio": None if jr is None else round(jr, 3),
            "jeonse_danger": bool(jr is not None and jr >= JR_DANGER),
            "new_share": None if new_share is None else round(new_share, 3),
            "median_age": None if med_age is None else round(med_age, 1),
            "recent_trades": sample,
        })

    if not rows:
        print("표본 기준을 넘는 동네가 없습니다 — 수집이 더 진행된 뒤 다시 실행하세요.")
        return 0

    df = pd.DataFrame(rows)
    axes = {
        "afford": _pct_rank(df["ppm2"], invert=True),
        "liquidity": _pct_rank(df["n_trades_12m"]),
        "gap": _pct_rank(df["apt_gap"], invert=True),
        "trend": _pct_rank(df["trend_pct_yr"]),
        "safety": _pct_rank(df["jeonse_ratio"], invert=True),
    }
    for k, v in axes.items():
        df["ax_" + k] = v.round(1)

    # 결측 축 가중치 재정규화 종합점수
    def _total(row):
        num = den = 0.0
        for k, w in WEIGHTS.items():
            v = row["ax_" + k]
            if pd.notna(v):
                num += w * v
                den += w
        return round(num / den, 1) if den else None
    df["total"] = df.apply(_total, axis=1)
    df = df.sort_values("total", ascending=False).reset_index(drop=True)
    df["rank"] = df.index + 1

    # 지도용 동 중심 좌표
    locs = _dong_locations([f"{r.district}|{r.dong}" for r in df.itertuples()])
    df["lat"] = [locs.get(f"{r.district}|{r.dong}", {}).get("lat") for r in df.itertuples()]
    df["lng"] = [locs.get(f"{r.district}|{r.dong}", {}).get("lng") for r in df.itertuples()]

    out = {
        "updated": date.today().isoformat(),
        "period_12m": f"{yms[-12] if len(yms) >= 12 else yms[0]}~{yms[-1]}",
        "n_dongs": int(len(df)),
        "n_trades_used": int(len(trades)),
        "weights": WEIGHTS,
        "jr_danger": JR_DANGER,
        "caveat": "동네(법정동) 단위 통계입니다. 같은 동 안에서도 개별 빌라의 위반건축물·주차·근저당·채광은 "
                  "데이터에 없으므로, 후보 동네 선정까지만 참고하고 개별 매물은 등기부등본·건축물대장 확인이 필수입니다.",
        # ⚠️ df.where(notna, None)는 float 컬럼에서 None이 도로 NaN으로 강제된다 —
        # NaN이 JSON에 그대로 실리면 브라우저 JSON.parse가 깨지므로 to_json 경유(NaN→null)로 변환.
        "dongs": json.loads(df.to_json(orient="records", force_ascii=False)),
    }
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    print(f"✅ 빌라 동네 분석 {len(df)}개 동 저장 → {OUT_PATH} "
          f"(사용 거래 {len(trades):,}건, 전세 표본 {0 if rent.empty else len(rent):,}건)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
