import Skeleton from "./Skeleton";

/** Matches the .dealer-list__stat card layout (icon chip + value + label). */
export default function StatSkeleton() {
  return (
    <div className="dealer-list__stat">
      <Skeleton width={32} height={32} radius="var(--radius-md)" />
      <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1 }}>
        <Skeleton width={40} height={18} />
        <Skeleton width={72} height={11} />
      </div>
    </div>
  );
}