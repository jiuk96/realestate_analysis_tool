"""
아파트 좌표 + 최근접 지하철역 수집
─────────────────────────────────────────────────────
분석 대상 단지(composite_score.json)의 좌표를 구하고 최근접 지하철역을
계산해 data/static/apt_locations.json 캐시로 저장.

실행: python geocode_apts.py
  - 기본: OpenStreetMap (Nominatim + Overpass) — API 키 불필요, 무료
  - .env에 KAKAO_REST_KEY가 있으면 Kakao Local API 사용 (더 정확)
  - API는 이 스크립트에서만 호출. 이후 build_data.py는 캐시만 읽음.
  - 재실행 시 이미 수집된 단지는 건너뜀 (증분 수집).
"""

import json
import math
import time
import sys
from pathlib import Path

import pandas as pd
import requests

ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT))
from config import DISTRICTS as _DISTRICTS_BY_NAME

CACHE = ROOT / "data" / "static" / "apt_locations.json"
STATIONS = ROOT / "data" / "static" / "subway_stations.json"
NEAR_M = 1000            # "역세권" 집계 반경
MAX_M = 1500             # 이 거리 밖이면 역 없음 취급

DISTRICTS = {v: k for k, v in _DISTRICTS_BY_NAME.items()}   # 코드 → 구 이름

UA = {"User-Agent": "seoul-apt-analysis/1.0 (personal research)"}


def haversine_m(lat1, lng1, lat2, lng2) -> float:
    R = 6371000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
    return R * 2 * math.asin(math.sqrt(a))


def load_kakao_key() -> str | None:
    # 1) 환경변수 우선 (GitHub Actions secrets 등)
    import os
    if os.environ.get("KAKAO_REST_KEY"):
        return os.environ["KAKAO_REST_KEY"]
    # 2) 로컬 개발용 .env 파일
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            if line.startswith("KAKAO_REST_KEY=") and line.split("=", 1)[1].strip():
                return line.split("=", 1)[1].strip()
    return None


# ── 지하철역 좌표 확보 (Overpass, 1회) ────────────────────────

