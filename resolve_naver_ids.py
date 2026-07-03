"""
네이버 부동산 단지 고유번호(complexNo) 수집 — v2
─────────────────────────────────────────────────────
분석 대상 단지(composite_score.json)를 네이버 부동산 검색 API로 찾아 단지
고유번호를 구하고 data/static/naver_ids.json 캐시로 저장한다. 이후 대시보드는
검색어가 아니라 이 번호로 단지 페이지(https://m.land.naver.com/complex/info/<no>)
에 바로 연결한다.

v1(HTML 검색결과 페이지에서 정규식으로 번호 추출)은 실전 GitHub Actions에서
거의 전부 실패했다 — m.land 검색결과 페이지가 더 이상 단지 링크를 그 형태로
내려주지 않는 것으로 보인다. v2는 네이버가 자체 웹앱(new.land.naver.com)에서
쓰는 JSON 검색 API를 직접 호출해 complexNo를 받는 방식으로 교체했다.

실행: python resolve_naver_ids.py
  - 인증 토큰 불필요, 검색 API는 공개 웹페이지가 호출하는 것과 동일한 엔드포인트
  - 네이버 접근이 필요하므로 GitHub Actions(인터넷 열림)에서 돌린다.
    (로컬/샌드박스에서 네이버가 막혀 있으면 전부 실패로 남고, 기존 캐시는 보존)
  - 재실행 시 이미 번호를 찾은 단지는 건너뜀 (증분 수집)
  - 실패해도 파이프라인을 막지 않는다 — 못 찾은 단지는 대시보드에서 검색 링크로 폴백
  - 시작 시 진단 검색 1건을 먼저 찍어 로그에 남긴다 — 이번에도 실패하면 그 로그의
    상태코드/응답 스니펫만 보고 바로 원인을 알 수 있게 하기 위함 (재실행 없이 디버깅)
"""

import json
import re
import time
import sys
from pathlib import Path
from urllib.parse import quote

import requests

ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT))

CACHE = ROOT / "data" / "static" / "naver_ids.json"
COMP = ROOT / "data" / "processed" / "composite_score.json"

DESKTOP_UA = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"),
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "ko-KR,ko;q=0.9",
    "Referer": "https://new.land.naver.com/complexes",
}
MOBILE_UA = {
    "User-Agent": ("Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) "
                   "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 "
                   "Mobile/15E148 Safari/604.1"),
    "Referer": "https://m.land.naver.com/",
    "Accept-Language": "ko-KR,ko;q=0.9",
}

ROMAN_MAP = {'Ⅰ': '1', 'Ⅱ': '2', 'Ⅲ': '3', 'Ⅳ': '4', 'Ⅴ': '5',
             'Ⅵ': '6', 'Ⅶ': '7', 'Ⅷ': '8', 'Ⅸ': '9', 'Ⅹ': '10'}


def clean_name(name: str) -> str:
    """로마숫자 변환 + 괄호·동범위·쉼표 정리 (대시보드 normalizeAptName과 동일 취지)."""
    n = name
    for r, a in ROMAN_MAP.items():
        n = n.replace(r, a)
    n = re.sub(r"\([^)]*\)", "", n)
    n = re.sub(r"\d+동\s*~\s*\d+동", "", n)
    n = n.replace(",", " ")
    n = re.sub(r"\s+", " ", n).strip()
    return n


def norm_for_match(name: str) -> str:
    """이름 매칭용 정규화: 공백·'아파트' 접미사·특수문자 제거, 소문자화."""
    n = clean_name(name)
    n = re.sub(r"[()\-·,]", "", n)
    n = n.replace(" ", "")
    n = re.sub(r"아파트$", "", n)
    return n.lower()


def search_terms(district: str, apt_name: str) -> list[str]:
    """검색 시도 순서: 이름만 → 뒤 숫자/차수 뗀 핵심어 → 구+이름."""
    name = clean_name(apt_name)
    core = re.sub(r"\s*\d+차?$", "", name).strip()
    terms = [name]
    if core and core != name:
        terms.append(core)
    terms.append(f"{district} {name}")
    seen, out = set(), []
    for t in terms:
        if t and t not in seen:
            seen.add(t)
            out.append(t)
    return out


# ── 방법 1: new.land.naver.com JSON 검색 API (주 방법) ────────────

def search_new_land(session: requests.Session, keyword: str, debug: bool = False) -> list[dict]:
    """네이버부동산 PC웹(new.land.naver.com)이 쓰는 검색 API. 단지 후보 목록 반환."""
    url = "https://new.land.naver.com/api/search"
    try:
        r = session.get(url, params={"keyword": keyword}, headers=DESKTOP_UA, timeout=12)
    except Exception as e:
        if debug:
            print(f"    [진단] new.land 요청 예외: {e}")
        return []
    if debug:
        print(f"    [진단] new.land status={r.status_code} body[:300]={r.text[:300]!r}")
    if r.status_code != 200:
        return []
    try:
        data = r.json()
    except Exception:
        return []
    complexes = data.get("complexes") or []
    return [{"complex_no": str(c.get("complexNo")), "name": c.get("complexName", "")}
            for c in complexes if c.get("complexNo")]


