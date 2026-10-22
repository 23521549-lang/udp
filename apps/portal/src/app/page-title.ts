import { useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { messagesOf } from "../i18n";
import { shellUxMessages } from "./shell-ux.messages";

/**
 * [Plan #58 UX-31] Tiêu đề thẻ trình duyệt theo màn (WCAG 2.4.2): "Flag · checkout-service · UDP" thay vì cùng
 * "UDP Portal" cho mọi màn — lịch sử, thẻ và trình đọc màn hình phân biệt được các trang.
 *
 * Nguồn là CHÍNH `h1` của trang (mỗi trang có đúng một, cổng Playwright canh) và tên project ở thanh bên: không trang
 * nào phải tự khai tiêu đề, và tiêu đề đổi theo khi `h1` đổi (tên nhóm tải xong). Trả về câu thông báo khi ĐỔI trang
 * để vùng `aria-live` của khung đọc lên — điều hướng phía client không tự báo cho trình đọc màn hình.
 */
export function usePageTitle(): string {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [announce, setAnnounce] = useState("");

  useEffect(() => {
    const main = document.getElementById("main");
    if (main === null) return;
    let frame = 0;
    let announced = false;
    const update = (): void => {
      const h1 = main.querySelector("h1")?.textContent.trim() ?? "";
      const project =
        document
          .querySelector<HTMLElement>(".side .grp[translate='no']")
          ?.textContent.trim() ?? "";
      const parts = [h1, project === h1 ? "" : project].filter(Boolean);
      document.title = [
        ...parts,
        messagesOf(shellUxMessages).title.suffix,
      ].join(" · ");
      if (!announced && h1 !== "") {
        announced = true;
        setAnnounce(h1);
      }
    };
    const schedule = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    schedule();
    const observer = new MutationObserver(schedule);
    observer.observe(main, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [pathname]);

  return announce;
}
