// 极简内联折线图。后端 stats 端点上线前用于渲染样例 / 占位。
export default function Sparkline({
  points, stroke = "currentColor", height = 26,
}: { points: number[]; stroke?: string; height?: number }) {
  if (!points.length) return <svg className="spark" />;
  const w = 200;
  const h = height;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = Math.max(1, max - min);
  const step = points.length > 1 ? w / (points.length - 1) : 0;
  const path = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)},${(h - ((p - min) / span) * (h - 4) - 2).toFixed(1)}`)
    .join(" ");
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <path d={path} fill="none" stroke={stroke} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}
