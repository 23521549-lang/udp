"""``udp-openfeature`` — provider OpenFeature của UDP cho Python (§6.8).

Chỉ xuất bề mặt ứng dụng khách dùng: provider, hook nhãn ``ff`` và store theo request.
Middleware đo lường ở ``udp_openfeature.metrics`` (cần ``prometheus-client`` — extra ``metrics``).
Transport, parser SSE, cache và lõi đánh giá là chi tiết hiện thực, không là cam kết semver.
"""

import logging

from .labels import RequestLabels, UDPRequestLabelHook, request_store
from .provider import UDPFeatureFlagProvider

# Thư viện không tự in log: chẩn đoán im lặng tới khi ứng dụng cấu hình logging (§6.8)
logging.getLogger("udp_openfeature").addHandler(logging.NullHandler())

__all__ = ["RequestLabels", "UDPFeatureFlagProvider", "UDPRequestLabelHook", "request_store"]
