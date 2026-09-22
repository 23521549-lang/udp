import {
  ErrorCode,
  OpenFeatureEventEmitter,
  ProviderEvents,
  type EvaluationContext,
  type FlagMetadata,
  type Hook,
  type JsonValue,
  type Logger,
  type Provider,
  type ResolutionDetails,
} from "@openfeature/server-sdk";
import { PROVIDER, SSE } from "@udp/config/constants";
import { evaluate, type EvaluateOptions } from "@udp/flag-evaluator";
import type { Evaluation } from "@udp/shared-types";
import { takeInternals } from "./internals.js";
import { UDPRequestLabelHook } from "./labels.js";
import { ConfigStore } from "./store.js";
import { Synchronizer } from "./sync.js";
import { HttpTransport } from "./transport.js";

/**
 * `UDPFeatureFlagProvider` — provider OpenFeature cho SERVER key (§6.8) [v4.7]:
 * tải snapshot, giữ cache, nhận delta qua SSE, đánh giá TẠI CHỖ bằng CÙNG lõi với
 * OFREP (I26), fail-static khi mất kết nối (I34), không bao giờ ném (I33).
 *
 * Sự kiện: SDK tự phát READY/ERROR theo kết quả `initialize()`; provider chỉ phát
 * SAU init — CONFIGURATION_CHANGED (kèm `flagsChanged`), và trạng thái khi nó
 * THẬT SỰ đổi: STALE, ERROR khi khoá bị từ chối, READY khi hồi phục (không bao giờ
 * READY hai lần liền). DEGRADED (đang polling) là trạng thái NỘI BỘ: dữ liệu vẫn
 * đúng. Không bao giờ FATAL — FATAL làm SDK trả default, phá fail-static.
 */

export interface UDPProviderOptions {
  /** Gốc của Service 2, vd `https://flags.udp.example` */
  host: string;
  /** SERVER key — suy ra project và environment (ADR-03); không có projectId */
  sdkKey: string;
  /** Mặc định 300; phải lớn hơn thời hạn nhịp tim (50 giây) và `pollingIntervalMs` */
  staleAfterSeconds?: number;
  /** Chu kỳ polling khi stream hỏng và khi khoá bị từ chối. Mặc định 30 000 */
  pollingIntervalMs?: number;
  /** Số lần stream hỏng liên tiếp trước khi polling. Mặc định 3 */
  sseFailuresBeforeFallback?: number;
  /** `initialize()` chờ snapshot đầu tới chừng này rồi NÉM. Mặc định 10 000 */
  initTimeoutMs?: number;
  /** Thay `fetch` (proxy, agent tuỳ biến) */
  fetch?: typeof fetch;
  /** Chẩn đoán (RESYNC, DEGRADED, khoá bị từ chối) ở mức `warn`; mặc định im lặng */
  logger?: Pick<Logger, "warn">;
}

const FLAG_TYPE = {
  boolean: "BOOLEAN",
  string: "STRING",
  number: "NUMBER",
  object: "JSON",
} as const;

type ValueKind = keyof typeof FLAG_TYPE;

const ERROR_CODE: Record<NonNullable<Evaluation["errorCode"]>, ErrorCode> = {
  FLAG_NOT_FOUND: ErrorCode.FLAG_NOT_FOUND,
  TYPE_MISMATCH: ErrorCode.TYPE_MISMATCH,
  PROVIDER_NOT_READY: ErrorCode.PROVIDER_NOT_READY,
  GENERAL: ErrorCode.GENERAL,
};

/** Trạng thái mà SDK đang tin — provider chỉ phát khi nó đổi */
type Announced = "READY" | "STALE" | "ERROR";

const STATUS_EVENT: Record<Announced, ProviderEvents> = {
  READY: ProviderEvents.Ready,
  STALE: ProviderEvents.Stale,
  ERROR: ProviderEvents.Error,
};

