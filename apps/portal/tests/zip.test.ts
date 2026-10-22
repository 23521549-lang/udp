import { describe, expect, it } from "vitest";
import { crc32, zip } from "../src/features/code/zip";

/**
 * Bộ ghi ZIP "store" của Golden Path — đọc ngược bằng chính cấu trúc định dạng (bản ghi cuối, thư mục
 * trung tâm, header cục bộ) để chắc một trình giải nén bất kỳ đọc được.
 */

function unzip(bytes: Uint8Array): { path: string; content: string }[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  const out: { path: string; content: string }[] = [];
  for (let i = 0; i < count; i += 1) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const local = view.getUint32(at + 42, true);
    const path = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    expect(view.getUint32(local, true)).toBe(0x04034b50);
    const start = local + 30 + view.getUint16(local + 26, true);
    const data = bytes.subarray(start, start + size);
    expect(crc32(data)).toBe(crc);
    out.push({ path, content: decoder.decode(data) });
    at += 46 + nameLength;
  }
  return out;
}

describe("zip", () => {
  it("crc32 đúng giá trị chuẩn", () => {
    expect(crc32(new TextEncoder().encode("hello"))).toBe(0x3610a686);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it("đọc ngược được đủ tệp, đúng nội dung, kể cả tên và nội dung có dấu", () => {
    const entries = [
      { path: "src/app.ts", content: "export {};\n" },
      { path: "k8s/triển-khai.yaml", content: "name: Nguyễn 😀\n" },
      { path: "empty.txt", content: "" },
    ];
    expect(unzip(zip(entries))).toEqual(entries);
  });

  it("cùng cây tệp ⇒ cùng chuỗi byte (thời gian cố định)", () => {
    const entries = [{ path: "a", content: "b" }];
    expect(zip(entries)).toEqual(zip(entries));
  });
});
