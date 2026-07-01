"""
Flask 웹 대시보드 백엔드
미리 계산된 JSON 파일을 서빙 (빠른 시작)
"""

import json
import logging
from pathlib import Path
from flask import Flask, jsonify, render_template

app = Flask(__name__)
log = logging.getLogger(__name__)

DATA_DIR = Path(__file__).parent.parent / "data" / "processed"


def _load(name: str) -> dict:
    return json.loads((DATA_DIR / name).read_text(encoding="utf-8"))


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/quality")
def api_quality():
    return jsonify(_load("quality.json"))


@app.route("/api/pipeline")
def api_pipeline():
    return jsonify(_load("pipeline.json"))


@app.route("/api/timeseries")
def api_timeseries():
    return jsonify(_load("timeseries.json"))


@app.route("/api/mdd_ranking")
def api_mdd_ranking():
    return jsonify(_load("mdd_ranking.json"))


@app.route("/api/traits")
def api_traits():
    return jsonify(_load("traits.json"))


@app.route("/api/composite_score")
def api_composite_score():
    return jsonify(_load("composite_score.json"))


if __name__ == "__main__":
    import os
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
