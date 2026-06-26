import { COLOR_SWATCHES } from "./fontPresets";

type ColorSwatchGridProps = {
  onPick: (color: string) => void;
  onReset: () => void;
};

export function ColorSwatchGrid({ onPick, onReset }: ColorSwatchGridProps) {
  return (
    <div className="color-swatch-grid">
      <div className="color-swatch-grid__swatches">
        {COLOR_SWATCHES.map((color) => (
          <button
            key={color}
            type="button"
            className="color-swatch"
            style={{ backgroundColor: color }}
            aria-label={`Kolor ${color}`}
            onClick={() => onPick(color)}
          />
        ))}
      </div>
      <button type="button" className="color-swatch-grid__reset" onClick={onReset}>
        Domyślny
      </button>
    </div>
  );
}