def fetch_stations() -> list[dict]:
    """서울 지하철/전철역 좌표를 Overpass API에서 1회 수집 → 캐시"""
    if STATIONS.exists():
        return json.loads(STATIONS.read_text(encoding="utf-8"))

    print("지하철역 좌표 수집 중 (Overpass API)...")
    query = """
    [out:json][timeout:60];
    (
      node["railway"="station"]["station"="subway"](37.42,126.75,37.72,127.20);
      node["railway"="station"]["subway"="yes"](37.42,126.75,37.72,127.20);
    );
    out body;
    """
    r = requests.post("https://overpass-api.de/api/interpreter",
                      data={"data": query}, headers=UA, timeout=90)
    r.raise_for_status()
    elements = r.json().get("elements", [])

    seen = {}
    for e in elements:
        name = e.get("tags", {}).get("name", "")
        if not name:
            continue
        key = (name, round(e["lat"], 3), round(e["lon"], 3))
        seen[key] = {"name": name, "lat": e["lat"], "lng": e["lon"]}
    stations = list(seen.values())

    if len(stations) < 100:
        print(f"경고: 역이 {len(stations)}개만 수집됨 — Overpass 응답 확인 필요")
    STATIONS.parent.mkdir(parents=True, exist_ok=True)
    STATIONS.write_text(json.dumps(stations, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"  역 {len(stations)}개 저장 → {STATIONS}")
    return stations


def nearest_station(lat: float, lng: float, stations: list[dict]) -> tuple[str | None, int | None, int]:
    """최근접역 (이름, 거리m), 1km 내 역 수"""
    best_name, best_d = None, float("inf")
    within = 0
    for s in stations:
        d = haversine_m(lat, lng, s["lat"], s["lng"])
        if d < best_d:
            best_name, best_d = s["name"], d
        if d <= NEAR_M:
            within += 1
    if best_d > MAX_M:
        return None, None, within
    return best_name, int(best_d), within


# ── 지오코딩 ─────────────────────────────────────────────────

def geocode_osm(session: requests.Session, queries: list[str]) -> tuple[float, float] | None:
    """Nominatim: 여러 쿼리를 순서대로 시도 (1 req/s 준수)"""
    for q in queries:
        try:
            r = session.get("https://nominatim.openstreetmap.org/search",
                            params={"q": q, "format": "json", "limit": 1,
                                    "countrycodes": "kr"},
                            headers=UA, timeout=15)
            time.sleep(1.1)   # Nominatim 정책: 1 req/s
            if r.status_code != 200:
                continue
            docs = r.json()
            if docs:
                return float(docs[0]["lat"]), float(docs[0]["lon"])
        except Exception:
            continue
    return None


def geocode_kakao(session: requests.Session, key: str, addr: str | None,
                  district: str, apt_name: str) -> tuple[float, float] | None:
    h = {"Authorization": f"KakaoAK {key}"}
    try:
        if addr:
            r = session.get("https://dapi.kakao.com/v2/local/search/address.json",
                            params={"query": addr}, headers=h, timeout=10)
            docs = r.json().get("documents", []) if r.status_code == 200 else []
            if docs:
                return float(docs[0]["y"]), float(docs[0]["x"])
        r = session.get("https://dapi.kakao.com/v2/local/search/keyword.json",
                        params={"query": f"서울 {district} {apt_name}", "size": 3},
                        headers=h, timeout=10)
        docs = r.json().get("documents", []) if r.status_code == 200 else []
        if docs:
            return float(docs[0]["y"]), float(docs[0]["x"])
    except Exception:
        pass
    return None


def representative_address(raw: pd.DataFrame, apt_name: str, district: str):
    """단지의 최빈 (법정동, 지번) → (지번주소, 법정동)"""
    sub = raw[(raw["apt_name"] == apt_name) & (raw["district_name"] == district)]
    if sub.empty:
        return None, None
    umd, jibun = sub.groupby(["umd_name", "jibun"]).size().idxmax()
    jibun = str(jibun).strip()
    return f"서울 {district} {umd} {jibun}".strip(), umd


def main():
    kakao_key = load_kakao_key()
    provider = "kakao" if kakao_key else "osm"
    print(f"지오코딩 제공자: {provider.upper()}"
          + ("" if kakao_key else " (API 키 불필요 — Nominatim은 초당 1건 제한이라 약 3~5분 소요)"))

    stations = fetch_stations()
    session = requests.Session()

    comp = json.loads((ROOT / "data/processed/composite_score.json").read_text(encoding="utf-8"))
    targets = [(r["apt_name"], r["district"]) for r in comp["ranking"]]

    print("원본 데이터 로드 중...")
    dfs = [pd.read_parquet(f) for f in sorted((ROOT / "data/raw").glob("*.parquet"))]
    raw = pd.concat(dfs, ignore_index=True)
    raw["district_name"] = raw["district_code"].astype(str).map(DISTRICTS)

    cache: dict = {}
    if CACHE.exists():
        cache = json.loads(CACHE.read_text(encoding="utf-8"))

    ok = fail = skip = 0
    for apt_name, district in targets:
        cache_key = f"{district}|{apt_name}"
        # 추정 좌표(source=estimate)는 실측으로 교체, 이미 실측이면 스킵
        if (cache_key in cache and cache[cache_key].get("lat")
                and cache[cache_key].get("source") != "estimate"):
            skip += 1
            continue

        addr, umd = representative_address(raw, apt_name, district)
        # umd(법정동)는 이미 계산해두고도 캐시에 저장을 안 해서, 대시보드의 네이버
        # 검색어가 "구"까지만 붙는 바람에(너무 넓어 오매칭/0건) 흔한 단지명일수록
        # 잘 안 열리는 문제가 있었다 — "동"까지 저장해 검색 정확도를 높인다.
        entry = {"apt_name": apt_name, "district": district, "address": addr, "dong": umd,
                 "lat": None, "lng": None,
                 "nearest_station": None, "nearest_station_m": None,
                 "stations_within_1km": 0}

        if provider == "kakao":
            coords = geocode_kakao(session, kakao_key, addr, district, apt_name)
        else:
            # OSM: 단지명 → 지번주소 → 법정동 순으로 시도
            queries = [f"{apt_name}, {district}, 서울"]
            if addr:
                queries.append(addr)
            if umd:
                queries.append(f"{umd}, {district}, 서울")   # 최후: 동 중심 (오차 큼)
            coords = geocode_osm(session, queries)

        if coords is None:
            print(f"  ✗ 좌표 실패: {district} {apt_name} ({addr})")
            cache[cache_key] = entry
            fail += 1
            continue

        lat, lng = coords
        entry["lat"], entry["lng"] = lat, lng
        name, dist_m, within = nearest_station(lat, lng, stations)
        entry["nearest_station"] = name
        entry["nearest_station_m"] = dist_m
        entry["stations_within_1km"] = within

        st = f"{name} {dist_m}m" if name else "역 없음(1.5km)"
        print(f"  ✓ {district} {apt_name}: {st}")
        cache[cache_key] = entry
        ok += 1

    CACHE.parent.mkdir(parents=True, exist_ok=True)
    CACHE.write_text(json.dumps(cache, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n완료: 신규 {ok}, 실패 {fail}, 스킵 {skip} → {CACHE}")
    print("이제 python build_data.py 를 다시 실행하면 교통 축이 반영됩니다.")


if __name__ == "__main__":
    main()
