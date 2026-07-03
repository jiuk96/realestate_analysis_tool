"""
네이버 부동산 단지 고유번호(complexNo) 수집
─────────────────────────────────────────────────────
분석 대상 단지(composite_score.json)를 네이버 부동산에서 검색해 단지 고유번호를
구하고 data/static/naver_ids.json 캐시로 저장한다. 이후 대시보드는 검색어가 아니라
이 번호로 단지 페이지(https://m.land.naver.com/complex/info/<no>)에 바로 연결한다.

실행: python resolve_naver_ids.py
  - 인증 토큰 불필요 (m.land 검색결과 페이지에서 /complex/info/<번호> 추출)
  - 네이버 접근이 필요하므로 GitHub Actions(인터넷 열림)에서 돌린다.
    (로컬/샌드박스에서 네이버가 막혀 있으면 전부 실패로 남고, 기존 캐시는 보존)
  - 재실행 시 이미 번호를 찾은 단지는 건너뜀 (증분 수집).
  - 실패해도 파이프라인을 막지 않는다 — 못 찾은 단지는 대시보드에서 검색 링크로 폴백.
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

# 모바일 UA로 접근해야 m.land가 모바일 검색결과(경량 HTML)를 준다.
UA = {
    "User-Agent": ("Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) "
                   "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 "
                   "Mobile/15E148 Safari/604.1"),
    "Referer": "https://m.land.naver.com/",
    "Accept-Language": "ko-KR,ko;q=0.9",
}

# 단지번호가 HTML/최종 URL에 나타나는 여러 형태를 모두 시도 (네이버가 마크업을
# 바꿔도 하나는 걸리도록 다중 패턴). 우선순위 순.
ID_PATTERNS = [
    re.compile(r"/complex/info/(\d{3,})"),          # 링크·리다이렉트 경로
    re.compile(r'["\']?hscpNo["\']?\s*[:=]\s*["\']?(\d{3,})'),
    re.compile(r'["\']?complexNo["\']?\s*[:=]\s*["\']?(\d{3,})'),
    re.compile(r"markerId['\"]?\s*[:=]\s*['\"]?(\d{3,})"),
]

ROMAN_MAP = {'Ⅰ': '1', 'Ⅱ': '2', 'Ⅲ': '3', 'Ⅳ': '4', 'Ⅴ': '5',
             'Ⅵ': '6', 'Ⅶ': '7', 'Ⅷ': '8', 'Ⅸ': '9', 'Ⅹ': '10'}


def clean_name(name: str) -> str:
    """대시보드 normalizeAptName과 동일 취지: 로마숫자 변환 + 괄호·동범위·쉼표 정리."""
    n = name
    for r, a in ROMAN_MAP.items():
        n = n.replace(r, a)
    n = re.sub(r"\([^)]*\)", "", n)
    n = re.sub(r"\d+동\s*~\s*\d+동", "", n)
    n = n.replace(",", " ")
    n = re.sub(r"\s+", " ", n).strip()
    return n


def search_terms(district: str, apt_name: str) -> list[str]:
    """검색 시도 순서: 이름만 → 구+이름 → 더 짧은 핵심어(뒤 숫자·차수 제거)."""
    name = clean_name(apt_name)
    terms = [name, f"{district} {name}"]
    # 뒤에 붙은 숫자/차수를 떼어 더 느슨하게 (예: 흑석한강센트레빌2 → 흑석한강센트레빌)
    core = re.sub(r"\s*\d+차?$", "", name).strip()
    if core and core != name:
        terms.append(core)
        terms.append(f"{district} {core}")
    # 중복 제거(순서 유지)
    seen, out = set(), []
    for t in terms:
        if t and t not in seen:
            seen.add(t)
            out.append(t)
    return out


def find_complex_no(session: requests.Session, term: str) -> str | None:
    """m.land 검색결과에서 단지 고유번호를 추출. 못 찾으면 None."""
    url = f"https://m.land.naver.com/search/result/{quote(term)}"
    try:
        r = session.get(url, headers=UA, timeout=12, allow_redirects=True)
    except Exception:
        return None
    if r.status_code != 200:
        return None
    # 1) 최종 URL이 단지 페이지로 리다이렉트된 경우 (단일 매칭)
    m = ID_PATTERNS[0].search(r.url)
    if m:
        return m.group(1)
    # 2) 본문에서 패턴 탐색 (검색결과 목록의 첫 단지)
    body = r.text
    for pat in ID_PATTERNS:
        m = pat.search(body)
        if m:
            return m.group(1)
    return None


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
    ok = fail = skip = 0
    for apt_name, district in targets:
        cache_key = f"{district}|{apt_name}"
        if cache.get(cache_key, {}).get("complex_no"):
            skip += 1
            continue

        found = None
        used_term = None
        for term in search_terms(district, apt_name):
            found = find_complex_no(session, term)
            time.sleep(0.4)   # 과도한 요청 방지
            if found:
                used_term = term
                break

        entry = {"apt_name": apt_name, "district": district,
                 "complex_no": found, "matched_term": used_term}
        cache[cache_key] = entry

        if found:
            print(f"  ✓ {district} {apt_name} → {found} (검색: {used_term})")
            ok += 1
        else:
            print(f"  ✗ {district} {apt_name}: 단지번호 못 찾음")
            fail += 1

    CACHE.parent.mkdir(parents=True, exist_ok=True)
    CACHE.write_text(json.dumps(cache, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n완료: 신규 {ok}, 실패 {fail}, 스킵 {skip} → {CACHE}")
    print("이제 python build_data.py 를 다시 실행하면 단지 링크에 반영됩니다.")


if __name__ == "__main__":
    main()
