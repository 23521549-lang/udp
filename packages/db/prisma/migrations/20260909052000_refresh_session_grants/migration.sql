-- `refresh_sessions` thuộc lãnh địa Service 1 (§1.2, nhóm vòng đời tài khoản).
--
-- S2 và S3 KHÔNG có quyền nào ở đây, kể cả SELECT: bảng chứa hash của token
-- phiên, và không nhiệm vụ nào của hai service đó cần đọc nó. Cùng lập luận
-- với việc S3 không được đọc `cloud_credentials`.
GRANT SELECT, INSERT, UPDATE, DELETE ON refresh_sessions TO udp_s1;
