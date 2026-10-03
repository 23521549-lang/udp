# Golden Path (§11.1) — build nhiều tầng: tầng chạy chỉ có môi trường ảo đã cài và mã ứng dụng.
# Image nền ghim digest (tag để đọc): tag đẩy đè được. UDP cập nhật digest theo bản vá của Python 3.12.
FROM python:3.12.15-slim@sha256:29113dcae7aad06daa8e95260fa09f27d62be33b9687ea3774f771d601a02256 AS build
RUN python -m venv /venv
COPY requirements.txt ./
RUN /venv/bin/pip install --no-cache-dir -r requirements.txt

FROM python:3.12.15-slim@sha256:29113dcae7aad06daa8e95260fa09f27d62be33b9687ea3774f771d601a02256
ENV PATH=/venv/bin:$PATH PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY --from=build /venv /venv
COPY app ./app
USER nobody
EXPOSE 3000
# uvicorn chạy phần tắt của lifespan khi nhận SIGTERM — provider gửi nốt số đếm về UDP
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "3000"]
