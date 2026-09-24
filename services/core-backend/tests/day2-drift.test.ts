import { readOnlyContext } from "@udp/adapter-core";
import type {
  DomainAdapter,
  DomainAdapterContext,
  ObjectRef,
} from "@udp/adapter-core";
import { createFakeClusterAccess } from "@udp/adapter-core/testing";
import type { FakeClusterAccess } from "@udp/adapter-core/testing";
import { env } from "@udp/config";
import { createPrismaClient, type PrismaClient } from "@udp/db";
import { stableOwner } from "@udp/test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import adapter from "../src/modules/monitoring-adapter/prometheus-grafana/index.js";
import {
  activeDomainsOfProject,
  writeDriftRecord,
  type Day2DomainRow,
} from "../src/modules/day2/domain-config.repository.js";
import { scanDomainDrift } from "../src/modules/day2/drift-scan.js";

/**
 * [v4.10] Cổng P21 - lưới **5 sửa đổi** của E16, và ba chiều của bất biến I32.
 *
 * ## Lưới E16 trong thế giới mô phỏng, và chỗ nó KHÔNG trung thực
 *
 * E16 (§14.1) gây năm loại sửa đổi ngoài luồng rồi đo bốn thứ: có phát hiện được không,
 * độ trễ, diff có chỉ đúng chỗ, và hành vi mặc định là báo cáo hay tự ghi đè. Ba trong bốn
 * thứ đó kiểm được ở đây; **độ trễ** thì không, vì nó là tính chất của lịch biểu thật trên
 * một cluster thật (`E16` trong sổ nợ, cần cluster + Argo CD, ~1,5 GB thêm).
 *
 * Năm sửa đổi của E16 nói bằng ngôn ngữ của Kubernetes thật (Deployment, image tag). Ở
 * thế giới mô phỏng của §13.2 thì chart không được render, nên mỗi sửa đổi được ánh xạ
 * sang đối tượng TƯƠNG ĐƯƠNG mà adapter thật sự ghi. Bảng này là phần phải đọc trước khi
 * tin vào lưới, vì nó cũng nói rõ giới hạn:
 *
 * | Sửa đổi của E16 | Ở đây | Trung thực tới đâu |
 * | --- | --- | --- |
 * | Đổi số replica | Sửa `values.prometheus.prometheusSpec` trong ConfigMap giá trị | Cùng cơ chế: một trường trong bản mong muốn bị sửa tay |
 * | Đổi image tag | Sửa `values.grafana.image.registry` | Như trên |
 * | Xoá một ConfigMap | Xoá hẳn ConfigMap giá trị | ĐÚNG như E16 |
 * | Thêm một nhãn lạ | `patch` thêm một khoá không khai ở `ignoredKeyPrefixes` | ĐÚNG như E16 |
 * | Xoá hẳn một Deployment | Xoá `HelmRelease` | Tương đương: nó là đối tượng đại diện cho workload đang chạy |
 *
 * Hai hàng cuối mới là hai hàng đáng giá: chúng là hai loại trôi mà một hàm quét chỉ so
 * "những khoá tôi tự đặt" sẽ bỏ qua hoàn toàn, và bản P19/P20 đã bỏ qua cả hai.
 *
 * ## Vì sao mỗi sửa đổi là MỘT ô
 *
 * Một vòng `for` qua năm sửa đổi trong một `it` cho một dòng đỏ duy nhất nói "sửa đổi thứ
 * ba không bị phát hiện", và nó đỏ trước khi chạy tới sửa đổi thứ tư - nên một lần chạy
 * chỉ trả về một phát hiện. Năm ô riêng trả về năm kết quả, và đó chính là hình dạng của
 * một MA TRẬN đo: E16 là một phép đo, không phải một phép kiểm.
 */

const SYSTEM_NS = "udp-system";

const VALUES_REF: ObjectRef = {
  apiVersion: "v1",
  kind: "ConfigMap",
  namespace: SYSTEM_NS,
  name: "udp-prometheus-values",
};

