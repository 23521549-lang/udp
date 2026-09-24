import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { CreatedResource, CreatedResourceKind } from "../cloud.js";
import type {
  CloudCallRecord,
  CloudControl,
  InjectedFaultClass,
} from "./index.js";

/**
 * [v4.10] Cloud mô phỏng — viết như một ĐỐI THỦ, không như một stub.
 *
 * Đây là phần nguy hiểm nhất của cả Plan #24. Lưới khôi phục K1..K10 là bằng chứng của
 * đóng góp C3, và nó chạy trên lớp này. Một lớp mô phỏng do chính ta viết sẽ **tử tế với
 * ta** trừ khi nó bị bắt buộc ác: cách viết tự nhiên nhất (một `Map` trong bộ nhớ,
 * `create` idempotent theo khoá, tag thấy ngay, xoá tức thì) làm cả mười ô xanh với một
 * runner rỗng — và một khi lưới đã xanh thì không ai còn lý do quay lại nghi ngờ nó.
 *
 * Mười bốn tính chất dưới đây là điều kiện để lưới có nghĩa. Mỗi tính chất có một phép
 * kiểm trong `sim-cloud.adversarial.test.ts`, và **bộ đó phải xanh trước khi viết một ô
 * lưới nào**.
 *
 * | # | Tính chất | Thiếu nó thì ô nào xanh giả |
 * | --- | --- | --- |
 * | S-1 | State nằm NGOÀI tiến trình: file JSON ghi atomic | Toàn bộ lưới: resume thành công nhờ bộ nhớ chứ không nhờ sổ + tag |
 * | S-2 | Tách `commit` (state đổi) và `respond` (trả về client) | **K3 biến thành K2** — ô quyết định của C3 không được kiểm |
 * | S-3 | KHÔNG idempotency token cho `vpc`/`subnet`; CÓ cho `cluster` | "Không tạo trùng" thành tính chất của cloud, không của runner |
 * | S-4 | Ít nhất một `kind` không nhận tag lúc tạo | §4.5 quy tắc 2 không được kiểm; đường `deterministic-name` chưa bao giờ chạy |
 * | S-5 | Vẫn có API tag RIÊNG, cộng cờ chặn nó | Phép kiểm "gắn đủ tag TRONG CÙNG lời gọi" không bắt được gì |
 * | S-6 | Xoá tag từ ngoài luồng | K8 |
 * | S-7 | Xoá tài nguyên từ ngoài luồng | K7 |
 * | S-8 | Xoá thứ đã mất trả NOT_FOUND, không ném | Phép kiểm "delete idempotent" |
 * | S-9 | Xoá network ném `DependencyViolation` khi còn `k8s-*` tham chiếu | Phép kiểm thứ tự teardown xanh dù adapter KHÔNG hề chờ |
 * | S-10 | Tài nguyên do K8s sinh mang tag `kubernetes.io/cluster/*` và giữ tham chiếu VPC | Phát hiện K8S_MANAGED không được kiểm |
 * | S-11 | `waitReady` cần N lần poll; tạo/xoá không tức thì | K4 mất nghĩa; máy trạng thái chỉ đi qua 4/7 đỉnh |
 * | S-12 | Cửa sổ lan truyền tag: `lookup` theo tag trả rỗng trong N ms đầu | Ô `K2b` (`indeterminate`) không có đối tượng |
 * | S-13 | Nhật ký lời gọi CÓ THỨ TỰ + phân trang cỡ 2 | Là oracle của mọi phép kiểm thứ tự; phân trang bắt lỗi chỉ đọc trang đầu |
 * | S-14 | Mặt cho bốn phương thức còn lại của §4.2 | Bốn phương thức đó đóng băng mà chưa từng chạy |
 *
 * Cộng ba ràng buộc về oracle: hằng số kỳ vọng **viết tay** (O-1), **nhiễu** bắt buộc
 * (O-2), và `rebuildLedgerFromCloud` phải chạy đúng khi database bị ngắt (O-3).
 */

