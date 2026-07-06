"""
서울 아파트 분양(청약) 공고 수집 — 한국부동산원 청약홈 API (공공데이터포털)

필요 키: APPLY_HOME_API_KEY
  공공데이터포털에서 「한국부동산원_주택청약 분양정보 조회 서비스」(ApplyhomeInfoDetailSvc)
  활용신청 후 발급되는 일반 인증키(Decoding)를 .env 또는 GitHub Secret에 등록.

키가 없거나 호출 실패 시 기존 data/processed/subscriptions.json을 그대로 두고 종료(best-effort).
"""

import json
import os
import sys
from datetime import date, timedelta
from pathlib import Path

import requests

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

API_KEY = os.environ.get("APPLY_HOME_API_KEY", "").strip()
OUT = Path("data/processed/subscriptions.json")
URL = "https://api.odcloud.kr/api/ApplyhomeInfoDetailSvc/v1/getAPTLttotPblancDetail"


def main() -> int:
    if not API_KEY:
        print("APPLY_HOME_API_KEY 미설정 — 청약 공고 수집을 건너뜁니다.")
        return 0

    # 최근 6개월 공고 중 서울, 접수 종료일이 지나지 않았거나 최근 30일 내인 것만
    since = (date.today() - timedelta(days=180)).strftime("%Y-%m-%d")
    keep_after = (date.today() - timedelta(days=30)).strftime("%Y-%m-%d")

    items, page = [], 1
    while page <= 10:
        r = requests.get(URL, params={
            "page": page, "perPage": 100, "serviceKey": API_KEY,
            "cond[SUBSCRPT_AREA_CODE_NM::EQ]": "서울",
            "cond[RCRIT_PBLANC_DE::GTE]": since,
        }, timeout=30)
        r.raise_for_status()
        data = r.json().get("data", [])
        if not data:
            break
        items.extend(data)
        page += 1

    out = []
    for x in items:
        if (x.get("RCEPT_ENDDE") or "") < keep_after:
            continue
        out.append({
            "name": x.get("HOUSE_NM"),
            "addr": x.get("HSSPLY_ADR"),
            "notice_date": x.get("RCRIT_PBLANC_DE"),
            "rcept_bgn": x.get("RCEPT_BGNDE"),
            "rcept_end": x.get("RCEPT_ENDDE"),
            "winner_date": x.get("PRZWNER_PRESNATN_DE"),
            "url": x.get("PBLANC_URL"),
        })
    out.sort(key=lambda x: x.get("rcept_bgn") or "", reverse=True)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        "updated": date.today().isoformat(),
        "items": out,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"✅ 서울 분양 공고 {len(out)}건 저장 → {OUT}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # best-effort: 실패해도 파이프라인은 계속
        print(f"청약 공고 수집 실패: {e}")
        sys.exit(0)
