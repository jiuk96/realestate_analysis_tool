"""
서울시 재개발·재건축 정비구역(사업장) 목록 수집 → data/processed/zones_raw.json
─────────────────────────────────────────────────────
'공덕8구역'처럼 실제 정비사업 구역 단위 분석(빌라 탭 개편)의 원천 데이터.

수집 경로 2중화 (둘 중 되는 쪽 사용):
  A. 서울 열린데이터광장 Open API (OA-2253 계열) — SEOUL_API_KEY 필요.
     서비스명이 문서마다 달라 후보들을 프로브하고 응답 head를 로그로 남긴다.
  B. 정비사업 정보몽땅(cleanup.seoul.go.kr) 공개 사업장검색 페이지 파싱 — 키 불필요.
     서울시가 정보공개 목적으로 운영하는 공개 목록이다.

⚠️ 로컬 프록시 환경에서는 두 경로 모두 막혀 있어 GitHub Actions에서 실행해야 한다.
실패 시 기존 zones_raw.json을 보존한다(best-effort).
"""

import json
import os
import re
import sys
import time
from datetime import date
from pathlib import Path

import requests

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

ROOT = Path(__file__).parent
OUT = ROOT / "data" / "processed" / "zones_raw.json"

SEOUL_KEY = os.environ.get("SEOUL_API_KEY", "").strip()

# ── A. 열린데이터광장: 서비스명 후보 프로브 ──────────────────
API_CANDIDATES = [
    "ViewJtBuild",              # 재개발재건축 사업현황으로 알려진 이름 후보
    "CleanupBsnssttus",
    "SearchRenewalBizInfo",
    "OaJtBuildInfo",
]


def try_open_api() -> list | None:
    if not SEOUL_KEY:
        print("[A] SEOUL_API_KEY 없음 — 열린데이터광장 경로 건너뜀 (정보몽땅 폴백 사용)")
        return None
    for svc in API_CANDIDATES:
        url = f"http://openapi.seoul.go.kr:8088/{SEOUL_KEY}/json/{svc}/1/5/"
        try:
            r = requests.get(url, timeout=20)
            head = r.text[:220].replace("\n", " ")
            print(f"[A 프로브] {svc}: HTTP {r.status_code} / {head}")
            j = r.json()
            if svc in j and "row" in j.get(svc, {}):
                # 성공 — 전체 페이지 수집 (1000행씩)
                rows, start = [], 1
                total = int(j[svc].get("list_total_count", 0))
                while start <= total:
                    rr = requests.get(
                        f"http://openapi.seoul.go.kr:8088/{SEOUL_KEY}/json/{svc}/{start}/{start+999}/",
                        timeout=30).json()
                    rows.extend(rr.get(svc, {}).get("row", []))
                    start += 1000
                    time.sleep(0.2)
                print(f"[A] ✅ {svc} 사용 — {len(rows)}건")
                return [_norm_api_row(x) for x in rows]
        except Exception as e:
            print(f"[A 프로브] {svc} 실패: {e}")
    print("[A] 열린데이터광장 후보 전부 실패 — 위 로그의 서비스명 안내(resultCode)를 확인하면 정확한 이름을 알 수 있음")
    return None


def _pick(d: dict, *keys, default=""):
    for k in keys:
        for kk in d:
            if kk.upper() == k.upper():
                v = d[kk]
                return str(v).strip() if v is not None else default
    return default


def _norm_api_row(x: dict) -> dict:
    return {
        "name": _pick(x, "BSNS_NM", "SBSN_NM", "BIZ_NM", "NM", "SAUP_NM"),
        "gu": _pick(x, "SIGNGU_NM", "GU_NM", "AUTONOMOUS_GU", "CGG_NM"),
        "type": _pick(x, "BSNS_TY_NM", "BIZ_TY", "SAUP_SE", "TY_NM"),
        "stage": _pick(x, "PROGRS_STTUS", "STEP_NM", "PRGS_STTUS", "STTUS"),
        "addr": _pick(x, "LOC", "ADRES", "ADDR", "POSITION", "LC"),
        "src": "openapi",
        "raw": x,
    }


# ── B. 정비몽땅 사업장검색 파싱 ─────────────────────────────
CLEANUP_URL = "https://cleanup.seoul.go.kr/cleanup/bsnssttus/lscrMainIndx.do"
_TAG = re.compile(r"<[^>]+>")


