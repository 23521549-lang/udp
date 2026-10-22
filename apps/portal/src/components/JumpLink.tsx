import type { MouseEvent, ReactNode } from "react";

/** Người dùng xin giảm chuyển động; vài trình duyệt nhúng không có `matchMedia` dù kiểu DOM nói có */
function prefersStill(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * [Plan #59, dùng chung ở Plan #60] Link tới một phần của CHÍNH trang (trang giới thiệu, Điều khoản). Không để
 * trình duyệt tự nhảy theo `#id`: bản xem thử dùng hash history, nên `#faq` sẽ thành đường dẫn `/faq` của router. Cuộn bằng tay (êm, trừ khi người dùng xin giảm chuyển động) và đưa focus tới
 * phần đích để người dùng bàn phím và trình đọc màn hình đi theo.
 */
export function JumpLink({
  to,
  className,
  label,
  children,
}: {
  to: string;
  className?: string;
  label?: string;
  children: ReactNode;
}) {
  const go = (e: MouseEvent<HTMLAnchorElement>): void => {
    const target = document.getElementById(to);
    if (target === null) return;
    e.preventDefault();
    const still = prefersStill();
    target.scrollIntoView({
      behavior: still ? "auto" : "smooth",
      block: "start",
    });
    target.focus({ preventScroll: true });
  };
  return (
    <a
      href={`#${to}`}
      className={className}
      {...(label === undefined ? {} : { "aria-label": label })}
      onClick={go}
    >
      {children}
    </a>
  );
}
