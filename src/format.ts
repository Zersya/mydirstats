export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let v = bytes;
  let u = -1;
  do { v /= 1024; u++; } while (v >= 1024 && u < units.length - 1);
  return `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${units[u]}`;
}

export function exactBytes(bytes: number): string {
  return bytes.toLocaleString("en-US") + " bytes";
}

export function formatDate(unixSecs: number): string {
  if (!unixSecs) return "—";
  return new Date(unixSecs * 1000).toLocaleString("en-US", {
    year: "numeric", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit",
  });
}

// Truncate a path in the middle with an ellipsis, keeping head and tail.
export function truncateMiddle(path: string, maxChars: number): string {
  if (path.length <= maxChars) return path;
  const keep = maxChars - 1;
  const head = Math.ceil(keep * 0.4);
  const tail = keep - head;
  return path.slice(0, head) + "…" + path.slice(path.length - tail);
}
