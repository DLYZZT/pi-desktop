import { useState } from "react";
import { RotateCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Checkbox } from "@/components/ui/Checkbox";
import { useI18n } from "@/i18n";
import {
  BROWSER_DEVICE_LIMITS,
  BROWSER_DEVICE_PRESETS,
  type BrowserDeviceMode,
  type BrowserDeviceModeInput,
  type BrowserDevicePresetId,
} from "../../../contract/browser-device";

type MobileDevice = Extract<BrowserDeviceMode, { mode: "mobile" }>;

export function BrowserDeviceToolbar({
  device,
  busy,
  onChange,
  onOpenChange,
}: {
  device: MobileDevice;
  busy: boolean;
  onChange: (input: BrowserDeviceModeInput) => void;
  onOpenChange: (open: boolean) => void;
}) {
  // The parent keys the toolbar on the applied dimensions, preserving an in-progress edit across unrelated tab events.
  const [width, setWidth] = useState(String(device.width));
  const [height, setHeight] = useState(String(device.height));
  const [dpr, setDpr] = useState(String(device.dpr));
  const { t } = useI18n();
  const { minSize, maxSize, minDpr, maxDpr } = BROWSER_DEVICE_LIMITS;
  const dirty = width !== String(device.width) || height !== String(device.height) || dpr !== String(device.dpr);
  const touch = t("browserDeviceTouch", "Touch");
  const rotate = t("browserDeviceRotate", "Rotate device");
  return (
    <form
      className="browser-device-toolbar"
      aria-label={t("browserDeviceMode", "Device mode")}
      onSubmit={(event) => {
        event.preventDefault();
        if (dirty && !busy)
          onChange({
            mode: "custom",
            width: Number(width),
            height: Number(height),
            dpr: Number(dpr),
            touch: device.touch,
          });
      }}
    >
      <Select
        size="sm"
        className="browser-device-preset"
        value={device.presetId ?? "custom"}
        disabled={busy}
        aria-label={t("browserDevicePreset", "Device preset")}
        onOpenChange={onOpenChange}
        options={[
          ...Object.entries(BROWSER_DEVICE_PRESETS).map(([value, { label }]) => ({ value, label })),
          { value: "custom", label: t("browserDeviceCustom", "Custom size") },
        ]}
        onChange={(value) =>
          onChange(
            value === "custom"
              ? { mode: "custom", width: device.width, height: device.height, dpr: device.dpr, touch: device.touch }
              : {
                  mode: "preset",
                  presetId: value as BrowserDevicePresetId,
                  orientation: device.orientation,
                  touch: device.touch,
                },
          )
        }
      />
      <div className="browser-device-fields">
        <Input
          size="sm"
          style={{ width: 62 }}
          type="number"
          aria-label={t("browserDeviceWidth", "Viewport width")}
          value={width}
          min={minSize}
          max={maxSize}
          required
          disabled={busy}
          onChange={(event) => setWidth(event.target.value)}
        />
        <span aria-hidden="true">×</span>
        <Input
          size="sm"
          style={{ width: 62 }}
          type="number"
          aria-label={t("browserDeviceHeight", "Viewport height")}
          value={height}
          min={minSize}
          max={maxSize}
          required
          disabled={busy}
          onChange={(event) => setHeight(event.target.value)}
        />
        <label className="browser-device-dpr">
          {t("browserDeviceDpr", "DPR")}
          <Input
            size="sm"
            style={{ width: 58 }}
            aria-label={t("browserDeviceDpr", "DPR")}
            type="number"
            value={dpr}
            min={minDpr}
            max={maxDpr}
            step="any"
            required
            disabled={busy}
            onChange={(event) => setDpr(event.target.value)}
          />
        </label>
      </div>
      <div className="browser-device-actions">
        {dirty && (
          <Button type="submit" size="sm" disabled={busy}>
            {t("browserDeviceApply", "Apply")}
          </Button>
        )}
        <Checkbox
          size="sm"
          label={touch}
          checked={device.touch}
          disabled={busy}
          onChange={(enabled) =>
            onChange(
              device.presetId
                ? { mode: "preset", presetId: device.presetId, orientation: device.orientation, touch: enabled }
                : {
                    mode: "custom",
                    width: device.width,
                    height: device.height,
                    dpr: device.dpr,
                    orientation: device.orientation,
                    touch: enabled,
                  },
            )
          }
        />
        <Button
          variant="ghost"
          size="icon"
          className="browser-chrome-icon"
          title={rotate}
          aria-label={rotate}
          disabled={busy}
          onClick={() => onChange({ mode: "rotate" })}
        >
          <RotateCw size={15} aria-hidden="true" />
        </Button>
      </div>
    </form>
  );
}