const RELEASE_REF: ObjectRef = {
  apiVersion: "helm.toolkit.fluxcd.io/v2",
  kind: "HelmRelease",
  namespace: SYSTEM_NS,
  name: "udp-prometheus",
};

const VALID_CONFIG = { retentionDays: 15, dashboards: true, storageGb: 20 };

function contextFor(cluster: FakeClusterAccess): DomainAdapterContext {
  return {
    k8s: cluster,
    systemNamespace: SYSTEM_NS,
    region: "ap-southeast-1",
    quota: {
      maxNodes: 3,
      maxNodeSize: "medium",
      maxDatabases: 2,
      maxStorageGb: 50,
      maxLoadBalancers: 3,
    },
    resolved: {
      "registry.oci": {
        id: "registry.oci",
        version: "1.0.0",
        providedBy: "container_registry:harbor",
        endpoint: "harbor.udp-system:443",
      },
    },
    tags: { "udp.project": "p21" },
    progress: () => undefined,
    fetch: () =>
      Promise.reject(new Error("adapter này khai không gọi ra ngoài")),
  };
}

/** Deploy một lần rồi trả về cluster giả đang mang trạng thái sau deploy */
async function deployed(): Promise<{
  cluster: FakeClusterAccess;
  ctx: DomainAdapterContext;
}> {
  const cluster = createFakeClusterAccess({ clusterId: "c-p21" });
  const ctx = contextFor(cluster);
  const res = await adapter.deploy(ctx, VALID_CONFIG);
  expect(res.status).toBe("SUCCESS");
  return { cluster, ctx };
}

async function driftAfter(
  mutate: (cluster: FakeClusterAccess) => Promise<void>,
): Promise<{ drifted: boolean; details: string }> {
  const { cluster, ctx } = await deployed();
  await mutate(cluster);
  cluster.reset();
  const res = await adapter.detectDrift(readOnlyContext(ctx), VALID_CONFIG);
  expect(res.status).toBe("SUCCESS");
  /**
   * Khẳng định kèm: một lượt quét KHÔNG ghi gì, ở mọi ô của lưới.
   *
   * Đặt ở đây chứ không chỉ ở ô riêng của chiều (c), vì "không tự sửa" phải đúng ở CẢ NĂM
   * loại trôi. Một hàm quét tự vá đúng một loại (ví dụ tự tạo lại ConfigMap đã bị xoá) là
   * đúng cái hành vi Argo CD làm mặc định, và E16 tồn tại để nói rằng UDP không làm vậy.
   */
  expect(cluster.writes).toEqual([]);
  return {
    drifted: res.data?.drifted === true,
    details: res.data?.details ?? "",
  };
}

