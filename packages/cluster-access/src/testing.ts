import type {
  ClusterAccess,
  ControlPlaneIdentity,
  K8sReadVerb,
  K8sWriteVerb,
  KubernetesClient,
  ObjectRef,
} from "@udp/adapter-core";
import { ClusterCallFailedError, objectPath } from "./direct.js";

/**
 * Cụm Kubernetes GIẢ trong bộ nhớ cho test (Plan #51) — đủ hành vi của API server mà đường giao hàng SERVICE_LEVEL
 * dựa vào, không hơn:
 *
 * - merge patch theo RFC 7386 (`null` xoá khoá, mảng thay nguyên);
 * - `metadata.resourceVersion` trong patch là ĐIỀU KIỆN: lệch ⇒ 409, như API server thật;
 * - subresource `status`: ghi lên đó chỉ đổi `status`; ghi lên đối tượng chính KHÔNG đổi `status` (CRD bật
 *   subresource status bỏ qua phần đó);
 * - server-side apply thay phần spec/metadata, giữ `status`;
 * - mọi lời ghi được ghi lại kèm identity — I5 ("tool-driven: 0 lời gọi ghi") và I25 đếm trên danh sách này.
 *
 * KHÔNG mô phỏng RBAC, admission, controller: một test xanh ở đây không nói gì về cụm thật (sổ nợ `I32-cluster`).
 */

type Json = Record<string, unknown>;

export interface RecordedWrite {
  identity: ControlPlaneIdentity;
  verb: K8sWriteVerb;
  path: string;
  body: unknown;
}

const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function mergePatch(target: unknown, patch: unknown): unknown {
  if (!isObject(patch)) return patch;
  const out: Json = isObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key];
    else out[key] = mergePatch(out[key], value);
  }
  return out;
}

const clone = <T>(value: T): T => structuredClone(value);

/** Khoá lưu trữ: path của đối tượng, không kèm subresource */
const keyOf = ({ subresource: _status, ...ref }: ObjectRef): string =>
  objectPath(ref);

export class FakeCluster {
  private readonly objects = new Map<string, Json>();
  private revision = 1;
  readonly writes: RecordedWrite[] = [];
  /** Lỗi tiêm cho lời ghi kế tiếp khớp — trả mã HTTP, `undefined` = không can thiệp */
  failWrite: ((w: RecordedWrite) => number | undefined) | undefined;

  seed(ref: ObjectRef, body: Json): void {
    this.objects.set(keyOf(ref), this.stamp(clone(body)));
  }

  get<T = Json>(ref: ObjectRef): T | undefined {
    const found = this.objects.get(keyOf(ref));
    return found === undefined ? undefined : (clone(found) as T);
  }

  /** Controller giả của test: đổi `status` như Argo/Flagger đổi — không tính là một lời ghi của UDP */
  setStatus(ref: ObjectRef, status: Json): void {
    const current = this.objects.get(keyOf(ref));
    if (current === undefined) throw new Error(`không có ${keyOf(ref)}`);
    current["status"] = mergePatch(current["status"], status);
    this.stamp(current);
  }

  writesBy(identity: ControlPlaneIdentity): RecordedWrite[] {
    return this.writes.filter((w) => w.identity === identity);
  }

  private stamp(body: Json): Json {
    const metadata = isObject(body["metadata"]) ? body["metadata"] : {};
    this.revision += 1;
    body["metadata"] = { ...metadata, resourceVersion: String(this.revision) };
    return body;
  }

  private write(
    identity: ControlPlaneIdentity,
    verb: K8sWriteVerb,
    ref: ObjectRef,
    body: unknown,
  ): void {
    const path = objectPath(ref);
    const recorded: RecordedWrite = { identity, verb, path, body: clone(body) };
    this.writes.push(recorded);
    const injected = this.failWrite?.(recorded);
    if (injected !== undefined) {
      throw new ClusterCallFailedError(injected, verb, path);
    }
    const key = keyOf(ref);
    const current = this.objects.get(key);
    if (verb === "delete") {
      this.objects.delete(key);
      return;
    }
    if (verb === "apply" || verb === "create" || verb === "update") {
      const next = clone(body) as Json;
      if (current?.["status"] !== undefined) next["status"] = current["status"];
      this.objects.set(key, this.stamp(next));
      return;
    }
    // patch
    if (current === undefined) {
      throw new ClusterCallFailedError(404, verb, path);
    }
    const expected = (body as { metadata?: { resourceVersion?: string } })
      .metadata?.resourceVersion;
    const actual = (current["metadata"] as { resourceVersion?: string })
      .resourceVersion;
    if (expected !== undefined && expected !== actual) {
      throw new ClusterCallFailedError(409, verb, path);
    }
    if (ref.subresource === "status") {
      current["status"] = mergePatch(
        current["status"],
        (body as { status?: unknown }).status,
      );
      this.stamp(current);
      return;
    }
    const { status: _ignored, ...patch } = body as Json;
    const status = current["status"];
    const next = mergePatch(current, patch) as Json;
    if (status !== undefined) next["status"] = status;
    this.objects.set(key, this.stamp(next));
  }

  client(identity: ControlPlaneIdentity): KubernetesClient {
    return {
      read: <T>(verb: K8sReadVerb, ref: ObjectRef): Promise<T | null> => {
        if (verb !== "get") {
          return Promise.reject(new Error(`FakeCluster không làm ${verb}`));
        }
        return Promise.resolve((this.get<T>(ref) ?? null) as T | null);
      },
      write: (verb, ref, body) => {
        try {
          this.write(identity, verb, ref, body);
          return Promise.resolve();
        } catch (err: unknown) {
          return Promise.reject(err);
        }
      },
    };
  }

  access(clusterId = "fake-cluster"): ClusterAccess {
    return {
      mode: "direct",
      clusterId,
      getClient: (as) => Promise.resolve(this.client(as)),
      proxyService: () =>
        Promise.reject(new Error("FakeCluster không proxy service")),
      probe: () =>
        Promise.resolve({ status: "SUCCESS", data: { reachable: true } }),
    };
  }
}
