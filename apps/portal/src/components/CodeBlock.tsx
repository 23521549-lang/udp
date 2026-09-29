import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Icon } from "./Icon";
import { toast } from "./Toast";

/**
 * Khối mã có nút sao chép — SDK key, đoạn mã dùng flag, lệnh setup cloud. Một chỗ cho
 * hành vi mà ba nơi cần giống hệt nhau: đổi biểu tượng khi đã chép, và báo lỗi khi trình
 * duyệt từ chối clipboard thay vì im lặng.
 */
export function CodeBlock({
  code,
  label,
  copyLabel = "Sao chép",
}: {
  code: string;
  /** Tên truy cập của khối, khi màn hình có nhiều khối */
  label?: string;
  copyLabel?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    // `aria-label` trên `<pre>` trơn bị trình đọc màn hình bỏ qua: tên đặt ở vùng bao ngoài
    <div
      className="code"
      {...(label === undefined ? {} : { role: "region", "aria-label": label })}
    >
      <pre translate="no">{code}</pre>
      <button
        type="button"
        className="ib cp"
        aria-label={copyLabel}
        onClick={() => {
          // clipboard vắng mặt ngoài HTTPS dù kiểu DOM nói có: đi qua Promise để thành lỗi bắt được
          void Promise.resolve()
            .then(() => navigator.clipboard.writeText(code))
            .then(
              () => {
                setCopied(true);
                toast.info("Đã sao chép");
              },
              () => toast.error("Không sao chép được, hãy chọn và chép tay"),
            );
        }}
      >
        <Icon of={copied ? Check : Copy} />
      </button>
    </div>
  );
}
