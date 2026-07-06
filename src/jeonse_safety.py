"""
전세 안전성 지표 산출 (Additive-Only 모듈)
─────────────────────────────────────────────────────
기존 점수 체계와 완전히 분리된 '전세 안전성' 참고 지표를 산출한다.
기존 파이프라인(build_data 등)은 수정하지 않으며, 산출물도 별도 파일이다.

산출 지표 (점수 합산 없음, 표시 전용):
  B. 역전세 경고 플래그 — 최근 24개월 '신규' 전세 계약 중 계약 시점
     전세가율(보증금 ÷ 그 달 매매 스무딩가) 90% 이상 건수/비중.
     근거: 국토연구원(2023) 직전 계약 전세가율 90%+ → 만기 역전세 이행
     확률 급증(100%+는 51.1%).
  C. HUG 126% 참고 — data/static/official_price.json(공시가, collect_official_price.py)
     이 있을 때만: 전세 중앙값 ÷ (공시가 중앙값 × 1.26) > 1.0 이면 보증보험
     가입 거절 가능성 경고. 공시가 없으면 필드 자체를 생략(숨김).

입력: data/rent/*.parquet, data/processed/timeseries.json(매매 스무딩가),
      data/processed/jeonse.json(전세 중앙값), [선택] official_price.json
출력: data/processed/jeonse_safety.json
실행: python src/jeonse_safety.py   (build_data 이후, CI 독립 스텝)
"""

import glob
import json
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT))
import config

RENT_DIR = ROOT / "data" / "rent"
TS_PATH = ROOT / "data" / "processed" / "timeseries.json"
JEONSE_PATH = ROOT / "data" / "processed" / "jeonse.json"
GONGSI_PATH = ROOT / "data" / "static" / "official_price.json"
OUT = ROOT / "data" / "processed" / "jeonse_safety.json"

LOOKBACK_MONTHS = 24      # 역전세 플래그 관찰 창
HIGH_RATIO = 0.90         # 경고 기준: 계약 시점 전세가율 90%
HUG_MULT = 1.26           # HUG 전세보증 가입 상한 = 공시가 × 126%

CODE2NAME = {v: k for k, v in config.DISTRICTS.items()}


def _load_sale_smoothed() -> dict:
    """(구, 단지, 'YYYYMM') → 매매 스무딩가(만원). 기존 산출물 재사용(무수정)."""
    ts = json.loads(TS_PATH.read_text(encoding="utf-8"))
    out = {}
    for a in ts.get("apartments", []):
        for m in a.get("monthly", []):
            ym = str(m["ym"]).replace("-", "")
            out[(a["district"], a["apt_name"], ym)] = m.get("median")
    return out


def build() -> dict:
    jeonse = json.loads(JEONSE_PATH.read_text(encoding="utf-8"))
    targets = {(r["district"], r["apt_name"]): r for r in jeonse.get("ranking", [])}
    if not targets:
        raise SystemExit("jeonse.json이 비어 있습니다 — build_data를 먼저 실행하세요.")
    sale = _load_sale_smoothed()

    # ── 전세 신규계약 로드 (기존 build_data와 동일 정제 기준을 '독립적으로' 적용) ──
    files = sorted(glob.glob(str(RENT_DIR / "*.parquet")))
    rent = pd.concat([pd.read_parquet(f) for f in files], ignore_index=True)
    rent["district_name"] = rent["district_code"].astype(str).map(CODE2NAME)
    rent = rent[(pd.to_numeric(rent.get("monthly_rent"), errors="coerce").fillna(0) == 0)
                & (rent["area_exclusive"] >= config.TARGET_AREA_MIN)
                & (rent["area_exclusive"] <= config.TARGET_AREA_MAX)]
    if "contractType" in rent.columns:
        rent = rent[rent["contractType"].fillna("") != "갱신"]
    rent["deposit"] = pd.to_numeric(rent["deposit"], errors="coerce")
    rent = rent[rent["deposit"] >= 3000]
    rent["ym"] = rent["deal_year"].astype(str) + rent["deal_month"].astype(str).str.zfill(2)
    recent = sorted(rent["ym"].unique())[-LOOKBACK_MONTHS:]
    rent = rent[rent["ym"].isin(set(recent))]

    # ── B. 계약별 전세가율 → 90%+ 집계 ─────────────────────────
    gongsi = {}
    if GONGSI_PATH.exists():
        try:
            g = json.loads(GONGSI_PATH.read_text(encoding="utf-8"))
            gongsi = {(r["district"], r["apt_name"]): r["gongsi_median"]
                      for r in g.get("apartments", []) if r.get("gongsi_median")}
        except (json.JSONDecodeError, KeyError):
            gongsi = {}

    apartments = {}
    grp = rent.groupby(["district_name", "apt_name"], observed=True)
    for (d, a), g in grp:
        if (d, a) not in targets:
            continue
        total = high = 0
        last_high_ym = None
        for ym, dep in zip(g["ym"], g["deposit"]):
            s = sale.get((d, a, ym))
            if not s or s <= 0:
                continue
            total += 1
            if dep / s >= HIGH_RATIO:
                high += 1
                last_high_ym = max(last_high_ym or ym, ym)
        if total == 0:
            continue   # 매매 시세 매칭 실패 → 지표 숨김(스펙: 에러·0점 처리 금지)
        entry = {
            "high_cnt": high,
            "total_cnt": total,
            "high_share": round(high / total * 100, 1),
            "last_high_ym": last_high_ym,
            "flag": high > 0,
        }
        # ── C. HUG 126% (공시가 있을 때만 필드 생성) ──────────
        gp = gongsi.get((d, a))
        jm = targets[(d, a)].get("jeonse_median")
        if gp and jm:
            entry["gongsi_median"] = gp
            entry["hug_ratio"] = round(jm / (gp * HUG_MULT), 2)
        apartments[f"{d}|{a}"] = entry

    n_flag = sum(1 for v in apartments.values() if v["flag"])
    n_hug = sum(1 for v in apartments.values() if "hug_ratio" in v)
    result = {
        "lookback_months": LOOKBACK_MONTHS,
        "high_ratio_cut": HIGH_RATIO,
        "hug_mult": HUG_MULT,
        "n_apts": len(apartments),
        "n_flagged": n_flag,
        "n_hug": n_hug,
        "apartments": apartments,
    }
    OUT.write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"전세 안전성 저장 → {OUT}")
    print(f"  대상 {len(apartments)}개 단지 · 역전세 플래그 {n_flag}개 · HUG 산출 {n_hug}개"
          f"{' (공시가 데이터 없음 — HUG 지표는 수집 후 활성화)' if n_hug == 0 else ''}")
    return result


if __name__ == "__main__":
    build()
