/**
 * Phân vị từ bucket TÍCH LUỸ của histogram Prometheus — đúng thuật toán của
 * `histogram_quantile` (nội suy tuyến tính trong bucket chứa hạng cần tìm).
 *
 * Dùng cho nguồn không có hàm phân vị trên bucket Prometheus (Dynatrace): bên gọi lấy tổng số
 * đếm theo từng `le` trong cửa sổ rồi tính ở đây, nên p99 của mọi nguồn cùng một định nghĩa.
 *
 * `undefined` khi không tính được — không bucket, tổng 0, không có `+Inf` — vì "không biết"
 * không được thành một con số (I7).
 */
export function histogramQuantile(
  q: number,
  buckets: readonly { le: number; count: number }[],
): number | undefined {
  const sorted = [...buckets].sort((a, b) => a.le - b.le);
  const inf = sorted.at(-1);
  if (inf === undefined || inf.le !== Infinity || inf.count <= 0) {
    return undefined;
  }
  const rank = q * inf.count;
  let prevLe = 0;
  let prevCount = 0;
  for (const b of sorted) {
    if (b.count >= rank) {
      // Rơi vào bucket +Inf ⇒ cận trên của bucket hữu hạn cuối, như Prometheus
      if (b.le === Infinity) return prevLe;
      if (b.count === prevCount) return b.le;
      return (
        prevLe + ((b.le - prevLe) * (rank - prevCount)) / (b.count - prevCount)
      );
    }
    prevLe = b.le;
    prevCount = b.count;
  }
  return undefined;
}