/** Lỗi của cloud mô phỏng — mang theo dữ liệu trông như credential, có chủ đích */
export class SimCloudError extends Error {
  constructor(
    readonly code: string,
    message: string,
    sentinel: string,
  ) {
    super(message);
    this.name = "SimCloudError";
    /**
     * Nhét sentinel vào ba chỗ mà SDK thật hay nhét credential vào.
     *
     * AWS SDK v3 để credential trong `err.$metadata` và trong `err.config`. Nếu cloud mô
     * phỏng ném `new Error("boom")` trần thì phép quét "không log credential" xanh **vô
     * nghĩa** — nó quét một lỗi không có gì để rò.
     */
    (this as unknown as Record<string, unknown>)["config"] = {
      credentials: { secretAccessKey: sentinel },
    };
    (this as unknown as Record<string, unknown>)["$metadata"] = {
      httpRequest: {
        headers: { authorization: `AWS4-HMAC-SHA256 ${sentinel}` },
      },
    };
    this.cause = {
      level2: { level3: { level4: { token: sentinel } } },
    };
  }
}

/** Mã lỗi mà adapter phải phân biệt được */
export const SIM_NOT_FOUND = "NotFound";
export const SIM_DEPENDENCY_VIOLATION = "DependencyViolation";
export const SIM_THROTTLE = "Throttling";
export const SIM_TRANSIENT = "InternalError";
export const SIM_PERMANENT = "InvalidParameterValue";
export const SIM_SEPARATE_TAGGING_REJECTED = "SeparateTaggingRejected";

/** `kind` mà API không cho gắn tag lúc tạo — buộc `lookupBy: "deterministic-name"` (S-4) */
export const KINDS_WITHOUT_CREATE_TAGS: readonly CreatedResourceKind[] = [
  "route-table",
];

/** `kind` có idempotency token thật, giống `clientRequestToken` của EKS (S-3) */
export const KINDS_WITH_IDEMPOTENCY_TOKEN: readonly CreatedResourceKind[] = [
  "cluster",
];

interface StoredResource {
  kind: CreatedResourceKind;
  id: string;
  name: string;
  region: string;
  createdAt: string;
  tags: Record<string, string>;
  /** Số lần `describe` còn phải gọi nữa mới READY (S-11) */
  pollsLeft: number;
  /** VPC mà tài nguyên này giữ tham chiếu (S-9, S-10) */
  attachedTo?: string;
  managedByK8s?: boolean;
  /** Thời điểm tạo, để tính cửa sổ lan truyền tag (S-12) */
  createdAtMs: number;
}

interface InjectedFault {
  kind: CreatedResourceKind;
  n: number;
  fault: InjectedFaultClass;
}

interface SimState {
  seq: number;
  resources: Record<string, StoredResource>;
  calls: CloudCallRecord[];
  faults: InjectedFault[];
  /** Số lần đã gọi `create` cho từng kind, để `failNthCall` đếm đúng */
  createCounts: Record<string, number>;
  config: {
    region: string;
    tagPropagationDelayMs: number;
    waitReadyPolls: number;
    rejectSeparateTagging: boolean;
    pageSize: number;
  };
}

export interface SimCloudOptions {
  statePath: string;
  workerId?: string;
  region?: string;
  tagPropagationDelayMs?: number;
  waitReadyPolls?: number;
  rejectSeparateTagging?: boolean;
  pageSize?: number;
  /** Giá trị canh nhét vào mọi lỗi, để phép quét rò rỉ có đối tượng thật */
  sentinel?: string;
}

const EMPTY = (
  o: Required<Omit<SimCloudOptions, "statePath" | "workerId" | "sentinel">>,
): SimState => ({
  seq: 0,
  resources: {},
  calls: [],
  faults: [],
  createCounts: {},
  config: {
    region: o.region,
    tagPropagationDelayMs: o.tagPropagationDelayMs,
    waitReadyPolls: o.waitReadyPolls,
    rejectSeparateTagging: o.rejectSeparateTagging,
    pageSize: o.pageSize,
  },
});

export class SimCloud implements CloudControl {
  readonly #path: string;
  readonly #workerId: string;
  readonly #sentinel: string;

