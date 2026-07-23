"""
성북구 심화 데이터 수집 — 300세대 이상 '모든' 아파트 단지
─────────────────────────────────────────────────────────
성북구만 따로 떼어 정교하게 본다. 기존 파이프라인(서울 전체 상위 388단지)은
성북구를 34개 단지만 담지만, 여기서는 K-apt(공동주택관리정보시스템)로
구 안의 '실제 세대수 300+' 단지를 전수 확보하고, 단지마다:

  · 정확한 세대수·동수·준공일·복도유형·난방·주차대수 (K-apt)
  · 좌표 (카카오 지오코딩, 실패 시 기존 좌표/법정동 중심)
  · 경사도 — 단지 중심 + 동서남북 120m 지점 고도 5점 표본(Open-Elevation)
  · 실거래 시세 — data/raw/11290_*.parquet 전체 거래 조인 (최근 12개월 중위가,
    ㎡가, 1년 추세, 거래량)
  · 장점/단점 — 위 지표를 규칙 기반으로 요약한 한국어 목록

필요 키
  MOLIT_API_KEY   data.go.kr 공통 인증키. 단, 아래 두 서비스를 '활용신청' 해야 함:
                  ① 국토교통부_공동주택 단지 목록제공 서비스 (AptListService3)
                  ② 국토교통부_공동주택 기본 정보제공 서비스 (AptBasisInfoServiceV3)
  KAKAO_REST_KEY  (선택) 주소 → 좌표 지오코딩. 없으면 기존 좌표만 사용.

키가 없거나 활용신청 전이면: 실거래 원본에서 세대수를 추정(거래건수/6*10)하는
폴백 모드로 동작한다 — 페이지에는 '추정' 배지가 붙는다.

출력: data/processed/seongbuk.json
"""

import json
import math
import os
import re
import sys
import time
import xml.etree.ElementTree as ET
from datetime import date
from pathlib import Path

import pandas as pd
import requests

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

ROOT = Path(__file__).parent
OUT = ROOT / "data" / "processed" / "seongbuk.json"
RAW_GLOB = "11290_*.parquet"          # 성북구 법정구 코드
SIGUNGU = "11290"
MIN_HH = 300                          # 300세대 이상만
API_KEY = os.environ.get("MOLIT_API_KEY", "").strip()
KAKAO = os.environ.get("KAKAO_REST_KEY", "").strip()

LIST_URL = "https://apis.data.go.kr/1613000/AptListService3/getSigunguAptList3"
# 기본/상세 정보는 data.go.kr 서비스 버전이 바뀌곤 해(V3→V4) 후보를 순차 시도한다.
BASE_URLS = [
    "https://apis.data.go.kr/1613000/AptBasisInfoServiceV4/getAphusBaseInfoV4",
    "https://apis.data.go.kr/1613000/AptBasisInfoServiceV3/getAphusBaseInfoV3",
    "https://apis.data.go.kr/1613000/AptBasisInfoServiceV2/getAphusBaseInfoV2",
    "https://apis.data.go.kr/1613000/AptBasisInfoService1/getAphusBaseInfo1",
]
DTL_URLS = [
    "https://apis.data.go.kr/1613000/AptBasisInfoServiceV4/getAphusDtlInfoV4",
    "https://apis.data.go.kr/1613000/AptBasisInfoServiceV3/getAphusDtlInfoV3",
    "https://apis.data.go.kr/1613000/AptBasisInfoServiceV2/getAphusDtlInfoV2",
    "https://apis.data.go.kr/1613000/AptBasisInfoService1/getAphusDtlInfo1",
]
ELEV_URL = "https://api.open-elevation.com/api/v1/lookup"


# ── 이름 정규화 (K-apt ↔ 실거래 조인용) ──────────────────
def _norm(name: str) -> str:
    s = re.sub(r"\([^)]*\)", "", str(name or ""))
    s = re.sub(r"[\s\-·]|아파트$", "", s)
    return s.lower()


# ── K-apt 수집 ────────────────────────────────────────────
def _xml_items(text: str) -> list:
    """응답 XML의 <item>들을 {태그: 값} dict 리스트로 (스키마 방어적 파싱)."""
    root = ET.fromstring(text)
    code = root.findtext(".//resultCode") or ""
    if code not in ("00", "0", ""):
        raise RuntimeError(f"API 오류 {code}: {root.findtext('.//resultMsg')}")
    out = []
    for it in root.iter("item"):
        out.append({c.tag: (c.text or "").strip() for c in it})
    return out


