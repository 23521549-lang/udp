/*
 * Áp giao diện sáng/tối TRƯỚC khi trang vẽ lần đầu. Bundle chính là module (hoãn tới sau khi phân tích
 * HTML), nên nếu chỉ `main.tsx` đặt `data-theme` thì người dùng chế độ tối thấy một khung trắng loé lên.
 * Tệp riêng thay vì script inline: không cần nới Content-Security-Policy cho `unsafe-inline`.
 * Cùng khoá và cùng luật với `src/app/theme.ts`; màu của `theme-color` là `--bg` của bản mẫu.
 */
(function () {
  var theme = "light";
  try {
    var stored = localStorage.getItem("udp_theme");
    theme =
      stored === "dark" || stored === "light"
        ? stored
        : window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light";
  } catch (e) {
    // storage hay matchMedia bị chặn: giữ sáng
  }
  document.documentElement.dataset.theme = theme;
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta)
    meta.setAttribute("content", theme === "dark" ? "#0e0e10" : "#f3f4f6");
})();