  constructor(options: SimCloudOptions) {
    this.#path = options.statePath;
    this.#workerId = options.workerId ?? `worker-${String(process.pid)}`;
    this.#sentinel = options.sentinel ?? "SENT-sim-cloud";
    mkdirSync(dirname(this.#path), { recursive: true });
    /**
     * Dọn `.tmp` lúc khởi động và KHÔNG BAO GIỜ đọc nó.
     *
     * Đã đo (R24-6): `kill -9` đúng giữa `writeFileSync(tmp)` và `renameSync` để lại file
     * `.tmp` trong 20/20 lượt. Đọc nó là đọc một file nửa vời, và ô lưới sẽ sai theo một
     * hướng không ai đoán ra.
     */
    rmSync(`${this.#path}.tmp`, { force: true });
    if (!existsSync(this.#path)) {
      this.#save(
        EMPTY({
          region: options.region ?? "ap-southeast-1",
          tagPropagationDelayMs: options.tagPropagationDelayMs ?? 0,
          waitReadyPolls: options.waitReadyPolls ?? 2,
          rejectSeparateTagging: options.rejectSeparateTagging ?? false,
          pageSize: options.pageSize ?? 2,
        }),
      );
      return;
    }

    /**
     * State đã có thì GIỮ tài nguyên nhưng ÁP tuỳ chọn được truyền tường minh.
     *
     * Bản đầu chỉ áp tuỳ chọn lúc tạo file, nên một thực thể mới trên cùng đường dẫn —
     * đúng cách một lần "resume sau khi tiến trình chết" trông như thế nào — im lặng
     * dùng cấu hình cũ. Chính bộ test đối thủ này bắt được: một cloud dựng với
     * `rejectSeparateTagging: true` vẫn cho gắn tag riêng.
     *
     * Chỉ áp trường được truyền, không áp mặc định: nếu không thì mỗi lần resume sẽ reset
     * `tagPropagationDelayMs` mà một ô lưới vừa đặt.
     */
    const state = this.#load();
    if (options.region !== undefined) state.config.region = options.region;
    if (options.tagPropagationDelayMs !== undefined)
      state.config.tagPropagationDelayMs = options.tagPropagationDelayMs;
    if (options.waitReadyPolls !== undefined)
      state.config.waitReadyPolls = options.waitReadyPolls;
    if (options.rejectSeparateTagging !== undefined)
      state.config.rejectSeparateTagging = options.rejectSeparateTagging;
    if (options.pageSize !== undefined)
      state.config.pageSize = options.pageSize;
    this.#save(state);
  }

  // ------------------------------------------------------------------ S-1
  #load(): SimState {
    return JSON.parse(readFileSync(this.#path, "utf8")) as SimState;
  }

  /** Ghi atomic: tmp → fsync → rename. Đã đo bền qua `kill -9` (R24-6) */
  #save(state: SimState): void {
    const tmp = `${this.#path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state));
    const fd = openSync(tmp, "r+");
    fsyncSync(fd);
    closeSync(fd);
    renameSync(tmp, this.#path);
  }

  #record(
    state: SimState,
    verb: string,
    kind: CreatedResourceKind | "unknown",
    idempotencyKey?: string,
  ): void {
    state.calls.push({
      at: Date.now(),
      verb,
      kind,
      workerId: this.#workerId,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    });
  }

  #view(r: StoredResource): CreatedResource {
    return {
      kind: r.kind,
      id: r.id,
      provider: "aws",
      region: r.region,
      createdAt: r.createdAt,
      tags: { ...r.tags },
      ...(r.managedByK8s === true ? { managedByK8s: true } : {}),
    };
  }

  // ---------------------------------------------------------- API "cloud"

  /**
   * Tạo một tài nguyên.
   *
   * S-3: `vpc`/`subnet` **không** có idempotency token — gọi hai lần cùng `idempotencyKey`
   * ra HAI id khác nhau, đúng như `CreateVpc`. Chỉ `cluster` có token.
   *
   * S-2: state được ghi (`commit`) TRƯỚC khi hàm trả về (`respond`). Lỗi
   * `commit-then-timeout` chen vào giữa hai mốc đó — đây là toàn bộ nội dung của K3.
   *
   * S-4: `kind` trong `KINDS_WITHOUT_CREATE_TAGS` bỏ qua tag truyền vào, nên adapter phải
   * dùng tên tất định.
   */
  createResource(args: {
    kind: CreatedResourceKind;
    name: string;
    tags: Record<string, string>;
    idempotencyKey: string;
    attachedTo?: string;
    managedByK8s?: boolean;
  }): CreatedResource {
    const state = this.#load();
    const count = (state.createCounts[args.kind] ?? 0) + 1;
    state.createCounts[args.kind] = count;
    this.#record(state, "create", args.kind, args.idempotencyKey);

    const fault = state.faults.find(
      (f) => f.kind === args.kind && f.n === count,
    );

    if (fault !== undefined && fault.fault !== "commit-then-timeout") {
      state.faults = state.faults.filter((f) => f !== fault);
      this.#save(state);
      throw this.#faultError(fault.fault);
    }

    if (KINDS_WITH_IDEMPOTENCY_TOKEN.includes(args.kind)) {
      const existing = Object.values(state.resources).find(
        (r) =>
          r.tags["udp.key"] === args.idempotencyKey && r.kind === args.kind,
      );
      if (existing !== undefined) {
        this.#save(state);
        return this.#view(existing);
      }
    }

    state.seq += 1;
    const id = `${args.kind}-${String(state.seq)}`;
    const canTagAtCreate = !KINDS_WITHOUT_CREATE_TAGS.includes(args.kind);
    const stored: StoredResource = {
      kind: args.kind,
      id,
      name: args.name,
      region: state.config.region,
      createdAt: new Date().toISOString(),
      createdAtMs: Date.now(),
      tags: canTagAtCreate ? { ...args.tags } : {},
      pollsLeft: state.config.waitReadyPolls,
      ...(args.attachedTo === undefined ? {} : { attachedTo: args.attachedTo }),
      ...(args.managedByK8s === true ? { managedByK8s: true } : {}),
    };
    state.resources[id] = stored;
    // COMMIT
    this.#save(state);

    if (fault?.fault === "commit-then-timeout") {
      const after = this.#load();
      after.faults = after.faults.filter(
        (f) => !(f.kind === fault.kind && f.n === fault.n),
      );
      this.#save(after);
      throw new SimCloudError(
        "RequestTimeout",
        "cloud đã tạo xong nhưng client không nhận được phản hồi",
        this.#sentinel,
      );
    }

    // RESPOND
    return this.#view(stored);
  }

  /** Gắn tag bằng một lời gọi RIÊNG (S-5) — cờ `rejectSeparateTagging` chặn nó */
  tagResource(id: string, tags: Record<string, string>): void {
    const state = this.#load();
    this.#record(state, "tag", state.resources[id]?.kind ?? "unknown");
    if (state.config.rejectSeparateTagging) {
      this.#save(state);
      throw new SimCloudError(
        SIM_SEPARATE_TAGGING_REJECTED,
        "API này không cho gắn tag bằng một lời gọi riêng",
        this.#sentinel,
      );
    }
    const r = state.resources[id];
    if (r === undefined) {
      this.#save(state);
      throw new SimCloudError(SIM_NOT_FOUND, `không có ${id}`, this.#sentinel);
    }
    r.tags = { ...r.tags, ...tags };
    this.#save(state);
  }

  /**
   * Tra theo tag.
   *
   * S-12: trong `tagPropagationDelayMs` đầu sau khi tạo, tài nguyên **chưa thấy** — đúng
   * như `tag:GetResources` của AWS, một API nhất quán cuối. Đây là nguồn lỗi "tạo trùng"
   * thật, và là đối tượng của ô `K2b`.
   */
  findByTag(key: string, value: string): CreatedResource[] {
    const state = this.#load();
    this.#record(state, "findByTag", "unknown");
    const now = Date.now();
    const visible = Object.values(state.resources).filter(
      (r) =>
        r.tags[key] === value &&
        now - r.createdAtMs >= state.config.tagPropagationDelayMs,
    );
    this.#save(state);
    return visible.map((r) => this.#view(r));
  }

  /** Tra theo TÊN tất định — đường dự phòng cho `kind` không gắn được tag lúc tạo (S-4) */
  findByName(kind: CreatedResourceKind, name: string): CreatedResource | null {
    const state = this.#load();
    this.#record(state, "findByName", kind);
    const found = Object.values(state.resources).find(
      (r) => r.kind === kind && r.name === name,
    );
    this.#save(state);
    return found === undefined ? null : this.#view(found);
  }

  /** Tra theo id — đường dự phòng thứ hai, dùng cho điểm crash K8 */
  describeById(id: string): CreatedResource | null {
    const state = this.#load();
    this.#record(state, "describe", state.resources[id]?.kind ?? "unknown");
    const r = state.resources[id];
    this.#save(state);
    return r === undefined ? null : this.#view(r);
  }

  /** S-11: cần N lần poll mới READY, nên `CREATED` và `READY` là hai đỉnh khác nhau */
  pollReady(id: string): boolean {
    const state = this.#load();
    const r = state.resources[id];
    this.#record(state, "pollReady", r?.kind ?? "unknown");
    if (r === undefined) {
      this.#save(state);
      throw new SimCloudError(SIM_NOT_FOUND, `không có ${id}`, this.#sentinel);
    }
    if (r.pollsLeft > 0) r.pollsLeft -= 1;
    const ready = r.pollsLeft === 0;
    this.#save(state);
    return ready;
  }

  /**
   * Xoá.
   *
   * S-8: xoá thứ đã mất trả `"not-found"` thay vì ném — `NOT_FOUND` là thành công, nên
   * compensation chạy lại phải idempotent.
   *
   * S-9: xoá một tài nguyên network mà còn `k8s-*` tham chiếu thì **ném**
   * `DependencyViolation`. Không có tính chất này thì phép kiểm thứ tự teardown xanh dù
   * adapter không hề chờ ELB/ENI biến mất — đúng lỗi "chỉ lộ ra khi hoá đơn về".
   */
  deleteResource(id: string): "deleted" | "not-found" {
    const state = this.#load();
    const r = state.resources[id];
    this.#record(state, "delete", r?.kind ?? "unknown");
    if (r === undefined) {
      this.#save(state);
      return "not-found";
    }
    const dependents = Object.values(state.resources).filter(
      (o) => o.attachedTo === id,
    );
    if (dependents.length > 0) {
      this.#save(state);
      throw new SimCloudError(
        SIM_DEPENDENCY_VIOLATION,
        `${id} còn ${String(dependents.length)} tài nguyên tham chiếu: ${dependents
          .map((d) => d.id)
          .join(", ")}`,
        this.#sentinel,
      );
    }
    delete state.resources[id];
    this.#save(state);
    return "deleted";
  }

  /**
   * Liệt kê theo tag `udp.project`, CÓ PHÂN TRANG (S-13).
   *
   * Trang cỡ 2 có chủ đích: một hiện thực chỉ đọc trang đầu sẽ thấy 2 tài nguyên và
   * `rebuildLedgerFromCloud` dựng lại một sổ thiếu — nhưng vẫn "thành công".
   */
  listTaggedPage(
    projectId: string,
    cursor?: string,
  ): { items: CreatedResource[]; next?: string } {
    const state = this.#load();
    this.#record(state, "listTagged", "unknown");
    const all = Object.values(state.resources)
      .filter((r) => r.tags["udp.project"] === projectId)
      .sort((a, b) => a.id.localeCompare(b.id));
    const start =
      cursor === undefined ? 0 : all.findIndex((r) => r.id === cursor);
    const from = start < 0 ? 0 : start;
    const page = all.slice(from, from + state.config.pageSize);
    const nextItem = all[from + state.config.pageSize];
    this.#save(state);
    return {
      items: page.map((r) => this.#view(r)),
      ...(nextItem === undefined ? {} : { next: nextItem.id }),
    };
  }

  // -------------------------------------------------------- S-14: bốn mặt

  /** Danh sách quyền mà credential "thiếu" — để `preflightPermissions` có đối tượng */
  missingPermissionsFor(credentialLabel: string): string[] {
    return credentialLabel === "thieu-quyen"
      ? ["eks:CreateCluster", "ec2:CreateVpc"]
      : [];
  }

  clusterStatusOf(clusterId: string): "PROVISIONING" | "READY" | "ERROR" {
    const r = this.describeById(clusterId);
    if (r === null) return "ERROR";
    return "READY";
  }

  kubeTokenFor(clusterId: string): { token: string; expiresAt: Date } {
    return {
      token: `sim-token-${clusterId}`,
      expiresAt: new Date(Date.now() + 3_600_000),
    };
  }

  // ------------------------------------------------ CloudControl (cửa hậu)

  removeTag(resourceId: string, tagKey: string): Promise<void> {
    const state = this.#load();
    const r = state.resources[resourceId];
    if (r !== undefined) delete r.tags[tagKey];
    this.#save(state);
    return Promise.resolve();
  }

  deleteOutOfBand(resourceId: string): Promise<void> {
    const state = this.#load();
    delete state.resources[resourceId];
    this.#save(state);
    return Promise.resolve();
  }

  failNthCall(
    kind: CreatedResourceKind,
    n: number,
    fault: InjectedFaultClass,
  ): Promise<void> {
    const state = this.#load();
    state.faults.push({ kind, n, fault });
    this.#save(state);
    return Promise.resolve();
  }

  setTagPropagationDelay(ms: number): Promise<void> {
    const state = this.#load();
    state.config.tagPropagationDelayMs = ms;
    this.#save(state);
    return Promise.resolve();
  }

  listAll(): Promise<CreatedResource[]> {
    const state = this.#load();
    return Promise.resolve(
      Object.values(state.resources).map((r) => this.#view(r)),
    );
  }

  calls(): Promise<CloudCallRecord[]> {
    return Promise.resolve(this.#load().calls);
  }

  // ------------------------------------------------------------ O-2: nhiễu

  /**
   * Bơm bốn loại nhiễu bắt buộc.
   *
   * Không có chúng thì `listTaggedResources` và `rebuildLedgerFromCloud` xanh, nhưng một
   * adapter thật sẽ nhặt cả tài nguyên của project khác trong cùng tài khoản, hoặc bỏ sót
   * tài nguyên ở region khác.
   */
  seedNoise(projectId: string, owner: string): Promise<void> {
    const state = this.#load();
    const add = (
      r: Omit<StoredResource, "createdAtMs" | "pollsLeft">,
    ): void => {
      state.resources[r.id] = { ...r, createdAtMs: 0, pollsLeft: 0 };
    };
    add({
      kind: "vpc",
      id: "noise-other-project",
      name: "vpc",
      region: state.config.region,
      createdAt: new Date(0).toISOString(),
      tags: {
        "udp.project": "99999999-9999-4999-8999-999999999999",
        "udp.key": "khac:NETWORK:vpc:vpc",
        "udp.owner": owner,
        "udp.managed": "true",
      },
    });
    add({
      kind: "vpc",
      id: "noise-customer-untagged",
      name: "cua-khach",
      region: state.config.region,
      createdAt: new Date(0).toISOString(),
      tags: {},
    });
    add({
      kind: "subnet",
      id: "noise-not-managed",
      name: "subnet-x",
      region: state.config.region,
      createdAt: new Date(0).toISOString(),
      tags: { "udp.project": projectId, "udp.managed": "false" },
    });
    add({
      kind: "vpc",
      id: "noise-other-region",
      name: "vpc",
      region: "us-east-1",
      createdAt: new Date(0).toISOString(),
      tags: {
        "udp.project": projectId,
        "udp.key": `${projectId}:NETWORK:vpc:vpc`,
        "udp.owner": owner,
        "udp.managed": "true",
      },
    });
    this.#save(state);
    return Promise.resolve();
  }

  /** Tạo một tài nguyên do "Kubernetes" sinh, giữ tham chiếu VPC (S-10) */
  seedK8sManaged(args: {
    kind: "k8s-loadbalancer" | "k8s-eni" | "k8s-volume";
    clusterName: string;
    attachedTo: string;
  }): Promise<CreatedResource> {
    const state = this.#load();
    state.seq += 1;
    const id = `${args.kind}-${String(state.seq)}`;
    state.resources[id] = {
      kind: args.kind,
      id,
      name: id,
      region: state.config.region,
      createdAt: new Date().toISOString(),
      createdAtMs: 0,
      pollsLeft: 0,
      tags: { [`kubernetes.io/cluster/${args.clusterName}`]: "owned" },
      attachedTo: args.attachedTo,
      managedByK8s: true,
    };
    this.#save(state);
    return Promise.resolve(this.#view(state.resources[id]));
  }

  #faultError(fault: InjectedFaultClass): SimCloudError {
    switch (fault) {
      case "throttle":
        return new SimCloudError(SIM_THROTTLE, "Rate exceeded", this.#sentinel);
      case "transient5xx":
        return new SimCloudError(
          SIM_TRANSIENT,
          "lỗi tạm thời phía cloud",
          this.#sentinel,
        );
      case "permanent4xx":
        return new SimCloudError(
          SIM_PERMANENT,
          "tham số không hợp lệ",
          this.#sentinel,
        );
      case "commit-then-timeout":
        return new SimCloudError(
          "RequestTimeout",
          "không nên tới đây",
          this.#sentinel,
        );
    }
  }
}