def try_cleanup_scrape() -> list | None:
    sess = requests.Session()
    sess.headers.update({"User-Agent": "Mozilla/5.0 (compatible; seoul-apt-tool/1.0; public-data)"})
    zones, page = [], 1
    while page <= 120:   # 안전 상한
        try:
            r = sess.get(CLEANUP_URL, params={"cpage": page, "pageSize": 100}, timeout=30)
        except Exception as e:
            print(f"[B] {page}페이지 요청 실패: {e}")
            break
        if r.status_code != 200:
            print(f"[B] HTTP {r.status_code} — head: {r.text[:200]}")
            break
        html = r.text
        if page == 1:
            # 구조 진단용: 첫 테이블 행 원문 일부를 로그로
            m = re.search(r"<tbody.*?</tbody>", html, re.S)
            print(f"[B 진단] 1페이지 tbody 존재: {bool(m)} / 문서길이 {len(html)}")
            if m:
                print("[B 진단] 행 샘플:", _TAG.sub(" ", m.group(0)[:600]).split())
        rows = re.findall(r"<tr[^>]*>(.*?)</tr>", html, re.S)
        got = 0
        for tr in rows:
            tds = [_TAG.sub("", td).strip() for td in re.findall(r"<td[^>]*>(.*?)</td>", tr, re.S)]
            tds = [re.sub(r"\s+", " ", t) for t in tds if t is not None]
            if len(tds) < 4:
                continue
            # 상세(사업개요) 페이지로 가는 링크/onclick도 함께 수집 — 용적률·세대수 확장용
            links = re.findall(r"""(?:href|onclick)=["']([^"']+)["']""", tr)
            links = [l for l in links if l and l not in ("#", "#none", "javascript:;")]
            rec = {"cols": tds, "links": links[:4], "src": "cleanup"}
            zones.append(rec)
            got += 1
        print(f"[B] {page}페이지: 행 {got}개 (누적 {len(zones)})")
        if got == 0:
            break
        page += 1
        time.sleep(0.4)
    if not zones:
        return None

    # ── 상세(사업개요) 페이지 구조 진단: 첫 3개의 링크를 열어 '용적률' 주변 텍스트를 로그 ──
    # (파서를 정확히 짜기 위한 1회성 정찰 — 구조 확인 후 전수 수집 파서를 붙인다)
    probed = 0
    for z in zones:
        if probed >= 3:
            break
        for l in z.get("links", []):
            url = None
            if l.startswith("http"):
                url = l
            elif l.startswith("/"):
                url = "https://cleanup.seoul.go.kr" + l
            elif ".do" in l:
                m = re.search(r"['\"]?(/[\w/]+\.do[^'\"]*)", l)
                if m:
                    url = "https://cleanup.seoul.go.kr" + m.group(1)
            if not url:
                continue
            try:
                r = sess.get(url, timeout=20)
                txt = re.sub(r"\s+", " ", _TAG.sub(" ", r.text))
                i = txt.find("용적률")
                print(f"[B 상세정찰] {z['cols'][3][:20]} → {url[:90]} HTTP {r.status_code}")
                print(f"  '용적률' 주변: {txt[max(0, i-120):i+200] if i >= 0 else '(용적률 텍스트 없음) ' + txt[:200]}")
                probed += 1
            except Exception as e:
                print(f"[B 상세정찰] {url[:90]} 실패: {e}")
            break

    return [_norm_cleanup_row(z) for z in zones]


_GU = re.compile(r"(\S+구)$|^(\S+구)\b")


def _norm_cleanup_row(z: dict) -> dict:
    c = z["cols"]
    # 정비몽땅 사업장검색 목록은 고정 10컬럼(2026-07 실측):
    # [번호, 자치구, 사업구분, 사업장명, 위치(동 지번), 진행단계, 공개건수, %, %, 링크]
    if len(c) >= 6 and c[0].isdigit() and c[1].endswith("구"):
        return {"name": c[3], "gu": c[1], "type": c[2], "stage": c[5],
                "addr": c[4], "src": "cleanup", "raw": c, "links": z.get("links", [])}
    # 구조가 바뀌었을 때의 휴리스틱 폴백
    gu = next((t for t in c if re.fullmatch(r"\S{1,5}구", t)), "")
    typ = next((t for t in c if any(k in t for k in ("재개발", "재건축", "도시환경", "주거환경", "가로주택", "모아", "리모델링"))), "")
    stage = next((t for t in c if any(k in t for k in ("구역지정", "추진위원회", "조합설립인가", "시행인가", "관리처분", "착공", "준공", "기본계획", "안전진단", "해산", "수립"))), "")
    rest = [t for t in c if t not in (gu, typ, stage) and not t.isdigit()]
    name = max(rest, key=len) if rest else ""
    return {"name": name, "gu": gu, "type": typ, "stage": stage, "addr": "", "src": "cleanup", "raw": c}


def main() -> int:
    zones = try_open_api()
    if zones is None:
        zones = try_cleanup_scrape()
    if not zones:
        print("정비구역 수집 실패 — 기존 zones_raw.json 유지. 위 진단 로그를 확인하세요.")
        return 0

    # 정리: 이름 있는 것만, 중복 제거
    seen, out = set(), []
    for z in zones:
        if not z["name"] or len(z["name"]) < 2:
            continue
        key = (z["gu"], z["name"])
        if key in seen:
            continue
        seen.add(key)
        out.append(z)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        "updated": date.today().isoformat(),
        "n": len(out),
        "zones": out,
    }, ensure_ascii=False), encoding="utf-8")
    print(f"✅ 정비구역 {len(out)}건 저장 → {OUT}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        print(f"정비구역 수집 예외: {e}")
        sys.exit(0)
