/**
 * Tiền tố của mọi route API (§9).
 *
 * Ở một file riêng chứ không trong `app.ts`: từ [v4.9] còn một chỗ nữa cần nó —
 * vị từ `isSegmentWriteRequest` khớp trên ĐƯỜNG DẪN ĐẦY ĐỦ của request để chừa
 * đường ghi segment ra khỏi parser toàn cục (V15). Để hằng này trong `app.ts`
 * thì `modules/segment` phải import ngược lên `app.ts`, mà `app.ts` đã import
 * xuống router của module đó — vòng phụ thuộc, và với ESM thì một trong hai bên
 * đọc được `undefined`. Chép lại chuỗi ở hai nơi thì vị từ trôi khỏi chỗ mount
 * mà không có gì báo.
 */
export const API_PREFIX = "/api/v1";
