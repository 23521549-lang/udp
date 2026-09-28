# Golden Path (§11.1) — build nhiều tầng: tầng chạy chỉ có môi trường ảo đã cài và mã ứng dụng.
FROM python:3.12-slim AS build
RUN python -m venv /venv
COPY requirements.txt ./
RUN /venv/bin/pip install --no-cache-dir -r requirements.txt

FROM python:3.12-slim
ENV PATH=/venv/bin:$PATH PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY --from=build /venv /venv
COPY app ./app
USER nobody
EXPOSE 3000
# uvicorn chạy phần tắt của lifespan khi nhận SIGTERM — provider gửi nốt số đếm về UDP
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "3000"]
