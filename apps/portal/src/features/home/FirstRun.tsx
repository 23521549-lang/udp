import { Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { Icon } from "../../components/Icon";
import { InfoTip } from "../../components/InfoTip";
import { useMessages } from "../../i18n";
import { homeMessages } from "./home.messages";

/**
 * [Plan #58 UX-11] Lần đầu vào, chưa có project nào (Trang chủ và danh sách project): một câu nói UDP làm gì, ba
 * bước theo đúng thứ tự người mới đi được một mình (tạo project, flag chạy ngay chưa cần cloud, cloud để sau) và
 * MỘT nút chính. Thay cho "Bạn chưa tham gia project nào", nghe như phải chờ ai mời (Carbon, Primer: trạng thái
 * trống nói vì sao trống và việc tiếp theo).
 */
export function FirstRun() {
  const m = useMessages(homeMessages);
  const f = m.firstRun;
  return (
    <section className="first-run" aria-labelledby="first-run-h">
      <div className="sect">
        <h2 id="first-run-h">{f.title}</h2>
        <InfoTip term="project" />
      </div>
      <p className="c2">{f.intro}</p>
      <ol className="first-run-steps">
        {f.steps.map((s) => (
          <li key={s.title}>
            <b>{s.title}</b>
            <span className="c3">{s.body}</span>
          </li>
        ))}
      </ol>
      <Link to="/app/projects/new" className="btn pri">
        <Icon of={Plus} />
        {m.createFirst}
      </Link>
      <p className="c3">{f.invited}</p>
    </section>
  );
}
