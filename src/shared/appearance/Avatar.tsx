import { useUiStore } from "../../app/store";
import { initials, senderAvatarColor } from "./appearance";

export function Avatar({
  seed,
  label,
  size = 28,
  variant = "sender",
}: {
  seed: string;
  label: string;
  size?: number;
  variant?: "account" | "sender";
}) {
  const accent = useUiStore((s) => s.accent);
  const color = variant === "account" ? accent : senderAvatarColor(seed, accent);
  return (
    <span
      className="avatar"
      data-color={color}
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: color,
        color: "#fff",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: size * 0.4,
        fontWeight: 600,
        flexShrink: 0,
      }}
      aria-hidden="true"
    >
      {initials(label)}
    </span>
  );
}
