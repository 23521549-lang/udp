import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { FlagDetailWire } from "@udp/shared-types/wire";
import { Pencil, Plus, X } from "lucide-react";
import { useState } from "react";
import { Dialog } from "../../../components/Dialog";
import { Icon } from "../../../components/Icon";
import { toast } from "../../../components/Toast";
import { fieldErrorsOf, messageOf } from "../../../lib/errors";
import { qkPrefix } from "../../../lib/query-keys";
import { useProjectContext } from "../../project/ProjectLayout";
import { can } from "../../project/roles";
import { flagApi } from "../flag-api";
import { formatVariantValue, parseVariantValue } from "../variant-value";

/**
 * [Plan #44] Sửa danh sách variant (§9 `PUT …/flags/:flagId/variants`). Variant dùng ở MỌI
 * environment, nên flag nháp là việc của DEVELOPER, còn flag đang phục vụ cần MAINTAINER và gõ lại
 * key (máy chủ đòi cả hai). BOOLEAN có đúng `on`/`off` do hệ thống sinh: không có nút.
 */
export function VariantsSection({ flag }: { flag: FlagDetailWire }) {
  const { project } = useProjectContext();
  const [open, setOpen] = useState(false);
  const minimum = flag.lifecycleStatus === "DRAFT" ? "DEVELOPER" : "MAINTAINER";
  if (
    flag.flagType === "BOOLEAN" ||
    flag.lifecycleStatus === "ARCHIVED" ||
    !can(project.myRole, minimum)
  ) {
    return null;
  }
  return (
    <div className="sect">
      <button type="button" className="btn" onClick={() => setOpen(true)}>
        <Icon of={Pencil} />
        Sửa variant
      </button>
      {open && <VariantsDialog flag={flag} onClose={() => setOpen(false)} />}
    </div>
  );
}

interface Row {
  /** Khoá React: id với variant đang có, số tăng dần với variant mới */
  localKey: string;
  id?: string;
  key: string;
  value: string;
}

let nextRow = 0;

function VariantsDialog({
  flag,
  onClose,
}: {
  flag: FlagDetailWire;
  onClose: () => void;
}) {
  const { project } = useProjectContext();
  const queryClient = useQueryClient();
  const [initial] = useState<Row[]>(() =>
    flag.variants.map((v) => ({
      localKey: v.id,
      id: v.id,
      key: v.key,
      value: formatVariantValue(flag.flagType, v.value),
    })),
  );
  const [rows, setRows] = useState<Row[]>(initial);
  const [defaultRow, setDefaultRow] = useState(flag.defaultVariantId ?? "");
  const [typed, setTyped] = useState("");
  const needsKey = flag.lifecycleStatus !== "DRAFT";

  const signature = (list: readonly Row[]) =>
    JSON.stringify(list.map((r) => [r.id ?? null, r.key.trim(), r.value]));
  const dirty =
    signature(rows) !== signature(initial) ||
    defaultRow !== (flag.defaultVariantId ?? "");
  const defaultKey = rows.find((r) => r.localKey === defaultRow)?.key.trim();

  const save = useMutation({
    mutationFn: () =>
      flagApi.replaceVariants(project.id, flag.id, {
        lastKnownUpdatedAt: flag.updatedAt,
        variants: rows.map((r) => ({
          ...(r.id === undefined ? {} : { id: r.id }),
          key: r.key.trim(),
          value: parseVariantValue(flag.flagType, r.value),
        })),
        ...(defaultKey === undefined ? {} : { defaultVariantKey: defaultKey }),
        ...(needsKey ? { confirmFlagKey: typed.trim() } : {}),
      }),
    onSuccess: async () => {
      toast.info("Đã lưu variant");
      await queryClient.invalidateQueries({
        queryKey: qkPrefix.flagOf(project.id, flag.id),
      });
      await queryClient.invalidateQueries({
        queryKey: qkPrefix.flagsOf(project.id),
      });
      onClose();
    },
  });
  const fields = fieldErrorsOf(save.error);
  const edit = (i: number, patch: Partial<Row>) =>
    setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const ready =
    dirty &&
    !save.isPending &&
    rows.every((r) => r.key.trim() !== "") &&
    (!needsKey || typed.trim() === flag.key);

  return (
    <Dialog
      title="Sửa variant"
      description="Giá trị mới tới SDK ở mọi environment ngay khi lưu. Variant đang được rule hay environment dùng thì không bỏ được."
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className="btn" data-close onClick={onClose}>
            Huỷ
          </button>
          <button
            type="button"
            className={needsKey ? "btn danger-fill" : "btn pri"}
            disabled={!ready}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Đang lưu..." : "Lưu"}
          </button>
        </>
      }
    >
      <div className="f">
        <span className="lbl">Variant (chọn một làm mặc định)</span>
        {rows.map((r, i) => (
          <div key={r.localKey} className="line">
            <input
              type="radio"
              name="variant-default"
              aria-label={`Mặc định: variant ${String(i + 1)}`}
              checked={defaultRow === r.localKey}
              onChange={() => setDefaultRow(r.localKey)}
            />
            <input
              className="inp mono"
              aria-label={`Key variant ${String(i + 1)}`}
              value={r.key}
              onChange={(e) => edit(i, { key: e.target.value })}
            />
            <input
              className="inp mono"
              aria-label={`Giá trị variant ${String(i + 1)}`}
              placeholder={flag.flagType === "JSON" ? '{"a":1}' : ""}
              value={r.value}
              onChange={(e) => edit(i, { value: e.target.value })}
            />
            <button
              type="button"
              className="ib"
              aria-label={`Bỏ variant ${String(i + 1)}`}
              disabled={rows.length <= 2}
              onClick={() => setRows(rows.filter((_, j) => j !== i))}
            >
              <Icon of={X} />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="btn"
          onClick={() => {
            nextRow += 1;
            setRows([
              ...rows,
              { localKey: `new-${String(nextRow)}`, key: "", value: "" },
            ]);
          }}
        >
          <Icon of={Plus} />
          Thêm variant
        </button>
        {Object.entries(fields)
          .filter(([f]) => f.startsWith("variants"))
          .map(([f, message]) => (
            <span key={f} className="field-error">
              {message}
            </span>
          ))}
      </div>
      {needsKey && (
        <div className="f">
          <label htmlFor="variants-key">
            Gõ <span className="mono">{flag.key}</span> để lưu cho flag đang
            phục vụ
          </label>
          <input
            id="variants-key"
            className="inp"
            autoComplete="off"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
        </div>
      )}
      {save.isError && (
        <p role="alert" className="field-error">
          {messageOf(save.error)}
        </p>
      )}
    </Dialog>
  );
}
