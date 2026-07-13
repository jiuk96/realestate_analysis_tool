"""
정비구역(공덕8구역 등) 단위 3박자 분석 → data/processed/villa_zones.json
─────────────────────────────────────────────────────
'쉬운 상식' 탭의 재건축·재개발 3박자를 점수의 근간으로 한다:

  🅰 좋은 자리 (40%)  — 그 동네 분석 아파트들의 교통·업무지구·학군 점수 평균
                        + 같은 구 아파트 ㎡당가(완공 후 가치 프록시) 백분위
  🅱 사업성   (35%)  — 종전 평형 중앙값(클수록 ↑, ②-5 초소형 함정 회피)
                        + 아파트 갭(빌라가 쌀수록 감정가 대비 완공가치 여유 ↑)
  🅲 맞는 이해관계 (25%) — 그 동네 빌라 거래 면적의 변동계수(낮을수록 평형 구성이
                        비슷 = 조합원 이해가 갈리지 않음)

⚠️ 정직한 한계 (JSON caveat에 그대로 노출):
  - 구역 경계 폴리곤이 아니라 구역의 법정동 실거래 통계로 근사한다.
  - 용도지역·현재 용적률(사업성의 반쪽)은 아직 데이터가 없어 미반영 —
    구역별 용적률 데이터가 확보되면 🅱에 추가한다.
  - 진행단계는 점수가 아니라 위치(타임라인)로 표시한다: 단계가 깊을수록
    리스크↓ 가격↑ 이므로 점수에 섞으면 '싸고 이른 구역'이 부당하게 밀린다.

입력: zones_raw.json(collect_zones.py), villa.json(동 통계), composite_score.json,
      apt_locations.json(단지→동), district_info(구 좌표 fallback)
"""

import json
import os
import re
import sys
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).parent.parent
P = ROOT / "data" / "processed"
OUT = Path(os.environ.get("ZONE_OUT", P / "villa_zones.json"))

WEIGHTS = {"place": 0.40, "biz": 0.35, "align": 0.25}

# 진행단계 → ② 절차 타임라인 위치 (learn 페이지 단계와 동일한 언어)
STAGE_STEPS = [
    ("구역지정", ("기본계획", "정비구역", "구역지정", "안전진단", "예정", "수립", "후보지", "지정")),
    ("추진위", ("추진위",)),
    ("조합설립", ("조합설립", "조합 설립")),
    ("사업시행", ("사업시행", "시행인가", "시공", "건축심의")),
    ("관리처분", ("관리처분", "분양신청")),
    ("이주·착공", ("이주", "철거", "착공", "공사")),
    ("준공", ("준공", "완료", "입주", "청산")),
]


def stage_index(stage: str) -> int:
    s = (stage or "").replace(" ", "")
    for i, (_, kws) in reversed(list(enumerate(STAGE_STEPS))):
        if any(k.replace(" ", "") in s for k in kws):
            return i
    return -1   # 미상


_DONG = re.compile(r"([가-힣]+\d*(?:동|가))")


def guess_dong(name: str, addr: str) -> str | None:
    """구역명/주소에서 법정동 추출: '공덕8구역'→없음, '아현동 699'→아현동, '상계5동'→상계동"""
    for src in (addr or "", name or ""):
        m = _DONG.search(src)
        if m:
            d = m.group(1)
            d = re.sub(r"제?\d+동$", "동", d)   # 상계5동 → 상계동(행정동 번호 제거)
            return d
    # '공덕8' 같은 접두어 → 동명 추정 (공덕→공덕동)
    m = re.match(r"([가-힣]{2,4})\d", name or "")
    if m:
        return m.group(1) + "동"
    return None


def _pct(s: pd.Series, invert=False) -> pd.Series:
    r = s.rank(pct=True) * 100
    return (100 - r) if invert else r


