"""
공동주택 공시가격 수집기 (HUG 126% 참고 지표용, Additive-Only)
─────────────────────────────────────────────────────
국토교통부 공동주택 공시가격(NSDI ApartHousingPriceService)을 단지별로
수집해 data/static/official_price.json 캐시로 저장한다. 연 1회 고시라
캐시가 있으면 스킵(연도 바뀌면 재수집).

필요 키:
  ① V-World 인증키 (vworld.kr 발급, GitHub Secret OFFICIAL_PRICE_API_KEY) —
     공동주택가격 속성조회는 V-World NED API(key= 파라미터)로 호출된다.
  ② 법정동코드(StanReginCd)는 data.go.kr 공통 키(MOLIT_API_KEY) — PNU 조립용

동작: 단지 대표 지번주소(apt_locations.json) → 법정동코드10+지번 → PNU →
공시가 조회 → 전용 55~63㎡ 세대 공시가 중앙값. 매칭 실패 단지는 결과에서
제외(프론트가 자동 숨김). 403/미신청이면 전체를 건너뛰고 안내만 출력.

실행: python collect_official_price.py
"""

import json
import os
import re
import sys
import time
import logging
import statistics
from pathlib import Path

import requests
from dotenv import load_dotenv

ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT))
import config

load_dotenv()
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger(__name__)

LOC = ROOT / "data" / "static" / "apt_locations.json"
BJD_CACHE = ROOT / "data" / "static" / "bjd_codes_seoul.json"
OUT = ROOT / "data" / "static" / "official_price.json"

REGIN_URL = "https://apis.data.go.kr/1741000/StanReginCd/getStanReginCdList"
PRICE_URL = "https://api.vworld.kr/ned/data/getApartHousingPriceAttr"
STDR_YEAR = "2025"        # 최신 고시연도 (실패 시 전년도로 1회 폴백)
AREA_MIN, AREA_MAX = config.TARGET_AREA_MIN, config.TARGET_AREA_MAX


def _fetch_bjd_codes(key: str) -> dict:
    """서울 법정동명('강동구 암사동') → 법정동코드 10자리. 1회 수집 후 캐시."""
    if BJD_CACHE.exists():
        return json.loads(BJD_CACHE.read_text(encoding="utf-8"))
    codes, page = {}, 1
    while True:
        r = requests.get(REGIN_URL, params={
            "ServiceKey": key, "type": "json", "pageNo": page, "numOfRows": 1000,
            "locatadd_nm": "서울특별시"}, timeout=30)
        r.raise_for_status()
        js = r.json()
        rows = []
        for sect in js.get("StanReginCd", []):
            rows.extend(sect.get("row", []))
        if not rows:
            break
        for row in rows:
            nm, cd = row.get("locatadd_nm", ""), row.get("region_cd", "")
            # '서울특별시 강동구 암사동' 꼴(동 단위, 폐지되지 않은 코드)만
            parts = nm.split()
            if len(parts) == 3 and len(cd) == 10 and not cd.endswith("00000"):
                codes[f"{parts[1]} {parts[2]}"] = cd
        if len(rows) < 1000:
            break
        page += 1
        time.sleep(0.2)
    if len(codes) < 300:
        log.warning(f"법정동코드 {len(codes)}개만 수집 — 응답 형식 확인 필요")
    BJD_CACHE.write_text(json.dumps(codes, ensure_ascii=False, indent=1), encoding="utf-8")
    log.info(f"법정동코드 {len(codes)}개 캐시 → {BJD_CACHE}")
    return codes


def _pnu(bjd10: str, jibun: str) -> str | None:
    """PNU 19자리 = 법정동10 + 필지구분1(일반=1/산=2) + 본번4 + 부번4."""
    m = re.match(r"^\s*(산)?\s*(\d+)(?:-(\d+))?", str(jibun))
    if not m:
        return None
    san, bon, bu = m.group(1), int(m.group(2)), int(m.group(3) or 0)
    return f"{bjd10}{'2' if san else '1'}{bon:04d}{bu:04d}"


# V-World는 인증키 발급 시 등록한 도메인과 요청의 domain 파라미터가 일치해야
# 하는 경우가 있다. 시크릿 OFFICIAL_PRICE_DOMAIN(발급 때 입력한 URL)이 있으면
# 함께 보낸다. 없으면 생략(도메인 검증 없는 키도 존재).
VWORLD_DOMAIN = os.getenv("OFFICIAL_PRICE_DOMAIN", "")


