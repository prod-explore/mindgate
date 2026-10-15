import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DailyColumns } from './charts';


const series = [
  { key: 'local' as const, label: 'local', color: 'var(--series-local)' },
  { key: 'cloud' as const, label: 'cloud', color: 'var(--series-cloud)' },
];
const points = [
  { day: '2026-10-12', local: 10, cloud: 0 },
  { day: '2026-10-13', local: 0, cloud: 20 },
  { day: '2026-10-14', local: 30, cloud: 15 },
];
const draw = (over: Partial<Parameters<typeof DailyColumns>[0]> = {}) => render(<DailyColumns points={points} series={series} title="Requests per day" {...over} />);

describe('daily columns', () => {
  it('draws one column per day, thin, with a rounded top and the two parts stacked', () => {
    const { container } = draw();
    const cols = container.querySelectorAll('.chart-col');
    expect(cols).toHaveLength(3);
    // the last day has both: a square lower part and a rounded upper part
    const last = cols[2]!;
    const lower = last.querySelector('rect:not(.chart-hit)')!;
    const upper = last.querySelector('path')!;
    expect(lower).toHaveAttribute('fill', 'var(--series-local)');
    expect(upper).toHaveAttribute('fill', 'var(--series-cloud)');
    expect(upper.getAttribute('d')).toContain('Q'); // the rounded data end
    expect(Number(lower.getAttribute('width'))).toBeLessThanOrEqual(24);
    // a gap between the two parts: the lower one stops short of the upper one
    const lowerTop = Number(lower.getAttribute('y'));
    const lowerBottom = lowerTop + Number(lower.getAttribute('height'));
    const upperTop = Number(/M[\d.]+ [\d.]+V([\d.]+)/.exec(upper.getAttribute('d')!)?.[1]) - 4; // the path starts at the foot and goes up by the corner radius
    expect(lowerTop).toBeGreaterThan(upperTop);
    expect(lowerBottom).toBeGreaterThan(lowerTop);
  });

  it('keeps columns thin however wide the chart is', () => {
    const many = Array.from({ length: 3 }, (_, i) => ({ day: `2026-10-${10 + i}`, local: 5, cloud: 0 }));
    const { container } = draw({ points: many });
    for (const p of container.querySelectorAll('.chart-col path')) {
      const d = p.getAttribute('d')!;
      const x = Number(/^M([\d.]+) /.exec(d)![1]);
      const right = Number(/H([\d.]+)Q/.exec(d)![1]) + 4;
      expect(right - x).toBeLessThanOrEqual(24);
    }
  });

  it('names both series in the legend with their totals', () => {
    draw();
    const legend = document.querySelector('.chart-legend')!;
    expect(within(legend as HTMLElement).getByText('local').parentElement).toHaveTextContent('40');
    expect(within(legend as HTMLElement).getByText('cloud').parentElement).toHaveTextContent('35');
  });

  it('shows one tooltip with both series for the day under the pointer, and forgets it again', () => {
    const { container } = draw();
    const hits = container.querySelectorAll('.chart-hit');
    expect(hits).toHaveLength(3);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    fireEvent.pointerOver(hits[2]!);
    const tip = screen.getByRole('tooltip');
    expect(tip).toHaveTextContent('14 Oct');
    expect(tip).toHaveTextContent('30');
    expect(tip).toHaveTextContent('15');
    expect(tip).toHaveTextContent('local');
    expect(tip).toHaveTextContent('cloud');
    fireEvent.pointerLeave(container.querySelector('.chart-plot')!);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('works from the keyboard: every day can take focus and says what it holds', () => {
    const { container } = draw();
    const hit = container.querySelectorAll('.chart-hit')[1] as SVGElement;
    expect(hit).toHaveAttribute('tabindex', '0');
    expect(hit).toHaveAttribute('aria-label', '13 Oct: local 0, cloud 20');
    fireEvent.focus(hit);
    expect(screen.getByRole('tooltip')).toHaveTextContent('13 Oct');
    fireEvent.blur(hit);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('has the same numbers as a table, newest day first, with totals', () => {
    draw();
    const table = screen.getByRole('table', { hidden: true });
    const rows = within(table).getAllByRole('row', { hidden: true }).slice(1);
    expect(rows).toHaveLength(3);
    const first = within(rows[0]!).getAllByRole('cell', { hidden: true }).map(c => c.textContent);
    expect(first).toEqual(['2026-10-14', '30', '15', '45']);
    const last = within(rows[2]!).getAllByRole('cell', { hidden: true }).map(c => c.textContent);
    expect(last).toEqual(['2026-10-12', '10', '0', '10']);
  });

  it('says when there is nothing to draw', () => {
    draw({ points: points.map(p => ({ ...p, local: 0, cloud: 0 })) });
    expect(screen.getByText('No requests in this period.')).toBeInTheDocument();
  });

  it('dims the old picture while a new range loads', () => {
    const { container, rerender } = draw();
    expect(container.querySelector('.chart-plot')).not.toHaveClass('is-stale');
    rerender(<DailyColumns points={points} series={series} title="Requests per day" stale />);
    expect(container.querySelector('.chart-plot')).toHaveClass('is-stale');
  });

  it('is a labelled figure for screen readers', () => {
    draw();
    expect(screen.getByRole('figure', { name: 'Requests per day' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Requests per day' })).toBeInTheDocument();
  });

  it('puts the biggest day below the top of the axis', () => {
    const { container } = draw();
    const tops = [...container.querySelectorAll('.chart-col')].map(c => {
      const path = c.querySelector('path');
      return path ? Number(/V([\d.]+)Q/.exec(path.getAttribute('d')!)?.[1]) - 4 : Infinity;
    });
    expect(Math.min(...tops)).toBeGreaterThanOrEqual(10 - 0.001); // the top margin
  });
});
