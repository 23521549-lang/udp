# udp-openfeature — provider OpenFeature của UDP cho Python

Provider cho SERVER key (§6.8 của `docs/UDP_design.md`): tải snapshot, nhận delta qua SSE, đánh giá
TẠI CHỖ với cùng ngữ nghĩa lõi Node (`@udp/flag-evaluator`), fail-static khi mất kết nối, không bao giờ
ném ra ứng dụng. Nhãn `ff` theo request cho auto-rollback mức flag (§6.6).

## Dùng

```python
from openfeature import api
from openfeature.evaluation_context import EvaluationContext
from udp_openfeature import UDPFeatureFlagProvider

api.set_provider_and_wait(UDPFeatureFlagProvider("https://flags.udp.example", "udp_sk_…"))
client = api.get_client()
client.get_boolean_value("checkout-v2", False, EvaluationContext(targeting_key="user-42"))
```

Middleware đo lường (cần extra `metrics`):

```python
from udp_openfeature.metrics import UDPMetricsMiddleware, UDPMetricsWSGIMiddleware

app.add_middleware(UDPMetricsMiddleware)               # ASGI: FastAPI, Starlette
app.wsgi_app = UDPMetricsWSGIMiddleware(app.wsgi_app)  # WSGI: Flask
```

`OTEL_SERVICE_NAME` phải bằng `workloadName` của rollout; `OTEL_RESOURCE_ATTRIBUTES=service.version=<imageTag>`.

## Phát triển

```bash
python -m venv .venv
.venv/bin/pip install -e ".[dev]"      # Windows: .venv\Scripts\pip
ruff check . && ruff format --check . && mypy && pytest -q
```

Tương đương với lõi Node được kiểm bằng `packages/flag-evaluator/conformance/vectors.json` (sinh lại:
`pnpm --filter @udp/flag-evaluator conformance`) và bằng
`packages/openfeature-provider/tests/python-parity.test.ts` (Service 2 thật; cần `.venv` ở thư mục này).