/** Đọc ConfigMap giá trị rồi ghi lại một bản đã sửa - mô phỏng một lần `kubectl edit` */
async function editValues(
  cluster: FakeClusterAccess,
  mutate: (values: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  const client = await cluster.getClient("tooling");
  const found = await client.read<Record<string, unknown>>("get", VALUES_REF);
  expect(found).not.toBeNull();
  const values = (found?.values ?? {}) as Record<string, unknown>;
  await client.write("patch", VALUES_REF, { values: mutate({ ...values }) });
}

describe("lưới E16 - năm loại sửa đổi ngoài luồng, mỗi loại một ô", () => {
  it("1. đổi số replica: values.prometheus bị sửa tay", async () => {
    const { drifted, details } = await driftAfter((cluster) =>
      editValues(cluster, (values) => ({
        ...values,
        prometheus: { prometheusSpec: { replicas: 3 } },
      })),
    );
    expect(drifted).toBe(true);
    /** E16 đo (3): diff phải CHỈ ĐÚNG CHỖ, không chỉ nói "đã trôi" */
    expect(details).toContain("values");
  });

  it("2. đổi image tag: values.grafana.image bị sửa tay", async () => {
    const { drifted, details } = await driftAfter((cluster) =>
      editValues(cluster, (values) => ({
        ...values,
        grafana: { enabled: true, image: { registry: "ai-do-sua.test:443" } },
      })),
    );
    expect(drifted).toBe(true);
    expect(details).toContain("values");
  });

  it("3. xoá một ConfigMap: ConfigMap giá trị bị xoá hẳn", async () => {
    const { drifted, details } = await driftAfter(async (cluster) => {
      const client = await cluster.getClient("tooling");
      await client.write("delete", VALUES_REF);
    });
    expect(drifted).toBe(true);
    expect(details).toContain("thiếu ConfigMap");
  });

  it("4. thêm một nhãn lạ: khoá không khai ở ignoredKeyPrefixes", async () => {
    const { drifted, details } = await driftAfter(async (cluster) => {
      const client = await cluster.getClient("tooling");
      await client.write("patch", VALUES_REF, { "udp.test/nhan-la": "co" });
    });
    expect(drifted).toBe(true);
    expect(details).toContain("khoá lạ");
  });

  it("5. xoá hẳn một Deployment: HelmRelease bị xoá", async () => {
    const { drifted, details } = await driftAfter(async (cluster) => {
      const client = await cluster.getClient("tooling");
      await client.write("delete", RELEASE_REF);
    });
    expect(drifted).toBe(true);
    expect(details).toContain("HelmRelease");
  });

  /**
   * Ô ÂM - không sửa gì thì không được báo trôi.
   *
   * Nó là chiều (b) của I32, và nó là ô giữ cho năm ô trên có nghĩa: một `detectDrift`
   * trả `true` vô điều kiện qua cả năm ô mà không ai phát hiện. §13.2 nói thẳng lý do -
   * *"trôi giả ngay sau khi cài nghĩa là hàm chuẩn hóa sai, và người dùng sẽ học cách bỏ
   * qua cảnh báo"*, tức một hệ thống báo động giả tệ hơn một hệ thống không báo.
   */
  it("ô âm: không sửa gì ⇒ không trôi, và nhãn được khai bỏ qua cũng không", async () => {
    const sach = await driftAfter(() => Promise.resolve());
    expect(sach.drifted).toBe(false);

    const daKhaiBoQua = await driftAfter(async (cluster) => {
      const client = await cluster.getClient("tooling");
      await client.write("patch", VALUES_REF, {
        "kubectl.kubernetes.io/last-applied-configuration": "{}",
        "helm.sh/revision": "7",
      });
    });
    expect(daKhaiBoQua.drifted).toBe(false);
  });
});

/**
 * Ba tầng của I32 chiều (c), mỗi tầng một ô - và tầng nào cũng bắt một loại lỗi khác.
 */
describe("I32 chiều (c) - ba tầng", () => {
  it("tầng LÚC CHẠY: client của đường quét không có write", async () => {
    const { ctx } = await deployed();
    const readOnly = readOnlyContext(ctx);
    const client = await readOnly.k8s.getClient("tooling");

    /**
     * Không có `write`, và đó là một khẳng định về OBJECT chứ không về kiểu.
     *
     * `@ts-expect-error` ở đây là bằng chứng của tầng KIỂU: dòng dưới không biên dịch
     * được, nên chính comment này là phép kiểm - nếu ngày nào đó `write` quay lại thì
     * `tsc` đỏ vì một `@ts-expect-error` không còn lỗi để mà chờ.
     */
    // @ts-expect-error TSX-04: ReadOnlyKubernetesClient không có write (tầng kiểu của I32 c)
    expect(client.write).toBeUndefined();
  });

  it("tầng ĐẾM: adapter lách bằng as thì bị bắt", async () => {
    const { cluster, ctx } = await deployed();
    cluster.reset();

    /** Một adapter gian: nó nhận bối cảnh chỉ đọc rồi `as` để lấy lại quyền ghi */
    const cheating: DomainAdapter["detectDrift"] = async (readOnly, config) => {
      void config;
      const full = readOnly as unknown as DomainAdapterContext;
      const client = await full.k8s.getClient("tooling");
      await client.write("patch", VALUES_REF, { values: { "tu-sua": true } });
      return { status: "SUCCESS", data: { drifted: false } };
    };

    /**
     * Trao BỐI CẢNH ĐẦY ĐỦ: đúng ca mà một route viết vội sẽ tạo ra.
     *
     * Ở ca này tầng lúc chạy không đỡ được (client thật có `write`), nên tầng còn lại là
     * phép đếm - và nó phải bắt được.
     */
    await cheating(ctx, VALID_CONFIG);
    expect(cluster.writes.length).toBeGreaterThan(0);

    /** Còn qua đường sản phẩm thì chính lời gọi đó vỡ, không phải ghi được rồi mới bị đếm */
    cluster.reset();
    await expect(cheating(readOnlyContext(ctx), VALID_CONFIG)).rejects.toThrow(
      TypeError,
    );
    expect(cluster.writes).toEqual([]);
  });

  /**
   * `SUCCESS` mà `data` vắng KHÔNG được đọc thành "sạch".
   *
   * `AdapterResult.data` là tuỳ chọn ở tầng kiểu, nên một adapter trả
   * `{ status: "SUCCESS" }` biên dịch được và sẽ tồn tại. Coi nó là sạch nghĩa là mọi
   * domain của adapter đó xanh vĩnh viễn, và không có dòng log nào nói vì sao.
   */
  it("adapter trả SUCCESS mà không có dữ liệu ⇒ SCAN_FAILED, không phải CLEAN", async () => {
    const rong: DomainAdapter = {
      ...adapter,
      detectDrift: () => Promise.resolve({ status: "SUCCESS" }),
    };
    const { ctx } = await deployed();
    const written: string[] = [];
    const messages: string[] = [];

    const outcomes = await scanDomainDrift(
      [
        {
          id: "cfg-rong",
          projectId: "p-1",
          domainType: "MONITORING",
          selectedTool: "prometheus-grafana",
          toolConfig: VALID_CONFIG,
          adapterVersion: "1.0.0",
          lastError: null,
        },
      ],
      {
        adapterFor: () => rong,
        contextFor: () => Promise.resolve(ctx),
        writeDrift: (_id, record) => {
          if (record !== null) {
            written.push(record.adapterResult);
            messages.push(record.message);
          }
          return Promise.resolve();
        },
      },
    );

    expect(outcomes[0]?.verdict).toBe("SCAN_FAILED");
    expect(written).toEqual(["FAILED"]);
    /**
     * Và THÔNG ĐIỆP phải nói được nguyên nhân.
     *
     * Không có khẳng định này thì một hiện thực bỏ phép kiểm `data === undefined` vẫn
     * xanh: nó đọc `res.data.drifted` trên `undefined`, ném `TypeError`, và khối `catch`
     * ghi đúng `SCAN_FAILED` - cùng phán quyết, vì một lý do hoàn toàn khác. Đột biến M4
     * của P21 sống sót đúng vì lý do đó, và đây là chỗ nó bị giết: `last_error` ghi
     * "TypeError" không nói cho người vận hành điều gì cả.
     */
    expect(messages[0]).toContain("không có kết quả quét");
  });

  it("job quét thật: ba chu kỳ trên một domain đang trôi, không lời gọi ghi nào", async () => {
    const { cluster, ctx } = await deployed();
    const client = await cluster.getClient("tooling");
    await client.write("delete", RELEASE_REF);
    cluster.reset();

    const written: (string | null)[] = [];
    let lastError: unknown = null;
    const rows = (): Day2DomainRow[] => [
      {
        id: "cfg-1",
        projectId: "p-1",
        domainType: "MONITORING",
        selectedTool: "prometheus-grafana",
        toolConfig: VALID_CONFIG,
        adapterVersion: "1.0.0",
        lastError,
      },
    ];

    for (let cycle = 0; cycle < 3; cycle += 1) {
      const outcomes = await scanDomainDrift(rows(), {
        adapterFor: () => adapter,
        contextFor: () => Promise.resolve(ctx),
        writeDrift: (_id, record) => {
          written.push(record === null ? null : record.message);
          lastError = record;
          return Promise.resolve();
        },
      });
      expect(outcomes[0]?.verdict).toBe("DRIFTED");
    }

    /**
     * Ba chu kỳ, ĐÚNG MỘT lần ghi.
     *
     * Không phải một tối ưu: `updated_at` là `@updatedAt`, nên ghi lại cùng một phán quyết
     * mỗi 6 giờ làm cột "đổi lần cuối" của mọi domain nhảy 4 lần một ngày, và Portal hiện
     * một domain không ai chạm tới như thể vừa có người sửa.
     */
    expect(written).toEqual([written[0]]);
    expect(cluster.writes).toEqual([]);
  });
});

/**
 * Chiều (c) ở tầng DATABASE - chỉ `last_error` và `updated_at` đổi.
 *
 * Phải là database thật: khẳng định "không cột nào khác đổi" là khẳng định về một hàng
 * Postgres sau ba lượt `UPDATE`, và một fake sẽ chỉ nhắc lại đúng những gì test đã dạy nó.
 */
const admin: PrismaClient = createPrismaClient({
  connectionString: env.DATABASE_URL,
  max: 2,
  cacheKey: "__udp_prisma_day2_admin",
});

const PROJECT = "21212121-2121-4121-8121-212121212121";
let configId = "";

beforeAll(async () => {
  const owner = await stableOwner(admin);
  await admin.capabilityBinding.deleteMany({
    where: { domainConfig: { projectId: PROJECT } },
  });
  await admin.domainConfig.deleteMany({ where: { projectId: PROJECT } });
  await admin.project.deleteMany({ where: { id: PROJECT } });
  await admin.project.create({
    data: {
      id: PROJECT,
      ownerId: owner.id,
      name: "day2 drift P21",
      creationMode: "CREATE_NEW",
      languageRuntime: "node20",
      resourceQuota: {},
    },
  });
  const cfg = await admin.domainConfig.create({
    data: {
      projectId: PROJECT,
      domainType: "MONITORING",
      isEnabled: true,
      domainStatus: "ACTIVE",
      selectedTool: "prometheus-grafana",
      toolConfig: VALID_CONFIG,
      adapterVersion: "1.0.0",
    },
    select: { id: true },
  });
  configId = cfg.id;
});

afterAll(async () => {
  await admin.domainConfig.deleteMany({ where: { projectId: PROJECT } });
  await admin.project.deleteMany({ where: { id: PROJECT } });
  await admin.$disconnect();
});

describe("I32 chiều (c) trên database thật", () => {
  it("chỉ last_error và updated_at đổi sau ba chu kỳ quét", async () => {
    const before = await admin.domainConfig.findUniqueOrThrow({
      where: { id: configId },
    });

    const { cluster, ctx } = await deployed();
    const client = await cluster.getClient("tooling");
    await client.write("delete", RELEASE_REF);
    cluster.reset();

    for (let cycle = 0; cycle < 3; cycle += 1) {
      const rows = await activeDomainsOfProject(admin, PROJECT);
      expect(rows).toHaveLength(1);
      const outcomes = await scanDomainDrift(rows, {
        adapterFor: () => adapter,
        contextFor: () => Promise.resolve(ctx),
        writeDrift: (id, record) => writeDriftRecord(admin, id, record),
      });
      expect(outcomes[0]?.verdict).toBe("DRIFTED");
    }

    const after = await admin.domainConfig.findUniqueOrThrow({
      where: { id: configId },
    });

    /**
     * So TỪNG cột, không so vài cột đã chọn.
     *
     * Chọn vài cột để so nghĩa là một cột mới thêm vào lược đồ sẽ không được ai canh, và
     * bất biến này nói "không cột nào khác" chứ không nói "không ba cột này".
     */
    const changed = Object.keys(after).filter(
      (k) =>
        JSON.stringify(after[k as keyof typeof after]) !==
        JSON.stringify(before[k as keyof typeof before]),
    );
    expect([...changed].sort()).toEqual(["lastError", "updatedAt"]);
    expect(cluster.writes).toEqual([]);

    /** Và badge nói đúng loại: đã trôi, không phải không quét được */
    const record = after.lastError as Record<string, unknown>;
    expect(record.step).toBe("DRIFT_SCAN");
    expect(record.adapterResult).toBe("DRIFTED");

    /**
     * Quét lại sau khi sự thật trên cluster đã được sửa ⇒ badge được DỌN.
     *
     * Thiếu nhánh này thì badge "đã trôi cấu hình" dính vĩnh viễn, và người vận hành học
     * cách bỏ qua nó - đúng hậu quả mà §13.2 nói về báo động giả, chỉ theo chiều ngược.
     */
    const lai = await deployed();
    const rows = await activeDomainsOfProject(admin, PROJECT);
    const outcomes = await scanDomainDrift(rows, {
      adapterFor: () => adapter,
      contextFor: () => Promise.resolve(lai.ctx),
      writeDrift: (id, rec) => writeDriftRecord(admin, id, rec),
    });
    expect(outcomes[0]?.verdict).toBe("CLEAN");
    expect(outcomes[0]?.wrote).toBe(true);
    const sach = await admin.domainConfig.findUniqueOrThrow({
      where: { id: configId },
    });
    expect(sach.lastError).toBeNull();
  });

  /**
   * Một lỗi của luồng KHÁC không bị lượt quét dọn mất.
   *
   * `last_error` là một cột dùng chung với luồng provisioning, nên "quét sạch thì xoá" mà
   * viết thành `lastError = null` vô điều kiện sẽ xoá mất lý do một lần deploy thất bại -
   * và đó là thứ duy nhất người vận hành đang có để biết chuyện gì đã xảy ra.
   */
  it("lượt quét sạch KHÔNG dọn last_error của luồng khác", async () => {
    await admin.domainConfig.update({
      where: { id: configId },
      data: {
        lastError: {
          step: "DEPLOY",
          message: "helm timeout",
          adapterResult: "FAILED",
        },
      },
    });

    const { ctx } = await deployed();
    const rows = await activeDomainsOfProject(admin, PROJECT);
    const outcomes = await scanDomainDrift(rows, {
      adapterFor: () => adapter,
      contextFor: () => Promise.resolve(ctx),
      writeDrift: (id, rec) => writeDriftRecord(admin, id, rec),
    });

    expect(outcomes[0]?.verdict).toBe("CLEAN");
    expect(outcomes[0]?.wrote).toBe(false);
    const row = await admin.domainConfig.findUniqueOrThrow({
      where: { id: configId },
    });
    expect((row.lastError as Record<string, unknown>).step).toBe("DEPLOY");
  });

  /**
   * Catalog trỏ tới một tool mà registry không còn thấy ⇒ một dòng `FAILED`, không im lặng.
   *
   * Và nó KHÔNG được ghi là `DRIFTED`: "không quét được" với "đã trôi" là hai việc, và
   * gộp chúng làm badge nói sai về nguyên nhân - người vận hành sẽ đi tìm ai đã sửa tay
   * một thứ mà chẳng ai sửa.
   */
  it("mất adapter ⇒ last_error FAILED, không phải DRIFTED", async () => {
    const rows = await activeDomainsOfProject(admin, PROJECT);
    const outcomes = await scanDomainDrift(rows, {
      adapterFor: () => undefined,
      contextFor: () => Promise.reject(new Error("không được gọi tới")),
      writeDrift: (id, rec) => writeDriftRecord(admin, id, rec),
    });

    expect(outcomes[0]?.verdict).toBe("NO_ADAPTER");
    const row = await admin.domainConfig.findUniqueOrThrow({
      where: { id: configId },
    });
    const record = row.lastError as Record<string, unknown>;
    expect(record.adapterResult).toBe("FAILED");
    expect(String(record.message)).toContain("prometheus-grafana");
  });
});