def main() -> int:
    try:
        zr = json.loads((P / "zones_raw.json").read_text(encoding="utf-8"))
    except FileNotFoundError:
        print("zones_raw.json 없음 — collect_zones.py 먼저 실행 (CI).")
        return 0
    zones = zr.get("zones", [])
    if not zones:
        print("구역 목록이 비어 있음.")
        return 0

    # 사업개요 상세 (collect_zones가 카페별로 캐시)
    details = {}
    dpath = P / "zone_details.json"
    if dpath.exists():
        details = json.loads(dpath.read_text(encoding="utf-8"))

    # 용도지역 → 서울 조례 기본 용적률 한도 (표시용 참고치)
    FAR_LIMIT = {"제1종전용": 100, "제2종전용": 120, "제1종일반": 150,
                 "제2종일반": 200, "제3종일반": 250, "준주거": 400, "준공업": 400,
                 "중심상업": 1000, "일반상업": 800, "근린상업": 600, "유통상업": 600}

    def far_limit_of(use_zone):
        if not use_zone:
            return None
        for k, v in FAR_LIMIT.items():
            if k in use_zone.replace(" ", ""):
                return v
        return None

    villa = json.loads((P / "villa.json").read_text(encoding="utf-8"))
    dongs = {(d["district"], d["dong"]): d for d in villa.get("dongs", [])}

    comp = json.loads((P / "composite_score.json").read_text(encoding="utf-8"))["ranking"]
    locs = json.loads((ROOT / "data" / "static" / "apt_locations.json").read_text(encoding="utf-8"))
    dong_of = {(v.get("district"), v.get("apt_name")): v.get("dong") for v in locs.values()}

    # 동/구별 아파트 인프라 점수 평균 (자리 축)
    infra_rows = []
    for r in comp:
        infra_rows.append({
            "gu": r["district"],
            "dong": dong_of.get((r["district"], r["apt_name"])),
            "transit": r.get("transit_score"), "hub": r.get("hub_score"), "school": r.get("school_score"),
            "hub_km": r.get("hub_min_km"), "hub_name": r.get("hub_nearest_name"),
        })
    idf = pd.DataFrame(infra_rows)
    num_cols = ["transit", "hub", "school", "hub_km"]
    infra_dong = idf.dropna(subset=["dong"]).groupby(["gu", "dong"])[num_cols].mean()
    infra_gu = idf.groupby("gu")[num_cols].mean()
    infra_dong_n = idf.dropna(subset=["dong"]).groupby(["gu", "dong"]).size()
    hub_name_dong = idf.dropna(subset=["dong", "hub_name"]).groupby(["gu", "dong"])["hub_name"] \
        .agg(lambda x: x.mode().iloc[0] if len(x.mode()) else None)
    hub_name_gu = idf.dropna(subset=["hub_name"]).groupby("gu")["hub_name"] \
        .agg(lambda x: x.mode().iloc[0] if len(x.mode()) else None)

    # 구별 아파트 ㎡당가 (완공 후 가치 프록시) — villa.json의 apt_gap 산출과 동일 소스 재사용
    ts = json.loads((P / "timeseries.json").read_text(encoding="utf-8"))
    latest = {}
    for a in ts.get("apartments", []):
        m = a.get("monthly") or []
        if m:
            latest[(a["district"], a["apt_name"])] = m[-1].get("median")
    gu_ppm2 = {}
    for r in comp:
        pr, ar = latest.get((r["district"], r["apt_name"])), r.get("area_exclusive")
        if pr and ar:
            gu_ppm2.setdefault(r["district"], []).append(pr / ar)
    gu_ppm2 = {g: float(np.median(v)) for g, v in gu_ppm2.items() if v}

    rows = []
    DONE = ("준공", "해산", "청산", "완료", "해제", "일시중단")
    for z in zones:
        gu, name = z.get("gu") or "", z.get("name") or ""
        if not name:
            continue
        # 이미 끝났거나 멈춘 사업장은 매수 후보가 아니므로 제외
        if any(k in (z.get("stage") or "") for k in DONE):
            continue
        dong = guess_dong(name, z.get("addr", ""))
        dv = dongs.get((gu, dong)) if dong else None

        # 🅰 자리 (+ 상세 근거 필드)
        dong_hit = bool(dong and (gu, dong) in infra_dong.index)
        try:
            inf = infra_dong.loc[(gu, dong)] if dong_hit else infra_gu.loc[gu]
            place_infra = float(np.nanmean([inf["transit"], inf["hub"], inf["school"]]))
            ev_transit = None if pd.isna(inf["transit"]) else round(float(inf["transit"]), 1)
            ev_school = None if pd.isna(inf["school"]) else round(float(inf["school"]), 1)
            ev_hub_km = None if pd.isna(inf["hub_km"]) else round(float(inf["hub_km"]), 1)
        except Exception:
            place_infra = ev_transit = ev_school = ev_hub_km = None
        ev_hub_name = (hub_name_dong.get((gu, dong)) if dong_hit else hub_name_gu.get(gu)) or None
        ev_n_apts = int(infra_dong_n.get((gu, dong), 0)) if dong_hit else 0
        place_value = gu_ppm2.get(gu)

        rows.append({
            "name": name, "gu": gu, "dong": dong,
            "type": z.get("type") or "", "stage": z.get("stage") or "",
            "stage_idx": stage_index(z.get("stage")),
            "place_infra": place_infra, "place_value_raw": place_value,
            "biz_area": dv["median_area"] if dv else None,       # 종전 평형
            "biz_gap": dv["apt_gap"] if dv else None,            # 아파트 갭 (낮을수록 ↑)
            "align_cv": dv.get("area_cv") if dv else None,       # 평형 유사성 (낮을수록 ↑)
            "villa_ppm2": dv["ppm2"] if dv else None,
            "villa_amt": dv["median_amount_eok"] if dv else None,
            "n_trades_12m": dv["n_trades_12m"] if dv else None,
            "lat": dv["lat"] if dv else None, "lng": dv["lng"] if dv else None,
            # 상세 근거 (플로팅 상세 패널용)
            "addr": z.get("addr") or "",
            "ev_transit": ev_transit, "ev_school": ev_school,
            "ev_hub_name": ev_hub_name, "ev_hub_km": ev_hub_km,
            "ev_n_apts": ev_n_apts, "ev_dong_hit": dong_hit,
            "ev_gu_apt_py": round(place_value * 3.3058 / 10000, 2) if place_value else None,  # 구 아파트 평당가(억)
            "ev_trend": dv.get("trend_pct_yr") if dv else None,
            "ev_jeonse_ratio": dv.get("jeonse_ratio") if dv else None,
            "ev_jeonse_danger": bool(dv.get("jeonse_danger")) if dv else False,
            "ev_new_share": dv.get("new_share") if dv else None,
        })
        # 사업개요 상세 병합 (용도지역·계획 용적률·건폐율·층수·세대수·대지면적·세입자)
        det = details.get(z.get("cafe") or "", {}) or {}
        rows[-1].update({
            "use_zone": det.get("use_zone"),
            "far_plan": det.get("far_plan"),
            "far_limit": far_limit_of(det.get("use_zone")),
            "bcr": det.get("bcr"), "floors": det.get("floors"),
            "units_sale": det.get("units_sale"), "units_rental": det.get("units_rental"),
            "land_area_z": det.get("land_area"), "tenants": det.get("tenants"),
            "owners": det.get("owners"),
        })
    df = pd.DataFrame(rows)
    if df.empty:
        print("매칭 가능한 구역 없음.")
        return 0

    # 축 점수 (구역 간 백분위)
    df["ax_place"] = np.nanmean(np.vstack([
        _pct(df["place_infra"]).to_numpy(),
        _pct(df["place_value_raw"]).to_numpy(),
    ]), axis=0).round(1)
    df["ax_biz"] = np.nanmean(np.vstack([
        _pct(df["biz_area"]).to_numpy(),                 # 종전 평형 클수록 ↑
        _pct(df["biz_gap"], invert=True).to_numpy(),     # 빌라가 아파트 대비 쌀수록 ↑
        _pct(df["far_plan"]).to_numpy(),                 # 계획 용적률 클수록 ↑ (사업개요 확보분)
    ]), axis=0).round(1)
    df["ax_align"] = _pct(df["align_cv"], invert=True).round(1)

    def total(r):
        num = den = 0.0
        for k, w in (("ax_place", WEIGHTS["place"]), ("ax_biz", WEIGHTS["biz"]), ("ax_align", WEIGHTS["align"])):
            v = r[k]
            if pd.notna(v):
                num += w * v
                den += w
        return round(num / den, 1) if den else None

    df["total"] = df.apply(total, axis=1)
    df = df.sort_values("total", ascending=False, na_position="last").reset_index(drop=True)
    df["rank"] = df.index + 1

    out = {
        "updated": date.today().isoformat(),
        "n_zones": int(len(df)),
        "weights": WEIGHTS,
        "stage_steps": [s[0] for s in STAGE_STEPS],
        "caveat": "구역 경계가 아닌 해당 법정동 실거래 통계로 근사한 참고 점수입니다. 현재 용적률·용도지역(사업성의 핵심 반쪽)과 "
                  "구역 내부 소유 구성은 데이터에 없어 미반영 — 후보 구역 선별용으로만 쓰고, 구청 정비사업과·정비몽땅에서 "
                  "구역별 계획(용적률·기부채납·권리산정일)을 반드시 확인하세요.",
        "zones": json.loads(df.to_json(orient="records", force_ascii=False)),
    }
    OUT.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    matched = int(df["villa_ppm2"].notna().sum())
    print(f"✅ 정비구역 3박자 분석 {len(df)}건 저장 (빌라 시세 매칭 {matched}건) → {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
