/** Video time as m:ss or h:mm:ss, the format used in answers and citation references. */
export function clockTime(milliseconds: number): string {
  const total = Math.floor(milliseconds / 1000);
  const [hours, minutes, seconds] = [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60];
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}` : `${minutes}:${String(seconds).padStart(2, '0')}`;
}
