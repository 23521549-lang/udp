"""Tiến trình con của phép kiểm CHÉO NGÔN NGỮ với Service 2 THẬT (§6.8, I15c, I26).

Test Node ``packages/openfeature-provider/tests/python-parity.test.ts`` dựng Service 2 + dữ liệu
thật, chạy file này với ``<host> <server-key>``, rồi hỏi qua stdin/stdout — mỗi dòng một JSON:

- ``{"op": "state"}`` ⇒ version đã áp, ``config_hash`` của cache, số lần mở stream, tập tracked;
- ``{"op": "eval", "key": k, "contexts": [...]}`` ⇒ kết quả của ``get_string_details`` qua SDK
  OpenFeature THẬT, chiếu xuống mặt phẳng OFREP như hàm ``visible`` của bản Node;
- ``{"op": "quit"}``.

Dòng đầu tiên ``{"ready": true}`` khi ``set_provider_and_wait`` xong. Mọi JSON là ASCII.
"""

from __future__ import annotations

import json
import sys
from typing import Any

from openfeature import api
from openfeature.evaluation_context import EvaluationContext
from openfeature.exception import ErrorCode
from openfeature.flag_evaluation import FlagEvaluationDetails

from udp_openfeature import UDPFeatureFlagProvider
from udp_openfeature._internals import ProviderInternals, with_internals
from udp_openfeature.cancel import Cancel
from udp_openfeature.evaluator import config_hash_of
from udp_openfeature.store import ConfigStore
from udp_openfeature.transport import ConfigResult, HttpTransport, StatsPostResult, StreamOpen


class CountingTransport:
    """Transport thật, đếm số lần mở stream — I15c đòi KHÔNG một lần RESYNC."""

    def __init__(self, inner: HttpTransport) -> None:
        self._inner = inner
        self.stream_opens = 0

    def get_config(self, if_none_match: str | None, cancel: Cancel) -> ConfigResult:
        return self._inner.get_config(if_none_match, cancel)

    def open_stream(self, since: int | None, cancel: Cancel) -> StreamOpen:
        self.stream_opens += 1
        return self._inner.open_stream(since, cancel)

    def post_stats(self, report: dict[str, Any], cancel: Cancel) -> StatsPostResult:
        return self._inner.post_stats(report, cancel)


def visible(details: FlagEvaluationDetails[Any]) -> dict[str, Any]:
    """Chiếu kết quả của SDK xuống mặt phẳng OFREP (§13.3 I26) — cùng ``visible`` của test Node."""
    if details.error_code is not None:
        code = "FLAG_NOT_FOUND" if details.error_code == ErrorCode.FLAG_NOT_FOUND else "GENERAL"
        return {"reason": "ERROR", "errorCode": code}
    if details.reason == "DISABLED":
        archived = details.flag_metadata.get("archived") is True
        return {"reason": "DISABLED", "archived": True} if archived else {"reason": "DISABLED"}
    out: dict[str, Any] = {"reason": str(details.reason), "value": details.value}
    if details.variant is not None:
        out["variant"] = details.variant
    return out


def context_of(raw: dict[str, Any]) -> EvaluationContext:
    attributes = dict(raw)
    key = attributes.get("targetingKey")
    if isinstance(key, str):
        del attributes["targetingKey"]
        return EvaluationContext(targeting_key=key, attributes=attributes)
    return EvaluationContext(attributes=attributes)


def reply(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def main(host: str, sdk_key: str) -> None:
    store = ConfigStore()
    transport = CountingTransport(HttpTransport(host, sdk_key))
    provider = with_internals(
        ProviderInternals(transport=transport, store=store, sync={"backoff_min_ms": 100}),
        lambda: UDPFeatureFlagProvider(host, sdk_key, polling_interval_ms=1_000),
    )
    api.set_provider_and_wait(provider)
    client = api.get_client()
    reply({"ready": True})
    for line in sys.stdin:
        cmd = json.loads(line)
        if cmd["op"] == "quit":
            break
        if cmd["op"] == "state":
            snapshot = store.snapshot
            reply(
                {
                    "version": provider.config_version,
                    "hash": None if snapshot is None else config_hash_of(snapshot),
                    "streamOpens": transport.stream_opens,
                    "tracked": sorted(provider.tracked_flags),
                }
            )
        elif cmd["op"] == "eval":
            results = [
                visible(client.get_string_details(cmd["key"], "code-default", context_of(c))) for c in cmd["contexts"]
            ]
            reply({"results": results})
    api.shutdown()


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
