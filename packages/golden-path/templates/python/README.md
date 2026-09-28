# golden-path-app

Dịch vụ Python sinh từ Golden Path của UDP: FastAPI, feature flag qua `UDPFeatureFlagProvider`
(đánh giá tại chỗ, nhãn `ff` tự gắn), `/metrics` cho Prometheus, pipeline báo deploy về UDP.

## Chạy ở máy

```bash
python -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt
pytest -q
UDP_FLAG_HOST=<địa chỉ Service 2> UDP_SDK_KEY=<SERVER key> uvicorn app.main:app --reload --port 3000
```

Thiếu `UDP_FLAG_HOST`/`UDP_SDK_KEY` thì ứng dụng vẫn chạy, mọi flag trả giá trị mặc định trong code.

## Triển khai

1. Tạo secret trong namespace của environment:
   `kubectl -n <namespace> create secret generic golden-path-app-udp --from-literal=host=<địa chỉ Service 2> --from-literal=sdkKey=<SERVER key>`
2. `kubectl -n <namespace> apply -f k8s/` — lần đầu image là `bootstrap`, pod chờ tới lần deploy đầu.
3. Đẩy code: pipeline test, build, đẩy image rồi báo UDP; UDP áp image vào workload
   `golden-path-app` và gắn nhãn phiên bản mà `service.version` trên metric đọc.

## Ba điều kiện để rollout mức flag chạy

- Middleware đo bọc ứng dụng nghiệp vụ (`app/main.py`), `/healthz` và `/metrics` nằm ngoài nó.
- Provider là `UDPFeatureFlagProvider` (`app/telemetry.py`).
- `OTEL_SERVICE_NAME` bằng tên workload và `service.version` theo image (`k8s/deployment.yaml`).