def _json_items(data: dict) -> list:
    """K-apt JSON 응답에서 item 리스트 추출 (단건이면 dict로 오기도 한다)."""
    body = (data.get("response") or {}).get("body") or {}
    items = body.get("items") or body.get("item") or []
    if isinstance(items, dict):
        items = items.get("item", items)
    if isinstance(items, dict):
        items = [items]
    return [i for i in items if isinstance(i, dict)]


def _get(url: str, **params) -> list:
    r = requests.get(url, params={"serviceKey": API_KEY, **params}, timeout=20)
    r.raise_for_status()
    if r.text.lstrip().startswith("{"):          # 이 API는 JSON으로 응답한다
        return _json_items(r.json())
    return _xml_items(r.text)


_ver_cache = {}   # id(url_list) → 동작 확인된 URL


def _get_versioned(urls: list, **params) -> list:
    """URL 후보를 순차 시도해 처음 성공한 버전을 기억한다 (V4/V3 개편 대응)."""
    key = id(urls)
    if key in _ver_cache:
        return _get(_ver_cache[key], **params)
    last = None
    for u in urls:
        try:
            out = _get(u, **params)
            _ver_cache[key] = u
            print(f"  ↳ 사용 엔드포인트: {u.rsplit('/', 1)[-1]}")
            return out
        except Exception as e:
            last = e
    raise last or RuntimeError("모든 버전 실패")


def fetch_kapt() -> list:
    """성북구 전체 단지 목록 → 단지별 기본+상세 정보. 실패 시 빈 리스트(폴백)."""
    if not API_KEY:
        print("MOLIT_API_KEY 없음 — K-apt 건너뜀 (추정 세대수 폴백)")
        return []
    try:
        items, page = [], 1
        while True:
            batch = _get(LIST_URL, sigunguCode=SIGUNGU, numOfRows=100, pageNo=page)
            items += batch
            if len(batch) < 100:
                break
            page += 1
        print(f"K-apt 단지 목록 {len(items)}개")
    except Exception as e:
        print(f"⚠️ K-apt 목록 실패({e}) — data.go.kr에서 'AptListService3' 활용신청 필요할 수 있음")
        return []

    rows = []
    for i, it in enumerate(items):
        code = it.get("kaptCode")
        if not code:
            continue
        try:
            base = (_get_versioned(BASE_URLS, kaptCode=code) or [{}])[0]
            time.sleep(0.15)
            try:
                dtl = (_get_versioned(DTL_URLS, kaptCode=code) or [{}])[0]
            except Exception:
                dtl = {}
            time.sleep(0.15)
        except Exception as e:
            print(f"  {it.get('kaptName')} 기본정보 실패: {e}")
            continue

        def num(d, *keys):
            for k in keys:
                v = d.get(k)
                if v and re.match(r"^\d+(\.\d+)?$", str(v)):
                    return float(v)
            return None

        hh = num(base, "kaptdaCnt") or num(dtl, "kaptdaCnt")
        rows.append({
            "kapt_code": code,
            "name": base.get("kaptName") or it.get("kaptName"),
            "addr": base.get("doroJuso") or base.get("kaptAddr") or "",
            "households": int(hh) if hh else None,
            "dong_cnt": int(num(base, "kaptDongCnt") or 0) or None,
            "ho_cnt": int(num(base, "hoCnt") or 0) or None,
            "use_date": str(base.get("kaptUsedate") or "")[:6],   # YYYYMM
            "hall_type": str(base.get("codeHallNm") or ""),        # 복도식/계단식/혼합식
            "heat": str(base.get("codeHeatNm") or ""),             # 개별난방/지역난방...
            "parking": int((num(dtl, "kaptdPcnt") or 0) + (num(dtl, "kaptdPcntu") or 0)) or None,
            "subway_line": str(dtl.get("subwayLine") or ""),
            "subway_station": str(dtl.get("subwayStation") or ""),
            "subway_walk": str(dtl.get("kaptdWtimesub") or ""),    # '5분이내' 등 문자열
            "bus_walk": str(dtl.get("kaptdWtimebus") or ""),
        })
        if (i + 1) % 20 == 0:
            print(f"  기본정보 {i+1}/{len(items)}")
    return rows


