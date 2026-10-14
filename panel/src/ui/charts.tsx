import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useT } from '../i18n';
import { compact, num, shortDay } from '../lib/format';
import { niceTicks, type DayPoint } from '../lib/usage';

/** Width of an element, kept up to date, so the SVG draws in real pixels and its text is never scaled. */
function useWidth<T extends HTMLElement>(fallback = 640): [RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWidth(Math.max(240, Math.floor(el.getBoundingClientRect().width)) || fallback);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fallback]);
  return [ref, width];
}

const M = { top: 10, right: 6, bottom: 26, left: 42 };
const GAP = 2; // the surface-coloured gap between stacked segments
const MAX_BAR = 24;
const R = 4; // rounded data end

/** A column with the top corners rounded and a square foot (it grows from the baseline). */
function roundedTop(x: number, y: number, w: number, h: number): string {
  const r = Math.min(R, w / 2, h);
  return `M${x} ${y + h}V${y + r}Q${x} ${y} ${x + r} ${y}H${x + w - r}Q${x + w} ${y} ${x + w} ${y + r}V${y + h}Z`;
}

export interface SeriesDef {
  key: 'local' | 'cloud';
  label: string;
  /** a CSS colour, normally one of the --series-* tokens */
  color: string;
}

interface ColumnsProps {
  points: DayPoint[];
  series: SeriesDef[];
  /** For the screen-reader label and the table caption, e.g. "Tokens per day". */
  title: string;
  height?: number;
  /** While a new range loads, the old picture stays (dimmed) instead of jumping. */
  stale?: boolean;
  formatValue?: (n: number) => string;
  /** Rendered under the chart as the table view. */
  tableLabel?: string;
}

/**
 * Stacked daily columns, local over cloud. Thin columns (24px at most) with a rounded top, a 2px surface gap between
 * the two parts, one tooltip for both series per day, keyboard focus on every day, and the same numbers as a table.
 */
export function DailyColumns({ points, series, title, height = 210, stale, formatValue = num, tableLabel }: ColumnsProps) {
  const t = useT();
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const tipId = useId();

  const inner = { w: width - M.left - M.right, h: height - M.top - M.bottom };
  const totals = points.map(p => p.local + p.cloud);
  const { max, ticks } = niceTicks(Math.max(0, ...totals));
  const band = points.length ? inner.w / points.length : inner.w;
  const barW = Math.min(MAX_BAR, Math.max(2, band - 4));
  const y = (v: number) => M.top + inner.h - (v / max) * inner.h;
  const labelEvery = Math.max(1, Math.ceil(52 / Math.max(band, 1)));
  const sums = series.map(s => ({ ...s, total: points.reduce((a, p) => a + p[s.key], 0) }));
  const empty = totals.every(v => v === 0);

  useEffect(() => setActive(null), [points]);

  const tip = active !== null ? points[active] : null;
  const tipLeft = active !== null ? M.left + band * active + band / 2 : 0;

  return (
    <figure className="chart" aria-label={title}>
      <div className="chart-legend">
        {sums.map(s => (
          <span key={s.key} className="legend-item">
            <i className="legend-swatch" style={{ background: s.color }} aria-hidden="true" />
            {s.label}
            <b>{formatValue(s.total)}</b>
          </span>
        ))}
      </div>
      <div ref={ref} className={`chart-plot${stale ? ' is-stale' : ''}`} onPointerLeave={() => setActive(null)}>
        <svg width={width} height={height} role="img" aria-label={title}>
          {ticks.map(v => (
            <g key={v}>
              <line x1={M.left} x2={width - M.right} y1={y(v)} y2={y(v)} className={v === 0 ? 'chart-base' : 'chart-grid'} />
              <text x={M.left - 8} y={y(v)} dy="0.32em" textAnchor="end" className="chart-tick">
                {compact(v)}
              </text>
            </g>
          ))}
          {points.map((p, i) => {
            const x = M.left + band * i + (band - barW) / 2;
            const isActive = active === i;
            let acc = 0;
            const parts = series.filter(s => p[s.key] > 0);
            return (
              <g key={p.day} className={`chart-col${active !== null && !isActive ? ' is-dim' : ''}`}>
                {parts.map((s, idx) => {
                  const v = p[s.key];
                  const top = y(acc + v);
                  const bottom = y(acc);
                  const isTop = idx === parts.length - 1;
                  const h = Math.max(1, bottom - top - (isTop ? 0 : GAP));
                  const full = Math.max(1, bottom - top);
                  const yy = top;
                  acc += v;
                  return isTop ? <path key={s.key} d={roundedTop(x, bottom - full, barW, full)} fill={s.color} /> : <rect key={s.key} x={x} y={yy + GAP} width={barW} height={h} fill={s.color} />;
                })}
                {i % labelEvery === 0 ? (
                  <text x={M.left + band * i + band / 2} y={height - 8} textAnchor="middle" className="chart-tick">
                    {shortDay(p.day)}
                  </text>
                ) : null}
                {/* the whole day is the hit target, not just the thin column */}
                <rect
                  x={M.left + band * i}
                  y={M.top}
                  width={band}
                  height={inner.h}
                  fill="transparent"
                  tabIndex={0}
                  className="chart-hit"
                  aria-label={`${shortDay(p.day)}: ${series.map(s => `${s.label} ${formatValue(p[s.key])}`).join(', ')}`}
                  aria-describedby={isActive ? tipId : undefined}
                  onPointerEnter={() => setActive(i)}
                  onPointerMove={() => setActive(i)}
                  onFocus={() => setActive(i)}
                  onBlur={() => setActive(null)}
                />
              </g>
            );
          })}
        </svg>
        {tip ? (
          <div id={tipId} role="tooltip" className="chart-tip" style={{ left: Math.min(Math.max(tipLeft, 70), width - 70) }}>
            <div className="chart-tip-day">{shortDay(tip.day)}</div>
            {series.map(s => (
              <div key={s.key} className="chart-tip-row">
                <i className="legend-line" style={{ background: s.color }} aria-hidden="true" />
                <b>{formatValue(tip[s.key])}</b>
                <span>{s.label}</span>
              </div>
            ))}
          </div>
        ) : null}
        {empty ? <p className="chart-empty">{t('chart.no_data')}</p> : null}
      </div>
      <details className="chart-table">
        <summary>{tableLabel ?? t('chart.table')}</summary>
        <div className="table-wrap">
          <table className="table">
            <caption className="visually-hidden">{title}</caption>
            <thead>
              <tr>
                <th>{t('chart.day')}</th>
                {series.map(s => (
                  <th key={s.key} className="num">
                    {s.label}
                  </th>
                ))}
                <th className="num">{t('chart.total')}</th>
              </tr>
            </thead>
            <tbody>
              {[...points].reverse().map(p => (
                <tr key={p.day}>
                  <td>{p.day}</td>
                  {series.map(s => (
                    <td key={s.key} className="num">
                      {formatValue(p[s.key])}
                    </td>
                  ))}
                  <td className="num">{formatValue(p.local + p.cloud)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

/** Two numbers, side by side: a label, the value, nothing else. */
export function Figure({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="figure">
      <dt>{label}</dt>
      <dd>{value}</dd>
      {sub ? <dd className="figure-sub">{sub}</dd> : null}
    </div>
  );
}
