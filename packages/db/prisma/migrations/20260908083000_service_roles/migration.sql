-- ============================================================
-- Ba Postgres role cưỡng chế ma trận writer của §1.2.
--
-- Đây là thứ v4 tuyên bố thay cho code review: "quy tắc một writer được
-- database cưỡng chế, có test I22". Không có migration này thì I22 và I30
-- vĩnh viễn không thể pass, và ma trận writer chỉ là một bảng trong tài liệu.
--
-- Role tạo NOLOGIN ở migration này. Quyền đăng nhập được cấp RIÊNG bằng
-- `pnpm db:service-login`, không phải ở đây: migration là file được commit và
-- chạy ở mọi môi trường, nên một ALTER ROLE ... PASSWORD trong đó là đưa
-- credential vào lịch sử kho mã vĩnh viễn.
--
-- [Cập nhật] Service 1 nay ĐÃ nối bằng `udp_s1` — xem services/core-backend/
-- src/core/db.ts và bất biến kiểm ở tests/service-identity.test.ts. Ma trận
-- writer không còn chỉ đúng bên trong SET ROLE của test.
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'udp_s1') THEN CREATE ROLE udp_s1 NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'udp_s2') THEN CREATE ROLE udp_s2 NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'udp_s3') THEN CREATE ROLE udp_s3 NOLOGIN; END IF;
END $$;

-- Cho user đang chạy migration làm thành viên của cả ba, để test I22/I30 dùng
-- được SET ROLE mà không cần cấp mật khẩu cho role nào.
DO $$
BEGIN
  EXECUTE format('GRANT udp_s1, udp_s2, udp_s3 TO %I', current_user);
END $$;

GRANT USAGE ON SCHEMA public TO udp_s1, udp_s2, udp_s3;

-- ------------------------------------------------------------
-- Service 1 — vòng đời project, credential, domain, provisioning
-- ------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON
  users, project_members, projects, cloud_credentials, domain_configs,
  capability_bindings, capability_preferences, provisioning_jobs, provisioned_resources
  TO udp_s1;

GRANT SELECT ON domain_catalog TO udp_s1, udp_s2, udp_s3;

-- environments: S1 ghi mọi cột TRỪ config_version và config_hash — hai cột đó
-- là của S2 (và của S3 trong nhánh kill-switch). Dựng danh sách cột động thay
-- vì liệt kê tay: thêm cột mới về sau sẽ tự vào đúng phía.
DO $$
DECLARE cols text;
BEGIN
  SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position) INTO cols
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'environments'
    AND column_name NOT IN ('config_version', 'config_hash');
  EXECUTE format('GRANT UPDATE (%s) ON public.environments TO udp_s1', cols);
END $$;
GRANT SELECT, INSERT, DELETE ON environments TO udp_s1;

-- rollout_sessions: S1 tạo hàng và ghi cột cấu hình; tám cột điều khiển là của S3.
DO $$
DECLARE cols text;
BEGIN
  SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position) INTO cols
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'rollout_sessions'
    AND column_name NOT IN ('status', 'current_traffic_percentage', 'fail_reason',
                            'last_decision', 'last_step_at', 'claimed_by',
                            'claimed_until', 'version');
  EXECUTE format('GRANT UPDATE (%s) ON public.rollout_sessions TO udp_s1', cols);
END $$;
GRANT SELECT, INSERT, DELETE ON rollout_sessions TO udp_s1;

-- S1 đọc bảng của S2 để hiển thị trên Portal.
GRANT SELECT ON
  feature_flags, flag_variants, flag_env_configs, flag_targeting_rules,
  segments, sdk_keys, flag_evaluation_stats, config_change_log
  TO udp_s1;

-- ------------------------------------------------------------
-- Service 2 — feature flag và đường lan truyền cấu hình
-- ------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON
  feature_flags, flag_variants, flag_env_configs, flag_targeting_rules,
  segments, sdk_keys, flag_evaluation_stats
  TO udp_s2;

GRANT SELECT ON projects, environments TO udp_s2;
GRANT UPDATE (config_version, config_hash) ON environments TO udp_s2;

-- ------------------------------------------------------------
-- Service 3 — reconciler rollout
-- ------------------------------------------------------------
GRANT SELECT ON
  projects, environments, domain_configs, capability_bindings,
  feature_flags, flag_variants, flag_env_configs, flag_targeting_rules,
  rollout_sessions
  TO udp_s3;

GRANT UPDATE (status, current_traffic_percentage, fail_reason, last_decision,
              last_step_at, claimed_by, claimed_until, version)
  ON rollout_sessions TO udp_s3;

-- Ngoại lệ kill-switch: ĐÚNG ba quyền, không hơn (§7.6, I30).
-- Thiếu quyền cấp version thì S3 ghi `serve` mà replica của S2 không bao giờ
-- thấy — kill-switch im lặng không có tác dụng. Đó là lý do quyền thứ hai và
-- thứ ba tồn tại, chứ không phải để tiện.
GRANT UPDATE (serve) ON flag_targeting_rules TO udp_s3;
GRANT UPDATE (config_version, config_hash) ON environments TO udp_s3;
GRANT INSERT ON config_change_log TO udp_s3;

-- S3 KHÔNG có quyền nào trên cloud_credentials, kể cả SELECT. Quyền vào cluster
-- đi qua endpoint nội bộ của S1 (ADR-06). Đây là điều I22 kiểm ngược.

-- ------------------------------------------------------------
-- Append-only: cả ba INSERT được, KHÔNG ai UPDATE hay DELETE
-- ------------------------------------------------------------
GRANT SELECT, INSERT ON audit_logs, deployment_events TO udp_s1, udp_s2, udp_s3;
GRANT SELECT, INSERT ON rollout_events TO udp_s1, udp_s3;
GRANT SELECT, INSERT ON config_change_log TO udp_s2;

GRANT USAGE, SELECT ON SEQUENCE config_change_log_id_seq TO udp_s2, udp_s3;
