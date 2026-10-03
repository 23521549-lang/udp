# Repo có Dockerfile ⇒ UDP build bằng BuildKit (chiến lược auto). Image nền ghim digest.
FROM alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6
RUN mkdir -p /www && printf ok > /www/healthz && adduser -D -u 10001 app
USER app
EXPOSE 8080
CMD ["httpd", "-f", "-p", "8080", "-h", "/www"]