/**
 * Context theo ngữ nghĩa JSON — ĐÚNG thứ OFREP nhận qua dây: `Date` (ở mọi độ sâu)
 * ⇒ chuỗi ISO, `NaN`/`Infinity` ⇒ `null`, khoá mang `undefined` bị bỏ. Khác đi thì
 * cùng một context cho hai kết quả ở local và OFREP (I26). Context không tuần tự
 * hoá được (vòng tham chiếu, BigInt) ⇒ bản nông chỉ đổi `Date` ở tầng đầu.
 */
function jsonContext(context: EvaluationContext): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(context)) as Record<string, unknown>;
  } catch {
    const out: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const [key, value] of Object.entries(context)) {
      out[key] = value instanceof Date ? value.toISOString() : value;
    }
    return out;
  }
}

function valueMatches(kind: ValueKind, value: unknown): boolean {
  if (kind === "object") return typeof value === "object" && value !== null;
  return typeof value === kind;
}

/**
 * Tuỳ chọn sai là lỗi cấu hình của lập trình viên — báo ngay lúc dựng provider
 * (I33 là về đánh giá, không che lỗi cấu hình). Hai luật không hiển nhiên:
 *   - Số không dương/NaN biến backoff thành 0 ⇒ vòng nối lại hoặc poll NÓNG.
 *   - Cấu hình còn tươi được xác nhận mỗi nhịp tim (stream) hoặc mỗi lần poll
 *     (DEGRADED): ngưỡng STALE không dài hơn cả hai thì kết nối KHOẺ vẫn nhảy
 *     STALE/READY giữa hai lần xác nhận.
 */
function validated(options: UDPProviderOptions) {
  const positive = (name: string, value: number): number => {
    if (!Number.isFinite(value) || value <= 0)
      throw new RangeError(`${name} phải là số dương hữu hạn`);
    return value;
  };
  const pollingIntervalMs = positive(
    "pollingIntervalMs",
    options.pollingIntervalMs ?? SSE.pollingFallbackMs,
  );
  const failures =
    options.sseFailuresBeforeFallback ?? SSE.fallbackAfterFailures;
  if (!Number.isInteger(failures) || failures < 1)
    throw new RangeError("sseFailuresBeforeFallback phải là số nguyên ≥ 1");
  const initTimeoutMs = positive(
    "initTimeoutMs",
    options.initTimeoutMs ?? PROVIDER.initTimeoutMs,
  );
  const staleAfterMs =
    positive(
      "staleAfterSeconds",
      options.staleAfterSeconds ?? PROVIDER.staleAfterSeconds,
    ) * 1000;
  const heartbeatTimeoutMs = SSE.heartbeatMs * PROVIDER.heartbeatTimeoutFactor;
  const floor = Math.max(heartbeatTimeoutMs, pollingIntervalMs);
  if (staleAfterMs <= floor) {
    throw new RangeError(
      `staleAfterSeconds phải lớn hơn ${String(floor / 1000)} giây ` +
        "(max của thời hạn nhịp tim và pollingIntervalMs)",
    );
  }
  return {
    pollingIntervalMs,
    sseFailuresBeforeFallback: failures,
    initTimeoutMs,
    staleAfterMs,
    heartbeatTimeoutMs,
  };
}

export class UDPFeatureFlagProvider implements Provider {
  readonly metadata = { name: "udp" } as const;
  readonly runsOn = "server" as const;
  readonly events = new OpenFeatureEventEmitter();
  readonly hooks: Hook[];

  private readonly store: ConfigStore;
  private readonly sync: Synchronizer;
  private readonly initTimeoutMs: number;
  private initialized = false;
  private closed = false;
  private announced: Announced | undefined;
  private initPromise: Promise<void> | undefined;
  private pendingInit:
    { resolve: () => void; reject: (err: Error) => void } | undefined;

