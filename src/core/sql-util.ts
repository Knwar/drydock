/**
 * Build an optional-filter WHERE clause: for each key whose value is defined,
 * emit `key = ?` and collect its param. Preserves the trailing space after the
 * clause so callers can concatenate the following SQL (ORDER BY / LIMIT) directly.
 */
export function buildWhere(filters: Record<string, string | number | undefined>): {
  clause: string;
  params: (string | number)[];
} {
  const where: string[] = [];
  const params: (string | number)[] = [];
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined) {
      where.push(`${key} = ?`);
      params.push(value);
    }
  }
  return { clause: where.length ? `WHERE ${where.join(' AND ')} ` : '', params };
}
