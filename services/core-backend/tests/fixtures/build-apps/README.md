# Ứng dụng mẫu của job CI `build-smoke` (Plan #61)

Mỗi thư mục là một ứng dụng nhỏ nhất mà Buildpacks Paketo (hay Dockerfile) build được: nghe ở cổng `$PORT` (mặc định 8080) và trả `ok` ở `/healthz`. Job CI build từng thư mục bằng ĐÚNG đoạn shell mà pipeline GitHub Actions của UDP sinh
(`scripts/build-smoke.ts`), đẩy lên GHCR bằng `GITHUB_TOKEN`, rồi chạy image và gọi `/healthz`.