# ── 실거래 조인 ───────────────────────────────────────────
def load_trades() -> pd.DataFrame:
    fs = sorted((ROOT / "data" / "raw").glob(RAW_GLOB))
    if not fs:
        sys.exit("data/raw/11290_*.parquet 없음 — 실거래 수집 먼저 실행")
    df = pd.concat([pd.read_parquet(f) for f in fs], ignore_index=True)
    df["deal_amount"] = pd.to_numeric(df["deal_amount"], errors="coerce")
    df["area_exclusive"] = pd.to_numeric(df["area_exclusive"], errors="coerce")
    df = df.dropna(subset=["deal_amount", "area_exclusive"])
    df = df[~df["cdealDay"].astype(str).str.strip().astype(bool)]   # 해제거래 제외
    df["ym"] = df["deal_ym"].astype(int)
    df["norm"] = df["apt_name"].map(_norm)
    return df


def trade_stats(df: pd.DataFrame) -> dict:
    """정규화 이름 → 시세 요약. (동 구분: 같은 이름은 성북구 안에서 드물어 이름 기준)"""
    last_ym = int(df["ym"].max())
    y, m = divmod(last_ym, 100)
    cut12 = (y - 1) * 100 + m     # 12개월 전
    cut24 = (y - 2) * 100 + m
    out = {}
    for norm, g in df.groupby("norm"):
        r12 = g[g["ym"] > cut12]
        r_prev = g[(g["ym"] > cut24) & (g["ym"] <= cut12)]
        med12 = r12["deal_amount"].median() if len(r12) else None
        med_prev = r_prev["deal_amount"].median() if len(r_prev) else None
        ppm2 = (r12["deal_amount"] / r12["area_exclusive"]).median() if len(r12) else None
        # 주력 평형: 최근 3년 최빈 전용면적 구간
        g3 = g[g["ym"] > (y - 3) * 100 + m]
        area_mode = g3["area_exclusive"].round(0).mode()
        out[norm] = {
            "apt_name": g["apt_name"].mode().iloc[0],
            "dong": g["umd_name"].mode().iloc[0],
            "jibun": str(g["jibun"].mode().iloc[0]) if len(g["jibun"].mode()) else "",
            "build_year": int(g["build_year"].mode().iloc[0]) if g["build_year"].mode().iloc[0] else None,
            "n_total": int(len(g)), "n_12m": int(len(r12)),
            "med_12m": round(med12) if med12 else None,          # 만원
            "ppm2_12m": round(ppm2, 1) if ppm2 else None,        # 만원/㎡
            "trend_pct": round((med12 / med_prev - 1) * 100, 1) if med12 and med_prev else None,
            "main_area": float(area_mode.iloc[0]) if len(area_mode) else None,
            "est_households": int(len(g) / 6 * 10),              # 폴백용 추정
        }
    return out


# ── 좌표 ─────────────────────────────────────────────────
def geocode(addr: str, cache: dict) -> dict | None:
    """카카오 → (키 없으면) Nominatim 순으로 주소 지오코딩."""
    if not addr:
        return None
    if addr in cache:
        return cache[addr]
    if KAKAO:
        try:
            r = requests.get("https://dapi.kakao.com/v2/local/search/address.json",
                             params={"query": addr},
                             headers={"Authorization": f"KakaoAK {KAKAO}"}, timeout=10)
            docs = r.json().get("documents", [])
            if docs:
                cache[addr] = {"lat": float(docs[0]["y"]), "lng": float(docs[0]["x"])}
                time.sleep(0.1)
                return cache[addr]
        except Exception:
            pass
    try:   # Nominatim 폴백 (CI에서 동작, 1건/초 예의)
        r = requests.get("https://nominatim.openstreetmap.org/search",
                         params={"q": addr, "format": "json", "limit": 1, "countrycodes": "kr"},
                         headers={"User-Agent": "seoul-apt-tool/1.0"}, timeout=15)
        js = r.json()
        time.sleep(1.1)
        if js:
            cache[addr] = {"lat": float(js[0]["lat"]), "lng": float(js[0]["lon"])}
            return cache[addr]
    except Exception:
        pass
    cache[addr] = None
    return None