def _query_price(key: str, pnu: str, year: str, debug: bool = False) -> list[dict]:
    params = {"key": key, "pnu": pnu, "stdrYear": year,
              "format": "json", "numOfRows": 400, "pageNo": 1}
    if VWORLD_DOMAIN:
        params["domain"] = VWORLD_DOMAIN
    r = requests.get(PRICE_URL, params=params, timeout=30,
                     headers={"Referer": VWORLD_DOMAIN} if VWORLD_DOMAIN else {})
    if r.status_code in (401, 403):
        raise PermissionError(f"{r.status_code} — V-World 인증키(OFFICIAL_PRICE_API_KEY) 확인 필요")
    r.raise_for_status()
    if debug:
        log.info(f"[진단] 첫 응답 HTTP {r.status_code} / {r.text[:400]!r}")
    try:
        js = r.json()
    except ValueError:
        # JSON이 아니면(오류 XML/HTML 등) 원문 머리를 남겨 다음 실행 로그에서 원인 확인
        raise RuntimeError(f"JSON 아님: {r.text[:200]!r}")
    field = js.get("apartHousingPrices") or js.get("ApartHousingPrices") or {}
    return field.get("field", []) or []


def main():
    # 공시가 조회는 V-World 전용 키, 법정동코드는 data.go.kr 공통 키로 분리
    key = os.getenv("OFFICIAL_PRICE_API_KEY")
    regin_key = os.getenv("MOLIT_API_KEY")
    if not key:
        log.error("OFFICIAL_PRICE_API_KEY(V-World 인증키) 시크릿이 없어 공시가 수집을 건너뜁니다.")
        return
    if not regin_key:
        raise EnvironmentError("MOLIT_API_KEY 없음 (법정동코드 조회용)")
    if OUT.exists():
        cached = json.loads(OUT.read_text(encoding="utf-8"))
        if cached.get("stdr_year") == STDR_YEAR and cached.get("apartments"):
            log.info(f"{STDR_YEAR}년 공시가 캐시 존재({len(cached['apartments'])}개) — 스킵")
            return

    locs = json.loads(LOC.read_text(encoding="utf-8"))

    # 진단: 법정동코드 API부터 (자동승인이라 이게 되면 키 자체는 정상)
    try:
        bjd = _fetch_bjd_codes(regin_key)
    except Exception as e:
        log.error(f"[진단] 법정동코드 API 실패({e}) — 'StanReginCd' 활용신청 확인 필요. 수집 건너뜀.")
        return

    apartments, fail_pnu, fail_q = [], 0, 0
    first_err = None          # 전수 실패 시 원인 파악용 — 첫 오류 본문을 보존
    diagnosed = False
    stopped = None
    items = [(k, v) for k, v in locs.items() if v.get("address")]
    for i, (cache_key, v) in enumerate(items):
        district, apt = v["district"], v["apt_name"]
        m = re.match(r"서울\s+(\S+)\s+(\S+)\s+(.+)$", v["address"])
        if not m:
            fail_pnu += 1
            continue
        bjd10 = bjd.get(f"{m.group(1)} {m.group(2)}")
        pnu = _pnu(bjd10, m.group(3)) if bjd10 else None
        if not pnu:
            fail_pnu += 1
            continue
        try:
            rows = _query_price(key, pnu, STDR_YEAR, debug=not diagnosed) \
                   or _query_price(key, pnu, str(int(STDR_YEAR) - 1))
            diagnosed = True
        except PermissionError as e:
            stopped = str(e)
            break   # 권한 문제는 재시도 무의미 — 전체 중단(다음 CI에서 재시도)
        except Exception as e:
            fail_q += 1
            if first_err is None:
                first_err = f"{type(e).__name__}: {e}"
            if fail_q >= 20 and not apartments:
                # 20연속 실패 + 성공 0 = 체계적 문제 — 379번 더 두드리지 않고 중단
                stopped = f"연속 실패로 조기 중단. 첫 오류: {first_err}"
                break
            continue
        # 전용 55~63㎡ 세대의 공시가 중앙값 (만원 단위로 환산: API는 원 단위 pblntfPc)
        prices = []
        for row in rows:
            try:
                area = float(row.get("prvuseAr") or row.get("PRVUSE_AR") or 0)
                pc = float(row.get("pblntfPc") or row.get("PBLNTF_PC") or 0)
            except (TypeError, ValueError):
                continue
            if AREA_MIN <= area <= AREA_MAX and pc > 0:
                prices.append(pc / 10000)
        if prices:
            apartments.append({"district": district, "apt_name": apt,
                               "gongsi_median": round(statistics.median(prices)),
                               "n_units": len(prices)})
        if i % 50 == 49:
            log.info(f"  진행 {i+1}/{len(items)} (성공 {len(apartments)})")
        time.sleep(0.15)

    if stopped:
        log.error(f"[중단] {stopped}")
        log.error("  V-World 발급 화면의 '서비스 URL/도메인'에 입력한 값을 GitHub Secret "
                  "OFFICIAL_PRICE_DOMAIN으로 등록하면 도메인 검증 문제를 해결할 수 있습니다.")
    if first_err and not apartments:
        log.error(f"  전수 실패 원인 샘플: {first_err}")
        if not apartments:
            return
    OUT.write_text(json.dumps({"stdr_year": STDR_YEAR, "n": len(apartments),
                               "apartments": apartments}, ensure_ascii=False, indent=1),
                   encoding="utf-8")
    log.info(f"공시가 저장: {len(apartments)}개 단지 (PNU실패 {fail_pnu}, 조회실패 {fail_q}) → {OUT}")


if __name__ == "__main__":
    main()
