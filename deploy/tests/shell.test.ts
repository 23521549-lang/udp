import { afterEach, describe, expect, it } from "vitest";
import { has } from "../src/shell.js";

/**
 * `deploy:up` (kind) và `vm-up` hỏi công cụ TRƯỚC khi có cụm. `kubectl version` trần thoát mã 1 khi không nói được
 * với API server — trên một runner CI chưa có kubeconfig, bước kiểm công cụ từng báo "thiếu kubectl" dù nó có mặt.
 */

const saved = process.env["KUBECONFIG"];
afterEach(() => {
  if (saved === undefined) delete process.env["KUBECONFIG"];
  else process.env["KUBECONFIG"] = saved;
});

describe("has", () => {
  it("kubectl có mặt được nhận ra kể cả khi chưa có cụm nào để nói chuyện", () => {
    process.env["KUBECONFIG"] = "/khong-co-kubeconfig-nao-o-day";
    expect(has("kubectl")).toBe(true);
  });

  it("lệnh không tồn tại là không có", () => {
    expect(has("udp-lenh-khong-ton-tai")).toBe(false);
  });
});