# ── 경사도 (Open-Elevation, 5점 표본) ─────────────────────
def add_slopes(rows: list):
    pts, idx = [], []
    D = 120 / 111320          # 120m를 도 단위로
    for i, r in enumerate(rows):
        if r.get("lat") is None:
            continue
        la, ln = r["lat"], r["lng"]
        dln = D / math.cos(math.radians(la))
        for (a, b) in [(la, ln), (la + D, ln), (la - D, ln), (la, ln + dln), (la, ln - dln)]:
            pts.append({"latitude": round(a, 6), "longitude": round(b, 6)})
            idx.append(i)
    if not pts:
        return
    elevs = []
    try:
        for s in range(0, len(pts), 100):
            r = requests.post(ELEV_URL, json={"locations": pts[s:s + 100]}, timeout=40)
            r.raise_for_status()
            elevs += [p.get("elevation") for p in r.json()["results"]]
            time.sleep(1)
    except Exception as e:
        print(f"⚠️ 고도 조회 실패({e}) — 경사도 없이 진행")
        return
    by = {}
    for i, e in zip(idx, elevs):
        by.setdefault(i, []).append(e)
    for i, es in by.items():
        es = [e for e in es if e is not None]
        if len(es) < 3:
            continue
        center, rest = es[0], es[1:]
        grade = max(abs(e - center) for e in rest) / 120 * 100
        rows[i]["elevation_m"] = round(center)
        rows[i]["slope_pct"] = round(grade, 1)
        rows[i]["slope_label"] = ("평지" if grade < 3 else "완만한 경사" if grade < 6
                                  else "언덕" if grade < 10 else "가파른 언덕")


# ── 장점/단점 규칙 ────────────────────────────────────────
def pros_cons(r: dict, gu_ppm2: float | None) -> tuple[list, list]:
    pros, cons = [], []
    hh, yr = r.get("households") or r.get("est_households") or 0, r.get("build_year")
    slope = r.get("slope_pct")

    if slope is not None:
        if slope < 3: pros.append(f"평지 입지(경사 {slope}%) — 도보·유모차·자전거 생활 편함")
        elif slope < 6: cons.append(f"완만한 경사(경사 {slope}%) — 겨울 빙판길은 주의")
        elif slope < 10: cons.append(f"언덕 지형(경사 {slope}%) — 도보 출퇴근 시 체감 큼")
        else: cons.append(f"가파른 언덕(경사 {slope}%) — 차량 필수, 겨울철 불편")
    if hh >= 1500: pros.append(f"{hh:,}세대 대단지 — 관리비 절감·커뮤니티·환금성 유리")
    elif hh >= 700: pros.append(f"{hh:,}세대 중대형 단지 — 거래가 꾸준해 환금성 무난")
    elif hh < 400: cons.append(f"{hh:,}세대 소단지 — 거래 뜸하면 팔 때 시간이 걸릴 수 있음")
    if yr:
        age = date.today().year - yr
        if age <= 7: pros.append(f"{yr}년 준공 신축급 — 주차·커뮤니티 등 상품성 좋음")
        elif age <= 17: pros.append(f"{yr}년 준공 준신축 — 상품성과 가격의 균형대")
        elif age >= 30: cons.append(f"{yr}년 준공 구축({age}년차) — 배관·주차 노후, 재건축은 장기 이슈")
        elif age >= 23: cons.append(f"{yr}년 준공({age}년차) — 리모델링·수선 상태 확인 필요")
    pk = r.get("parking")
    if pk and hh:
        ratio = pk / hh
        if ratio >= 1.2: pros.append(f"주차 세대당 {ratio:.1f}대 — 여유 있음")
        elif ratio < 0.7: cons.append(f"주차 세대당 {ratio:.1f}대 — 이중주차 가능성")
    if "계단식" in (r.get("hall_type") or ""): pros.append("계단식 구조 — 프라이버시·환기 유리")
    elif "복도식" in (r.get("hall_type") or ""): cons.append("복도식 구조 — 소음·프라이버시 아쉬움")
    if "지역난방" in (r.get("heat") or ""): pros.append("지역난방 — 난방비 안정적")
    sw = r.get("subway_walk") or ""
    if r.get("subway_station"):
        if re.search(r"5분", sw): pros.append(f"{r['subway_station']} 초역세권(도보 {sw})")
        elif re.search(r"10분", sw): pros.append(f"{r['subway_station']} 역세권(도보 {sw})")
        elif re.search(r"1[5-9]|2\d분", sw): cons.append(f"지하철 도보 {sw} — 역까지 다소 멂")
    ppm2 = r.get("ppm2_12m")
    if ppm2 and gu_ppm2:
        d = ppm2 / gu_ppm2 - 1
        if d <= -0.15: pros.append(f"㎡가 {ppm2:,.0f}만 — 성북구 중위 대비 {abs(d)*100:.0f}% 저렴")
        elif d >= 0.2: cons.append(f"㎡가 {ppm2:,.0f}만 — 성북구 중위 대비 {d*100:.0f}% 비쌈(대장 프리미엄)")
    tr = r.get("trend_pct")
    if tr is not None:
        if tr >= 5: pros.append(f"최근 1년 시세 +{tr}% 상승 흐름")
        elif tr <= -5: cons.append(f"최근 1년 시세 {tr}% 하락 — 저가 매수 기회일 수도, 추세 확인")
    n12 = r.get("n_12m") or 0
    if n12 >= 30: pros.append(f"최근 12개월 실거래 {n12}건 — 시세 검증 쉬움")
    elif n12 <= 3 and r.get("med_12m"): cons.append(f"최근 12개월 거래 {n12}건 — 호가·실거래 괴리 주의")
    return pros, cons


