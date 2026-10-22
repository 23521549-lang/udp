-- ============================================================
-- [v4.12, Plan #61 61d-2a] Đổi tool CI thì Trusted Deploy về "chờ token đầu" — cưỡng chế ở tầng database.
--
-- `domain_configs.oidc_required` chỉ có nghĩa CHO MỘT NHÀ CUNG CẤP: issuer, tên claim, và cách pipeline
-- xin token đều khác nhau giữa GitHub, GitLab và CircleCI, và ba CI chạy trong cụm thì chưa khả dụng tới
-- 61d-2b. Một project bật cờ từ GitHub rồi đổi sang Jenkins mà cờ còn nguyên sẽ **chắc chắn** tắc: mọi
-- webhook 401, không deploy được gì, kể cả lượt rollback — và đó là một trạng thái chỉ sửa được bằng tay
-- trong database.
--
-- Vì sao một TRIGGER chứ không một dòng trong `replaceDomains`:
--
--  1. `replaceDomains` không phải đường ghi duy nhất của hàng CICD. `cicd.service.ts` ghi trực tiếp
--     (`domainConfig.update`) cho secret webhook, và đợt này thêm một đường nữa cho chính cờ này. Luật
--     đặt trong một đường ghi là luật mà mọi đường ghi TƯƠNG LAI phải nhớ làm lại.
--  2. Nếu đặt trong mã, phép kiểm tương ứng cũng là một test gọi đúng đường đó — tức khẳng định hiện
--     trạng, không khẳng định ý đồ. Đây đúng là bài học mà `20260909100000_writer_rule_triggers` đã ghi
--     lại: "một bất biến khẳng định hiện trạng thay vì khẳng định ý đồ".
--  3. Chiều an toàn: trigger chỉ bao giờ HẠ cờ xuống `false`, không bao giờ bật nó. Nó không thể làm một
--     project yếu đi một cách bất ngờ — chỉ đưa về trạng thái "chờ token hợp lệ đầu tiên của tool mới",
--     và lần token đầu đó sẽ tự bật lại.
--
-- Không chạm `updated_at`: Prisma `@updatedAt` tự đặt nó ở lượt ghi, trigger chỉ sửa một cột.
--
-- ĐƯỜNG LÙI (dán chạy được):
--   DROP TRIGGER IF EXISTS trg_domain_configs_oidc_reset ON "domain_configs";
--   DROP FUNCTION IF EXISTS udp_reset_oidc_required_on_tool_change();
-- ============================================================

CREATE FUNCTION udp_reset_oidc_required_on_tool_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.selected_tool IS DISTINCT FROM OLD.selected_tool THEN
    NEW.oidc_required := false;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER trg_domain_configs_oidc_reset
  BEFORE UPDATE ON "domain_configs"
  FOR EACH ROW
  EXECUTE FUNCTION udp_reset_oidc_required_on_tool_change();
