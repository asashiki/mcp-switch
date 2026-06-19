import { useT } from "@/i18n";

export default function Toggle({
  on, onChange, small, disabled,
}: { on: boolean; onChange: (v: boolean) => void; small?: boolean; disabled?: boolean }) {
  const t = useT();
  return (
    <button
      type="button"
      className={`sw ${on ? "on" : ""} ${small ? "sm" : ""} ${disabled ? "disabled" : ""}`}
      onClick={() => { if (!disabled) onChange(!on); }}
      disabled={disabled}
      aria-pressed={on}
      aria-label={on ? t("agents.enabled") : t("filter.disabled")}
    />
  );
}