# ── 메인 ─────────────────────────────────────────────────
def main() -> int:
    df = load_trades()
    tstats = trade_stats(df)
    print(f"실거래 조인 준비: {len(tstats)}개 단지명")

    kapt = fetch_kapt()
    kapt_ok = bool(kapt)

    # 기존 파이프라인 좌표 재활용 (성북구 34단지)
    known_xy = {}
    try:
        comp = json.load(open(ROOT / "data" / "processed" / "composite_score.json"))
        for r in (comp if isinstance(comp, list) else comp.get("ranking", [])):
            if r.get("district") == "성북구" and r.get("lat"):
                known_xy[_norm(r["apt_name"])] = {"lat": r["lat"], "lng": r["lng"],
                                                  "extra": {k: r.get(k) for k in
                                                            ("nearest_station", "nearest_station_m",
                                                             "nearest_elem_m", "academy_within_1km",
                                                             "composite_score", "rank")}}
    except Exception:
        pass

    rows = []
    if kapt_ok:
        cache = {}
        for k in kapt:
            if not k["households"] or k["households"] < MIN_HH:
                continue
            n = _norm(k["name"])
            r = dict(k)
            ts = tstats.get(n)
            if ts:
                r.update({f: ts[f] for f in ("dong", "build_year", "n_total", "n_12m",
                                             "med_12m", "ppm2_12m", "trend_pct", "main_area")})
            if not r.get("build_year") and r.get("use_date"):
                r["build_year"] = int(r["use_date"][:4])
            xy = known_xy.get(n)
            if xy:
                r.update({"lat": xy["lat"], "lng": xy["lng"], **{k2: v for k2, v in xy["extra"].items() if v is not None}})
            else:
                g = geocode(r["addr"], cache)
                if g:
                    r.update(g)
            r["hh_source"] = "kapt"
            rows.append(r)
        print(f"K-apt 기준 300세대+ 단지: {len(rows)}개")
    else:
        # 폴백: 실거래 추정 세대수
        for n, ts in tstats.items():
            if ts["est_households"] < MIN_HH:
                continue
            r = {"name": ts["apt_name"], "households": ts["est_households"],
                 "hh_source": "estimated", **{f: ts[f] for f in
                 ("dong", "jibun", "build_year", "n_total", "n_12m", "med_12m",
                  "ppm2_12m", "trend_pct", "main_area")}}
            xy = known_xy.get(n)
            if xy:
                r.update({"lat": xy["lat"], "lng": xy["lng"], **{k2: v for k2, v in xy["extra"].items() if v is not None}})
            rows.append(r)
        print(f"추정 기준 300세대+ 단지: {len(rows)}개 (K-apt 승인 후 정확 세대수로 대체)")

    add_slopes(rows)

    gu_ppm2 = pd.Series([r["ppm2_12m"] for r in rows if r.get("ppm2_12m")]).median()
    for r in rows:
        r["pros"], r["cons"] = pros_cons(r, gu_ppm2)
    rows.sort(key=lambda r: -(r.get("households") or 0))

    OUT.write_text(json.dumps({
        "updated": date.today().isoformat(),
        "kapt_ok": kapt_ok,
        "gu_ppm2_median": round(gu_ppm2, 1) if gu_ppm2 == gu_ppm2 else None,
        "source": "K-apt 공동주택 기본정보 + 국토부 실거래가 + Open-Elevation 고도"
                  if kapt_ok else "국토부 실거래가(세대수는 거래량 기반 추정) + Open-Elevation 고도",
        "complexes": rows,
    }, ensure_ascii=False), encoding="utf-8")
    print(f"✅ 성북구 {len(rows)}개 단지 저장 → {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