  constructor(options: UDPProviderOptions) {
    // Đọc-và-xoá khe tiêm TRƯỚC mọi thứ có thể ném (xem `internals.ts`)
    const internals = takeInternals();
    const o = validated(options);
    this.store = internals.store ?? new ConfigStore();
    this.initTimeoutMs = o.initTimeoutMs;
    this.hooks = [new UDPRequestLabelHook(() => this.store.trackedFlags)];
    const logger = options.logger;
    this.sync = new Synchronizer(
      internals.transport ??
        new HttpTransport(options.host, options.sdkKey, options.fetch),
      this.store,
      {
        pollingIntervalMs: o.pollingIntervalMs,
        sseFailuresBeforeFallback: o.sseFailuresBeforeFallback,
        staleAfterMs: o.staleAfterMs,
        heartbeatTimeoutMs: o.heartbeatTimeoutMs,
        backoffMinMs: PROVIDER.reconnectBackoffMinMs,
        requestTimeoutMs: PROVIDER.configRequestTimeoutMs,
        staleCheckMs: Math.max(100, Math.min(1_000, o.staleAfterMs / 4)),
        random: Math.random,
        now: Date.now,
        ...internals.sync,
      },
      {
        onFirstData: () => {
          if (!this.settleInit(undefined)) this.announce("READY");
        },
        onChanged: (flagsChanged) => {
          if (this.closed || !this.initialized) return;
          this.events.emit(ProviderEvents.ConfigurationChanged, {
            flagsChanged,
          });
        },
        onStale: () => this.announce("STALE"),
        onFresh: () => this.announce("READY"),
        onUnauthorized: () => {
          const message = "SDK key bị từ chối (401) — khoá sai hoặc đã thu hồi";
          logger?.warn(`[udp] ${message}`);
          if (!this.settleInit(new Error(message)))
            this.announce("ERROR", `${message}; phục vụ cấu hình cuối`);
        },
        onAuthorized: () => {
          if (this.store.hasData) this.announce("READY");
        },
        onDiagnostic: (message) => logger?.warn(`[udp] ${message}`),
      },
    );
  }

  /** Tập flag đang gắn nhãn `ff` (§6.6) — cùng một `Set` suốt đời provider */
  get trackedFlags(): ReadonlySet<string> {
    return this.store.trackedFlags;
  }

  /** Version của cấu hình đang phục vụ; `undefined` trước khi có dữ liệu */
  get configVersion(): number | undefined {
    return this.store.hasData ? this.store.configVersion : undefined;
  }

  /**
   * Chờ snapshot đầu tới `initTimeoutMs`. Quá hạn ⇒ NÉM (SDK phát ERROR; ứng dụng
   * vẫn chạy với default) nhưng vẫn thử nền và phát READY khi có. 401 ⇒ ném ngay.
   * Gọi lại khi đang chờ ⇒ cùng một lời hứa.
   */
  initialize(): Promise<void> {
    this.initPromise ??= this.runInit();
    return this.initPromise;
  }

