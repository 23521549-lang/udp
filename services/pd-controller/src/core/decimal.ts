/** `numeric(5,2)` của database — làm tròn ở JS để số ghi và số đọc giống nhau */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
