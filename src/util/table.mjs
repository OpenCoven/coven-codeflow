export function printRows(rows) {
  const widths = [];
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, String(cell).length);
    });
  }
  for (const row of rows) {
    console.log(row.map((cell, index) => String(cell).padEnd(widths[index])).join('  ').trimEnd());
  }
}
