import { defineMessages } from "../i18n";

/**
 * Câu gắn vào `ApiError` của lớp HTTP. Người dùng thường thấy câu của `messageOf` (theo `kind`), còn các
 * câu này đi vào `error.message` — nhật ký, công cụ dev, và mọi nơi hiện thẳng `message`.
 */
export const httpMessages = defineMessages({
  vi: {
    network: "Mất kết nối tới máy chủ",
    contract: (where: string) =>
      `Phản hồi của máy chủ không đúng hợp đồng (${where})`,
    root: "(gốc)",
  },
  en: {
    network: "Lost connection to the server",
    contract: (where: string) =>
      `The server response does not match the contract (${where})`,
    root: "(root)",
  },
});
