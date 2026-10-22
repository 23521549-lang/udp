"""Feature flag của UDP — thiết lập MỘT LẦN khi ứng dụng khởi động (Golden Path §11.1).

- ``UDP_FLAG_HOST``, ``UDP_SDK_KEY``: địa chỉ Service 2 và SERVER key của environment (trang SDK keys
  trên Portal). Không truyền project id: key đã mang project và environment.
- Service 2 không tới được hay khoá bị từ chối: ứng dụng VẪN chạy và trả giá trị mặc định trong code;
  provider tiếp tục thử nền và phát READY khi có cấu hình.
- Hook gắn nhãn ``ff`` do provider TỰ gắn — không có bước cài hook nào ở đây.
"""

from __future__ import annotations

import logging
import os
from collections.abc import Mapping

from openfeature import api
from openfeature.contrib.hook.opentelemetry import TracingHook
from openfeature.exception import OpenFeatureError
from udp_openfeature import UDPFeatureFlagProvider

log = logging.getLogger(__name__)


def start_feature_flags(env: Mapping[str, str] = os.environ) -> None:
    # Span chuẩn OTel semconv — có tác dụng khi ứng dụng cấu hình OpenTelemetry SDK
    api.add_hooks([TracingHook()])
    host, sdk_key = env.get("UDP_FLAG_HOST"), env.get("UDP_SDK_KEY")
    if not host or not sdk_key:
        log.warning("Thiếu UDP_FLAG_HOST hoặc UDP_SDK_KEY — mọi flag trả giá trị mặc định trong code")
        return
    try:
        api.set_provider_and_wait(UDPFeatureFlagProvider(host, sdk_key))
    except OpenFeatureError as err:
        log.warning("UDP flags chưa sẵn sàng — chạy với giá trị mặc định: %s", err)


def stop_feature_flags() -> None:
    """Đóng provider — gửi nốt số đếm đánh giá về UDP (có hạn, không treo lúc tắt)."""
    api.shutdown()