# ── 방법 2: m.land 검색결과 HTML (폴백) ─────────────────────────

ID_PATTERNS = [
    re.compile(r"/complex/info/(\d{3,})"),
    re.compile(r'["\']?hscpNo["\']?\s*[:=]\s*["\']?(\d{3,})'),
    re.compile(r'["\']?complexNo["\']?\s*[:=]\s*["\']?(\d{3,})'),
]


def search_mland_fallback(session: requests.Session, keyword: str) -> str | None:
    url = f"https://m.land.naver.com/search/result/{quote(keyword)}"
    try:
        r = session.get(url, headers=MOBILE_UA, timeout=12, allow_redirects=True)
    except Exception:
        return None
    if r.status_code != 200:
        return None
    m = ID_PATTERNS[0].search(r.url)
    if m:
        return m.group(1)
    for pat in ID_PATTERNS:
        m = pat.search(r.text)
        if m:
            return m.group(1)
    return None


def best_match(candidates: list[dict], apt_name: str) -> dict | None:
    """검색 후보 중 정규화된 이름이 가장 가까운 것을 고른다.
    엉뚱한 단지로 잘못 매칭되는 것을 막기 위해, 정확히 일치하거나 한쪽이
    다른 쪽을 포함하는 경우만 채택한다 (느슨한 유사도 매칭은 하지 않음)."""
    target = norm_for_match(apt_name)
    if not target:
        return None
    exact = [c for c in candidates if norm_for_match(c["name"]) == target]
    if exact:
        return exact[0]
    contains = [c for c in candidates
                if target in norm_for_match(c["name"]) or norm_for_match(c["name"]) in target]
    if contains:
        # 이름 길이가 target과 가장 가까운 후보 우선
        contains.sort(key=lambda c: abs(len(norm_for_match(c["name"])) - len(target)))
        return contains[0]
    return None


def resolve_one(session: requests.Session, district: str, apt_name: str,
                 debug: bool = False) -> tuple[str | None, str | None]:
    """(complex_no, matched_term) 반환. 못 찾으면 (None, None)."""
    for term in search_terms(district, apt_name):
        candidates = search_new_land(session, term, debug=debug)
        debug = False   # 진단 로그는 최초 1회만
        if candidates:
            m = best_match(candidates, apt_name)
            if m:
                return m["complex_no"], term
        time.sleep(0.3)

    # new.land가 전부 막혀 있거나 매칭 실패 시 m.land HTML로 폴백
    for term in search_terms(district, apt_name):
        found = search_mland_fallback(session, term)
        time.sleep(0.3)
        if found:
            return found, f"{term} (mland 폴백)"
    return None, None


def main():
    if not COMP.exists():
        print("composite_score.json 이 없습니다 — build_data.py 먼저 실행하세요.")
        return

    comp = json.loads(COMP.read_text(encoding="utf-8"))
    targets = [(r["apt_name"], r["district"]) for r in comp["ranking"]]

    cache: dict = {}
    if CACHE.exists():
        cache = json.loads(CACHE.read_text(encoding="utf-8"))

    session = requests.Session()

    # 진단: 흔히 존재하는 단지명으로 첫 요청의 원본 응답을 로그에 남겨,
    # 이번 방식도 막히면 재실행 없이 바로 원인(상태코드/응답 형태)을 알 수 있게 함
    print("[진단] new.land 검색 API 연결 테스트...")
    search_new_land(session, "래미안", debug=True)

    ok = fail = skip = 0
    for i, (apt_name, district) in enumerate(targets):
        cache_key = f"{district}|{apt_name}"
        if cache.get(cache_key, {}).get("complex_no"):
            skip += 1
            continue

        complex_no, used_term = resolve_one(session, district, apt_name, debug=(i == 0))
        cache[cache_key] = {"apt_name": apt_name, "district": district,
                             "complex_no": complex_no, "matched_term": used_term}

        if complex_no:
            print(f"  ✓ {district} {apt_name} → {complex_no} (검색: {used_term})")
            ok += 1
        else:
            print(f"  ✗ {district} {apt_name}: 단지번호 못 찾음")
            fail += 1

        # 25건마다 중간 저장 — 도중에 끊겨도 그동안 찾은 결과는 보존
        if (ok + fail) % 25 == 0:
            CACHE.parent.mkdir(parents=True, exist_ok=True)
            CACHE.write_text(json.dumps(cache, ensure_ascii=False, indent=2), encoding="utf-8")

    CACHE.parent.mkdir(parents=True, exist_ok=True)
    CACHE.write_text(json.dumps(cache, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n완료: 신규 {ok}, 실패 {fail}, 스킵 {skip} → {CACHE}")
    print("이제 python build_data.py 를 다시 실행하면 단지 링크에 반영됩니다.")


if __name__ == "__main__":
    main()
