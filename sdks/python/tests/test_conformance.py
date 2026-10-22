"""I26 giữa hai ngôn ngữ (§6.8): bản Python chạy qua ĐÚNG tệp vector mà lõi Node sinh ra.

Tệp là đầu ra của ``packages/flag-evaluator/scripts/conformance.ts``, và
``packages/flag-evaluator/tests/conformance.test.ts`` giữ nó không trôi khỏi mã Node — nên xanh
ở đây nghĩa là bản Python khớp bản Node đang chạy, không phải khớp một bản chép tay.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from udp_openfeature.constants import (
    PROVIDER,
    SDK_STATS_REPORT,
    SSE,
    STATS_VARIANT_DISABLED,
    STATS_VARIANT_ERROR,
)
from udp_openfeature.evaluator import (
    EVALUATOR_SEMANTICS_VERSION,
    TOTAL_BUCKETS,
    apply_delta,
    bucket_of,
    canonical_json,
    config_hash_of,
    evaluate,
    parse_sdk_delta,
    prepare_snapshot,
)
from udp_openfeature.evaluator.conditions import REGEX_INPUT_MAX, regex_syntax_issue

VECTORS_PATH = Path(__file__).resolve().parents[3] / "packages" / "flag-evaluator" / "conformance" / "vectors.json"
VECTORS: dict[str, Any] = json.loads(VECTORS_PATH.read_text(encoding="utf-8"))

VISIBLE = ("reason", "value", "variant", "errorCode", "ruleId", "archived")


def test_hang_so_khop_ban_node() -> None:
    assert VECTORS["version"] == 1
    assert VECTORS["semanticsVersion"] == EVALUATOR_SEMANTICS_VERSION
    assert VECTORS["totalBuckets"] == TOTAL_BUCKETS
    assert VECTORS["regexInputMax"] == REGEX_INPUT_MAX


def test_mac_dinh_cua_provider_giong_het_ban_node() -> None:
    defaults = VECTORS["defaults"]
    assert dict(SSE) == defaults["sse"]
    assert dict(PROVIDER) == defaults["provider"]
    assert dict(SDK_STATS_REPORT) == defaults["sdkStatsReport"]
    assert (
        defaults["statsVariant"]["disabled"],
        defaults["statsVariant"]["error"],
    ) == (STATS_VARIANT_DISABLED, STATS_VARIANT_ERROR)


@pytest.mark.parametrize("v", VECTORS["bucket"], ids=lambda v: f"{v['stickyValue']}|{v['flagKey']}")
def test_bucket(v: dict[str, Any]) -> None:
    assert bucket_of(v["stickyValue"], v["flagKey"], v["bucketSalt"]) == v["bucket"]


@pytest.mark.parametrize("v", VECTORS["canonicalJson"], ids=lambda v: v["json"][:40])
def test_canonical_json(v: dict[str, Any]) -> None:
    assert canonical_json(v["value"]) == v["json"]


@pytest.mark.parametrize("v", VECTORS["configHash"], ids=lambda v: v["hash"][:12])
def test_config_hash(v: dict[str, Any]) -> None:
    assert config_hash_of(v["snapshot"]) == v["hash"]


@pytest.mark.parametrize("v", VECTORS["evaluate"], ids=lambda v: v["name"])
def test_evaluate(v: dict[str, Any]) -> None:
    result = evaluate(prepare_snapshot(v["snapshot"]), v["flagKey"], v["context"], v.get("expectedType"))
    assert {k: result[k] for k in VISIBLE if k in result} == v["evaluation"]


def _regex_snapshot(pattern: str) -> dict[str, Any]:
    """Cùng hình snapshot mà ``regexVectors`` của bản Node dựng cho mỗi pattern."""
    rule = {
        "id": "rx",
        "type": "ATTRIBUTE_BASED",
        "condition": {"all": [{"attribute": "s", "operator": "regex", "value": pattern}]},
        "serve": {"kind": "variant", "variantKey": "on"},
        "bucketSalt": "salt-rx",
        "priority": 10,
    }
    flag = {
        "key": "f",
        "type": "BOOLEAN",
        "isEnabled": True,
        "stickinessAttribute": "targetingKey",
        "variants": {"on": True, "off": False},
        "defaultVariantKey": "off",
        "rules": [rule],
    }
    return {"flags": [flag], "segments": [], "trackedFlags": []}


@pytest.mark.parametrize("v", VECTORS["regex"], ids=lambda v: repr(v["pattern"]))
def test_regex(v: dict[str, Any]) -> None:
    assert (regex_syntax_issue(v["pattern"]) is not None) == v["rejected"]
    prepared = prepare_snapshot(_regex_snapshot(v["pattern"]))
    for text, expected in v["cases"]:
        reason = evaluate(prepared, "f", {"s": text})["reason"]
        got = "broken" if reason == "ERROR" else reason == "TARGETING_MATCH"
        assert got == expected, f"{v['pattern']!r} trên {text!r}"


def test_bo_sinh_regex_phu_ca_nhan_lan_bac() -> None:
    accepted = [v for v in VECTORS["regex"] if not v["rejected"]]
    outcomes = [c[1] for v in accepted for c in v["cases"]]
    assert len(accepted) >= 150
    assert outcomes.count(True) >= 100
    assert outcomes.count(False) >= 100


@pytest.mark.parametrize("v", VECTORS["delta"], ids=lambda v: v["name"])
def test_delta(v: dict[str, Any]) -> None:
    delta = parse_sdk_delta(v["delta"])
    assert delta is not None
    outcome = apply_delta(v["cache"]["snapshot"], v["cache"]["configVersion"], delta)
    expected = v["outcome"]
    assert outcome.kind == expected["kind"]
    if outcome.kind == "applied":
        assert outcome.snapshot is not None
        assert outcome.config_version == expected["configVersion"]
        assert config_hash_of(outcome.snapshot) == expected["hash"]
    if outcome.kind == "resync":
        assert outcome.reason == expected["reason"]
