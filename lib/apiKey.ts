export function maskKey(key: string): string {
  if (key.length <= 8) return "sk-****";
  return `${key.slice(0, 6)}****${key.slice(-4)}`;
}
