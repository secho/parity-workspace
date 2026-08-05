import { useMemo, useState, type ReactNode } from 'react';

export interface Column<T> {
  key: string;
  header: string;
  numeric?: boolean;
  sortable?: boolean;
  /** Sort key. Falls back to the rendered value being a string. */
  value?: (row: T) => string | number | null;
  render: (row: T) => ReactNode;
}

interface Props<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  initialSort?: { key: string; direction: 'asc' | 'desc' };
  empty?: ReactNode;
}

/** A dense sortable table. The Estate list is column-sortable per SPEC §4. */
export function DataTable<T>({ columns, rows, rowKey, initialSort, empty }: Props<T>): JSX.Element {
  const [sort, setSort] = useState(initialSort ?? null);

  const sorted = useMemo(() => {
    if (sort === null) return rows;
    const column = columns.find((c) => c.key === sort.key);
    if (column?.value === undefined) return rows;
    const direction = sort.direction === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = column.value!(a);
      const vb = column.value!(b);
      if (va === null && vb === null) return 0;
      if (va === null) return 1;
      if (vb === null) return -1;
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * direction;
      return String(va).localeCompare(String(vb), 'cs') * direction;
    });
  }, [rows, sort, columns]);

  const toggle = (key: string): void =>
    setSort((current) =>
      current?.key === key ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' } : { key, direction: 'asc' },
    );

  if (rows.length === 0 && empty !== undefined) return <div className="empty">{empty}</div>;

  return (
    <table>
      <thead>
        <tr>
          {columns.map((column) => (
            <th
              key={column.key}
              className={[column.numeric ? 'num' : '', column.sortable !== false && column.value ? 'sortable' : '']
                .filter(Boolean)
                .join(' ')}
              onClick={column.sortable !== false && column.value ? () => toggle(column.key) : undefined}
            >
              {column.header}
              {sort?.key === column.key && <span className="arrow">{sort.direction === 'asc' ? '▲' : '▼'}</span>}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {sorted.map((row) => (
          <tr key={rowKey(row)}>
            {columns.map((column) => (
              <td key={column.key} className={column.numeric ? 'num' : ''}>
                {column.render(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
