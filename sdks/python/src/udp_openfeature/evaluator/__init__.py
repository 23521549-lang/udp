"""Lõi đánh giá của UDP cho Python — cùng ngữ nghĩa ``@udp/flag-evaluator`` (§6.5, I26).

Tương đương được KIỂM, không được hứa: ``tests/test_conformance.py`` chạy qua
``packages/flag-evaluator/conformance/vectors.json`` — tệp do chính lõi Node sinh ra.
"""

from .changefeed import (
    DeltaOutcome,
    apply_change,
    apply_delta,
    hash_verdict,
    parse_sdk_config,
    parse_sdk_delta,
)
from .evaluate import EVALUATOR_SEMANTICS_VERSION, evaluate, evaluate_all
from .hashing import TOTAL_BUCKETS, bucket_of, murmur3_32
from .prepare import PreparedSnapshot, prepare_snapshot
from .snapshot import canonical_json, config_hash_of, normalize_snapshot

__all__ = [
    "EVALUATOR_SEMANTICS_VERSION",
    "TOTAL_BUCKETS",
    "DeltaOutcome",
    "PreparedSnapshot",
    "apply_change",
    "apply_delta",
    "bucket_of",
    "canonical_json",
    "config_hash_of",
    "evaluate",
    "evaluate_all",
    "hash_verdict",
    "murmur3_32",
    "normalize_snapshot",
    "parse_sdk_config",
    "parse_sdk_delta",
    "prepare_snapshot",
]
