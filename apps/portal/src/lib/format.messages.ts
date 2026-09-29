import { defineMessages } from "../i18n";

/** Đơn vị của thời lượng (`formatDuration`): tiếng Việt viết đủ chữ, tiếng Anh viết gọn "2d 3h" */
export const formatMessages = defineMessages({
  vi: {
    unit: {
      day: (n: string) => `${n} ngày`,
      hour: (n: string) => `${n} giờ`,
      minute: (n: string) => `${n} phút`,
      second: (n: string) => `${n} giây`,
    },
  },
  en: {
    unit: {
      day: (n: string) => `${n}d`,
      hour: (n: string) => `${n}h`,
      minute: (n: string) => `${n}m`,
      second: (n: string) => `${n}s`,
    },
  },
});
