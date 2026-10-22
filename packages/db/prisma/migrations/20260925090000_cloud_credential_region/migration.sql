-- [v4.11] Region đích của credential cloud (Plan #26 P6).
--
-- Mỗi Cloud Adapter phục vụ MỘT region (STS vùng, API GKE theo location, hạn mức IP
-- của Azure theo location), nên `validate`/`preflight` của một credential không có
-- region thì không gọi được adapter nào. Spec v2 bỏ sót điều này; nhật ký review P6.
--
-- Region đi cùng credential chứ không cùng project: cấu hình cloud của project là
-- (provider, region, credential), thay cả bộ trong MỘT lần `PUT /cloud`.
--
-- Hàng có sẵn (chỉ có ở môi trường dev/test — trước Plan #26 chưa có đường ghi nào
-- cho bảng này) nhận region Singapore của đúng provider, khớp region mặc định của
-- hạ tầng dev. Thứ tự: cột NULL → backfill → NOT NULL → CHECK.
--
-- Đường lùi:
--   ALTER TABLE cloud_credentials DROP CONSTRAINT cloud_credentials_region_format;
--   ALTER TABLE cloud_credentials DROP COLUMN region;

ALTER TABLE "cloud_credentials" ADD COLUMN "region" VARCHAR(64);

UPDATE "cloud_credentials"
   SET "region" = CASE "provider"
                    WHEN 'AWS' THEN 'ap-southeast-1'
                    WHEN 'GCP' THEN 'asia-southeast1'
                    ELSE 'southeastasia'
                  END
 WHERE "region" IS NULL;

ALTER TABLE "cloud_credentials" ALTER COLUMN "region" SET NOT NULL;

-- Cùng luật với `cloudRegionSchema` của `@udp/shared-types/cloud-api`
ALTER TABLE "cloud_credentials"
  ADD CONSTRAINT "cloud_credentials_region_format"
  CHECK ("region" ~ '^[a-z][a-z0-9-]{1,62}$');
