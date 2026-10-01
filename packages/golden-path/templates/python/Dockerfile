# Golden Path (§11.1) — build nhiều tầng: tầng chạy chỉ có môi trường ảo đã cài và mã ứng dụng.
# Image nền ghim digest (tag để đọc): tag đẩy đè được. UDP cập nhật digest theo bản vá của Python 3.12.
FROM python:3.12.14-slim@sha256:f77ac9e44ae96ef2c90b8053ea08c31f8be030f824196b0ae4db6d462c84e51f AS build
RUN python -m venv /venv
COPY requirements.txt ./
RUN /venv/bin/pip install --no-cache-dir -r requirements.txt

FROM python:3.12.14-slim@sha256:f77ac9e44ae96ef2c90b8053ea08c31f8be030f824196b0ae4db6d462c84e51f
ENV PATH=/venv/bin:$PATH PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY --from=build /venv /venv
COPY app ./app
USER nobody
EXPOSE 3000
# uvicorn chạy phần tắt của lifespan khi nhận SIGTERM — provider gửi nốt số đếm về UDP
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "3000"]