  private async runInit(): Promise<void> {
    this.sync.start();
    if (this.store.hasData) {
      this.initialized = true;
      this.announced = "READY";
      return;
    }
    const ready = new Promise<void>((resolve, reject) => {
      this.pendingInit = { resolve, reject };
    });
    // KHÔNG `unref()`: mọi timer của vòng đồng bộ đều unref (không giữ tiến trình
    // sống sau khi ứng dụng muốn thoát), nên khi Service 2 không tới được thì timer
    // này là thứ DUY NHẤT giữ event loop trong lúc `await setProviderAndWait` — unref
    // nó là Node thoát ngay giữa lúc khởi động (ESM: mã 13), ứng dụng không bao giờ
    // chạy. Nó bị xoá ngay khi init xong nên không giữ một tiến trình khoẻ.
    const timer = setTimeout(() => {
      this.settleInit(
        new Error(
          `Không tải được cấu hình trong ${String(this.initTimeoutMs)} ms — đang thử lại nền`,
        ),
      );
    }, this.initTimeoutMs);
    try {
      await ready;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Kết thúc lần `initialize()` đang chờ — xoá chỗ chờ NGAY, trước khi trả kết quả:
   * snapshot tới đúng lúc hạn chờ vừa hết phải thành READY do provider phát, không
   * rơi vào một lời hứa đã từ chối. `false` khi không có lần init nào đang chờ.
   */
  private settleInit(error: Error | undefined): boolean {
    const pending = this.pendingInit;
    if (pending === undefined) return false;
    this.pendingInit = undefined;
    this.initialized = true;
    // SDK tự phát READY/ERROR theo kết quả này
    this.announced = error === undefined ? "READY" : "ERROR";
    if (error === undefined) pending.resolve();
    else pending.reject(error);
    return true;
  }

  onClose(): Promise<void> {
    this.closed = true;
    this.sync.close();
    // Đóng giữa lúc init: không bắt `setProviderAndWait`/`close()` chờ hết hạn
    this.settleInit(new Error("provider đã đóng trước khi có cấu hình"));
    return Promise.resolve();
  }

  private announce(status: Announced, message?: string): void {
    if (this.closed || !this.initialized || this.announced === status) return;
    this.announced = status;
    this.events.emit(
      STATUS_EVENT[status],
      message === undefined ? {} : { message },
    );
  }

  // ------------------------------------------------------------- đánh giá

  private resolve<T>(
    kind: ValueKind,
    flagKey: string,
    defaultValue: T,
    context: EvaluationContext,
  ): ResolutionDetails<T> {
    try {
      const prepared = this.store.prepared;
      if (prepared === undefined) {
        return {
          value: defaultValue,
          reason: "ERROR",
          errorCode: ErrorCode.PROVIDER_NOT_READY,
        };
      }
      const options: EvaluateOptions = { expectedType: FLAG_TYPE[kind] };
      const evaluation = evaluate(
        prepared,
        flagKey,
        jsonContext(context),
        options,
      );
      const flagMetadata: FlagMetadata = {};
      if (evaluation.ruleId !== undefined)
        flagMetadata["ruleId"] = evaluation.ruleId;
      if (evaluation.archived === true) flagMetadata["archived"] = true;
      if (this.sync.isStale) flagMetadata["stale"] = true;

      if (evaluation.reason === "ERROR") {
        return {
          value: defaultValue,
          reason: "ERROR",
          errorCode: ERROR_CODE[evaluation.errorCode ?? "GENERAL"],
          ...(evaluation.errorMessage === undefined
            ? {}
            : { errorMessage: evaluation.errorMessage }),
          flagMetadata,
        };
      }
      if (evaluation.value === undefined) {
        // DISABLED: default trong code của ứng dụng (§6.5)
        return { value: defaultValue, reason: evaluation.reason, flagMetadata };
      }
      if (!valueMatches(kind, evaluation.value)) {
        return {
          value: defaultValue,
          reason: "ERROR",
          errorCode: ErrorCode.TYPE_MISMATCH,
          errorMessage: "giá trị variant không đúng kiểu flag",
          flagMetadata,
        };
      }
      return {
        value: evaluation.value as T,
        reason: evaluation.reason,
        ...(evaluation.variant === undefined
          ? {}
          : { variant: evaluation.variant }),
        flagMetadata,
      };
    } catch {
      return {
        value: defaultValue,
        reason: "ERROR",
        errorCode: ErrorCode.GENERAL,
      };
    }
  }

  resolveBooleanEvaluation(
    flagKey: string,
    defaultValue: boolean,
    context: EvaluationContext,
  ): Promise<ResolutionDetails<boolean>> {
    return Promise.resolve(
      this.resolve("boolean", flagKey, defaultValue, context),
    );
  }

  resolveStringEvaluation(
    flagKey: string,
    defaultValue: string,
    context: EvaluationContext,
  ): Promise<ResolutionDetails<string>> {
    return Promise.resolve(
      this.resolve("string", flagKey, defaultValue, context),
    );
  }

  resolveNumberEvaluation(
    flagKey: string,
    defaultValue: number,
    context: EvaluationContext,
  ): Promise<ResolutionDetails<number>> {
    return Promise.resolve(
      this.resolve("number", flagKey, defaultValue, context),
    );
  }

  resolveObjectEvaluation<T extends JsonValue>(
    flagKey: string,
    defaultValue: T,
    context: EvaluationContext,
  ): Promise<ResolutionDetails<T>> {
    return Promise.resolve(
      this.resolve("object", flagKey, defaultValue, context),
    );
  }
}
