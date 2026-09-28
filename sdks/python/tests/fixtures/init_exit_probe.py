"""Tiến trình con: Service 2 không tới được ⇒ init NÉM sau hạn, rồi tiến trình THOÁT dù quên
``shutdown()`` — mọi luồng nền của provider là daemon (vai ``unref`` của bản Node)."""

from openfeature import api
from openfeature.exception import OpenFeatureError

from udp_openfeature import UDPFeatureFlagProvider

provider = UDPFeatureFlagProvider("http://127.0.0.1:9", "udp_sk_probe", init_timeout_ms=300)
try:
    api.set_provider_and_wait(provider)
    print("init resolved")
except OpenFeatureError:
    print("init rejected", flush=True)
