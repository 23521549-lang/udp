import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CreateFlagFields } from "@udp/shared-types/flag-api";
import { Plus, X } from "lucide-react";
import { useRef, useState } from "react";
import { Dialog } from "../../components/Dialog";
import { Icon } from "../../components/Icon";
import { fieldErrorsOf, messageOf } from "../../lib/errors";
import { useProjectContext } from "../project/ProjectLayout";
import { qkPrefix } from "../../lib/query-keys";
import { flagApi } from "./flag-api";
import { parseVariantValue } from "./variant-value";

type FlagType = CreateFlagFields["flagType"];

/** Key tự định dạng khi gõ: chữ thường, số, gạch ngang (§10.8, khớp `flagKeySchema`) */
export const formatFlagKey = (raw: string): string =>
  raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "d")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-{2,}/g, "-");

interface VariantRow {
  key: string;
  value: string;
}

const SDK_CALL: Record<FlagType, string> = {
  BOOLEAN: "getBooleanValue",
  STRING: "getStringValue",
  NUMBER: "getNumberValue",
  JSON: "getObjectValue",
};

const TYPE_LABEL: Record<FlagType, string> = {
  BOOLEAN: "Boolean",
  STRING: "Chuỗi",
  NUMBER: "Số",
  JSON: "JSON",
};

/**
 * Tạo flag (§10.8 FlagCreateSheet): key tự định dạng, xem trước cách gọi SDK, variant
 * theo kiểu. BOOLEAN tự sinh `on`/`off` (§2.2) nên không hỏi variant. Flag tạo ra ở DRAFT.
 */
export function CreateFlagDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (flagId: string) => void;
}) {
  const { project } = useProjectContext();
  const queryClient = useQueryClient();
  const [key, setKey] = useState("");
  const [flagType, setFlagType] = useState<FlagType>("BOOLEAN");
  const [description, setDescription] = useState("");
  const [variants, setVariants] = useState<VariantRow[]>([
    { key: "control", value: "" },
    { key: "treatment", value: "" },
  ]);

  const create = useMutation({
    mutationFn: () => {
      const body: CreateFlagFields = {
        key,
        flagType,
        ...(description.trim() === ""
          ? {}
          : { description: description.trim() }),
        ...(flagType === "BOOLEAN"
          ? {}
          : {
              variants: variants.map((v) => ({
                key: v.key.trim(),
                value: parseVariantValue(flagType, v.value),
              })),
            }),
      };
      return flagApi.create(project.id, body);
    },
    onSuccess: async ({ flag }) => {
      await queryClient.invalidateQueries({
        queryKey: qkPrefix.flagsOf(project.id),
      });
      onCreated(flag.id);
    },
  });
  // Nút "Tạo" không khoá trước khi gửi: key trống ⇒ lỗi ngay dưới ô và ô nhận focus
  const [keyMissing, setKeyMissing] = useState(false);
  const keyInput = useRef<HTMLInputElement>(null);
  const fields = {
    ...fieldErrorsOf(create.error),
    ...(keyMissing ? { key: "Nhập key cho flag." } : {}),
  };
  const variantError = Object.entries(fields).find(([f]) =>
    f.startsWith("variants"),
  )?.[1];
  const submit = (): void => {
    if (key === "") {
      setKeyMissing(true);
      keyInput.current?.focus();
      return;
    }
    create.mutate();
  };

  return (
    <Dialog
      title="Tạo flag"
      description="Flag mới ở trạng thái nháp: SDK chưa thấy nó cho tới khi kích hoạt."
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className="btn" data-close onClick={onClose}>
            Huỷ
          </button>
          <button
            type="button"
            className="btn pri"
            disabled={create.isPending}
            onClick={submit}
          >
            {create.isPending ? "Đang tạo…" : "Tạo flag"}
          </button>
        </>
      }
    >
      <div className="f">
        <label htmlFor="flag-key">Key</label>
        <input
          ref={keyInput}
          id="flag-key"
          name="key"
          className="inp mono"
          autoComplete="off"
          spellCheck={false}
          translate="no"
          placeholder="new-checkout…"
          value={key}
          aria-invalid={fields.key !== undefined}
          aria-describedby={
            fields.key === undefined ? undefined : "flag-key-err"
          }
          onChange={(e) => {
            setKeyMissing(false);
            setKey(formatFlagKey(e.target.value));
          }}
        />
        {fields.key !== undefined ? (
          <span id="flag-key-err" className="field-error">
            {fields.key}
          </span>
        ) : (
          <span className="help mono">
            client.{SDK_CALL[flagType]}("{key === "" ? "key" : key}", …)
          </span>
        )}
      </div>
      <div className="f">
        <span className="lbl">Kiểu</span>
        <div className="seg" role="group" aria-label="Kiểu flag">
          {(Object.keys(TYPE_LABEL) as FlagType[]).map((t) => (
            <button
              key={t}
              type="button"
              aria-pressed={flagType === t}
              onClick={() => setFlagType(t)}
            >
              {TYPE_LABEL[t]}
            </button>
          ))}
        </div>
      </div>
      {flagType !== "BOOLEAN" && (
        <div className="f">
          <span className="lbl">Variant</span>
          {variants.map((v, i) => (
            <div key={i} className="line">
              <input
                className="inp mono"
                spellCheck={false}
                aria-label={`Key variant ${String(i + 1)}`}
                value={v.key}
                onChange={(e) =>
                  setVariants(
                    variants.map((x, j) =>
                      j === i ? { ...x, key: e.target.value } : x,
                    ),
                  )
                }
              />
              <input
                className="inp mono"
                spellCheck={false}
                aria-label={`Giá trị variant ${String(i + 1)}`}
                placeholder={flagType === "JSON" ? '{"a":1}…' : ""}
                value={v.value}
                onChange={(e) =>
                  setVariants(
                    variants.map((x, j) =>
                      j === i ? { ...x, value: e.target.value } : x,
                    ),
                  )
                }
              />
              {variants.length > 2 && (
                <button
                  type="button"
                  className="ib"
                  aria-label={`Bỏ variant ${String(i + 1)}`}
                  onClick={() =>
                    setVariants(variants.filter((_, j) => j !== i))
                  }
                >
                  <Icon of={X} />
                </button>
              )}
            </div>
          ))}
          <button
            type="button"
            className="btn"
            onClick={() => setVariants([...variants, { key: "", value: "" }])}
          >
            <Icon of={Plus} />
            Thêm variant
          </button>
          {variantError !== undefined && (
            <span className="field-error">{variantError}</span>
          )}
        </div>
      )}
      <div className="f">
        <label htmlFor="flag-desc">Mô tả (tuỳ chọn)</label>
        <textarea
          id="flag-desc"
          className="inp"
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      {create.isError && Object.keys(fields).length === 0 && (
        <p role="alert" className="field-error">
          {messageOf(create.error)}
        </p>
      )}
    </Dialog>
  );
}
