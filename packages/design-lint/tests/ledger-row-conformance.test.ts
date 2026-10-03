import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PROVISIONED_RESOURCE_ROW_FIELDS,
  PROVISIONED_RESOURCE_ROW_OMITTED,
} from "@udp/adapter-core";
import { openClient, readDbColumns, type DbColumn } from "../src/db-schema.js";

/**
 * [v4.10] `ProvisionedResourceRow` khớp từng cột của `provisioned_resources`.
 *
 * Vì sao phép kiểm này tồn tại: `rebuildLedgerFromCloud` trả kiểu đó, và nó là **mệnh
 * đề trung tâm của C3** — "sổ của UDP là cache dựng lại được, không phải nguồn sự thật".
 * Một DTO thiếu cột nghĩa là hàm dựng lại được một hàng KHÔNG ĐẦY ĐỦ, và điểm crash K10
 * sẽ xanh vì nó chỉ đếm số hàng chứ không so từng cột.
 *
 * Kiểu TypeScript biến mất lúc chạy, nên "khớp từng cột" phải đi qua một hằng số chạy
 * được (`PROVISIONED_RESOURCE_ROW_FIELDS`) chứ không qua trình biên dịch. Cùng lối với
 * `schema-conformance.test.ts`: chốt mã đối chiếu với database THẬT.
 */

const snake = (camel: string): string =>
  camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

let client: Client | undefined;
let columns: DbColumn[] = [];

beforeAll(async () => {
  client = await openClient();
  const byTable = await readDbColumns(client);
  columns = byTable.get("provisioned_resources") ?? [];
});

afterAll(async () => {
  await client?.end();
});

describe("ProvisionedResourceRow đối chiếu bảng provisioned_resources", () => {
  it("bảng tồn tại và có cột", () => {
    expect(columns.length).toBeGreaterThan(0);
  });

  it("mọi trường của DTO có một cột tương ứng", () => {
    const dbNames = new Set(columns.map((c) => c.name));
    const missing = PROVISIONED_RESOURCE_ROW_FIELDS.filter(
      (f) => !dbNames.has(snake(f)),
    );
    expect(missing).toEqual([]);
  });

  /**
   * Chiều ngược, và đây mới là chiều bắt được lỗi thật: mọi cột của bảng phải hoặc có
   * mặt trong DTO, hoặc nằm trong danh sách CỐ TÌNH BỎ kèm lý lẽ. Không có chiều này thì
   * thêm một cột vào bảng mà quên DTO là một lỗi im lặng, và `rebuildLedgerFromCloud`
   * dựng lại hàng thiếu cột đó mãi mãi.
   */
  it("mọi cột của bảng đều được khai: hoặc trong DTO, hoặc trong danh sách bỏ", () => {
    const inDto = new Set(PROVISIONED_RESOURCE_ROW_FIELDS.map(snake));
    const omitted = new Set(PROVISIONED_RESOURCE_ROW_OMITTED);
    const unaccounted = columns
      .map((c) => c.name)
      .filter((n) => !inDto.has(n) && !omitted.has(n));
    expect(unaccounted).toEqual([]);
  });

  /**
   * `job_id` phải nằm ở danh sách bỏ, không ở DTO.
   *
   * ADR-08 nói mọi cột suy ra được từ tag **trừ** `job_id`. Nếu nó vào DTO thì
   * `rebuildLedgerFromCloud` phải bịa một giá trị, và lịch sử mất một cách không nhìn
   * thấy được — đúng thứ mà việc tách K10a/K10b sinh ra để tránh.
   */
  it("job_id là NOT NULL trong bảng và nằm trong danh sách bỏ của DTO", () => {
    const jobId = columns.find((c) => c.name === "job_id");
    expect(jobId, "bảng phải có cột job_id").toBeDefined();
    expect((jobId as DbColumn).nullable).toBe(false);
    expect(PROVISIONED_RESOURCE_ROW_OMITTED).toContain("job_id");
  });

  /**
   * Không có cột boolean nào cho tài nguyên do Kubernetes sinh.
   *
   * §4.5 bước 1 từng nói "ghi vào sổ với `managedByK8s = true`" — một câu không hiện
   * thực được, vì cột đó không tồn tại và plan này cấm migration. v4.10 chốt lại: trong
   * sổ, tính chất đó là `step = 'K8S_MANAGED'`. Phép kiểm này chặn việc ai đó lặng lẽ
   * thêm cột để cho câu cũ đúng.
   */
  it("bảng KHÔNG có cột managed_by_k8s; tính chất đó nằm ở step", () => {
    expect(columns.map((c) => c.name)).not.toContain("managed_by_k8s");
    expect(columns.map((c) => c.name)).toContain("step");
    expect(PROVISIONED_RESOURCE_ROW_FIELDS).toContain("step");
  });

  it("idempotency_key là cột mang giá trị của tag udp.key", () => {
    const key = columns.find((c) => c.name === "idempotency_key");
    expect(key, "bảng phải có idempotency_key").toBeDefined();
    expect((key as DbColumn).nullable).toBe(false);
  });

  /** `provider_id` phải NULLABLE — đó chính là trạng thái của điểm crash K2/K3 */
  it("provider_id NULLABLE, vì K2/K3 là trạng thái đã ghi ý định mà chưa biết id", () => {
    const pid = columns.find((c) => c.name === "provider_id");
    expect(pid, "bảng phải có provider_id").toBeDefined();
    expect((pid as DbColumn).nullable).toBe(true);
  });
});
