import { useEffect, useRef, useState } from "react";
import { Camera, ImagePlus, Loader2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  type FuelReceipt,
  prepareReceiptImage,
  readFuelReceipt,
  ReceiptError,
} from "@/lib/fuel-receipt";
import { parseFuelNumber } from "@/lib/fuel-entry";
import {
  type Currency,
  litresPerUnit,
  type VolumeUnit,
} from "@/lib/fuel-units";

export function FuelPhotoImport(
  { carId, volumeUnit, disabled, onBusyChange, onPendingChange, onApply }: {
    carId: string;
    volumeUnit: VolumeUnit;
    disabled: boolean;
    onBusyChange: (busy: boolean) => void;
    onPendingChange: (pending: boolean) => void;
    onApply: (
      patch: { paid?: string; amount?: string; currency?: Currency },
    ) => void;
  },
) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false),
    [image, setImage] = useState<string | null>(null),
    [working, setWorking] = useState(false),
    [error, setError] = useState(""),
    [applied, setApplied] = useState(false);
  const [review, setReview] = useState<
    { paid: string; quantity: string; currency: string; unit: string } | null
  >(null);
  const [missing, setMissing] = useState(false);
  const camera = useRef<HTMLInputElement>(null),
    gallery = useRef<HTMLInputElement>(null),
    job = useRef<AbortController | null>(null),
    inFlight = useRef(false),
    generation = useRef(0);
  useEffect(() => () => {
    generation.current++;
    job.current?.abort();
  }, []);
  useEffect(() => onPendingChange(!!image || !!review || working), [
    image,
    review,
    working,
    onPendingChange,
  ]);
  useEffect(() => () => onPendingChange(false), [onPendingChange]);
  const busy = (value: boolean) => {
    inFlight.current = value;
    setWorking(value);
    onBusyChange(value);
  };
  const select = async (file: File | undefined) => {
    if (!file || disabled || inFlight.current) return;
    const token = ++generation.current;
    busy(true);
    setError("");
    setReview(null);
    setApplied(false);
    setImage(null);
    try {
      const next = await prepareReceiptImage(file);
      if (generation.current === token) setImage(next);
    } catch (e) {
      if (generation.current === token) {
        setError(e instanceof ReceiptError ? e.message : "invalid_image");
      }
    } finally {
      if (generation.current === token) busy(false);
    }
  };
  const analyze = async () => {
    if (!image || disabled || inFlight.current) return;
    const token = ++generation.current;
    busy(true);
    setError("");
    const controller = new AbortController();
    job.current = controller;
    const timeout = setTimeout(() => controller.abort(), 45000);
    try {
      const result: FuelReceipt = await readFuelReceipt(
        carId,
        image,
        controller.signal,
      );
      if (generation.current !== token) return;
      setMissing(result.totalPaid === null || result.quantity === null);
      setReview({
        paid: result.totalPaid === null ? "" : String(result.totalPaid),
        quantity: result.quantity === null ? "" : String(result.quantity),
        currency: result.currency ?? "",
        unit: result.volumeUnit ?? "",
      });
    } catch (e) {
      if (generation.current === token) {
        setError(e instanceof ReceiptError ? e.message : "unavailable");
      }
    } finally {
      clearTimeout(timeout);
      if (generation.current === token) busy(false);
    }
  };
  const apply = () => {
    if (!review || !valid) return;
    const patch: { paid?: string; amount?: string; currency?: Currency } = {};
    const paid = parseFuelNumber(review.paid),
      quantity = parseFuelNumber(review.quantity);
    if (review.paid) {
      patch.paid = String(paid);
      patch.currency = review.currency as Currency;
    }
    if (review.quantity) {
      const factor = review.unit === "imperial gal"
        ? 4.54609
        : litresPerUnit(review.unit as VolumeUnit);
      patch.amount = String(
        Number((quantity * factor / litresPerUnit(volumeUnit)).toFixed(6)),
      );
    }
    onApply(patch);
    setOpen(false);
    setApplied(true);
    setImage(null);
    setReview(null);
  };
  const positive = (value: string, max: number) => {
    const number = parseFuelNumber(value);
    return Number.isFinite(number) && number > 0 && number < max;
  };
  const valid = review &&
    (!review.paid ||
      (positive(review.paid, 1_000_000) &&
        ["USD", "BRL", "EUR"].includes(review.currency))) &&
    (!review.quantity ||
      (positive(review.quantity, 2000) &&
        ["L", "US gal", "imperial gal"].includes(review.unit))) &&
    (!!review.paid || !!review.quantity);
  const reason = error === "limit_reached"
    ? "limit"
    : error === "not_configured" || error === "vision_unavailable"
    ? "notConfigured"
    : error === "unreadable"
    ? "unreadable"
    : error === "image_too_large"
    ? "tooLarge"
    : error === "invalid_image"
    ? "invalid"
    : "failed";
  return (
    <section className="space-y-3">
      {!open && (
        <Button
          type="button"
          variant="outline"
          className="w-full"
          disabled={disabled}
          onClick={() => {
            setOpen(true);
            setApplied(false);
          }}
        >
          <Camera className="h-4 w-4" />
          {t("fuel.photo.open", "Fill from a photo")}
        </Button>
      )}
      {applied && (
        <p role="status" className="text-sm text-success">
          {t(
            "fuel.photo.applied",
            "Values filled in. Review the form and tap Save.",
          )}
        </p>
      )}
      {open && (
        <div className="space-y-4 rounded-xl border border-border p-4">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">
              {t("fuel.photo.title", "Receipt or pump photo")}
            </h3>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              disabled={disabled}
              aria-label={t("common.close", "Close")}
              onClick={() => {
                generation.current++;
                job.current?.abort();
                busy(false);
                setOpen(false);
                setImage(null);
                setReview(null);
                setError("");
              }}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant="secondary"
              disabled={working || disabled}
              onClick={() => camera.current?.click()}
            >
              <Camera className="h-4 w-4" />
              {t("fuel.photo.camera", "Take photo")}
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={working || disabled}
              onClick={() => gallery.current?.click()}
            >
              <ImagePlus className="h-4 w-4" />
              {t("fuel.photo.choose", "Choose photo")}
            </Button>
          </div>
          <input
            ref={camera}
            aria-label={t("fuel.photo.camera", "Take photo")}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            capture="environment"
            className="hidden"
            onChange={(event) => {
              void select(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
          <input
            ref={gallery}
            aria-label={t("fuel.photo.choose", "Choose photo")}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={(event) => {
              void select(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
          {image && (
            <img
              src={image}
              alt={t("fuel.photo.preview", "Selected receipt or pump")}
              className="max-h-40 w-full rounded-lg bg-muted object-contain"
            />
          )}
          {!review && (
            <>
              <p className="text-xs text-muted-foreground">
                {t(
                  "fuel.photo.privacy",
                  "Sends this photo to our AI provider (OpenRouter). Check the result before using it. The photo is not attached to your fill-up.",
                )}
              </p>
              <Button
                type="button"
                className="w-full"
                disabled={!image || working || disabled}
                onClick={() => void analyze()}
              >
                {working && <Loader2 className="h-4 w-4 animate-spin" />}
                {working
                  ? t("fuel.photo.reading", "Reading photo…")
                  : t("fuel.photo.read", "Read this photo")}
              </Button>
            </>
          )}
          {review && (
            <div className="space-y-3">
              <p className="text-sm font-medium">
                {t("fuel.photo.review", "Check what was read")}
              </p>
              {missing && (
                <p className="text-xs text-muted-foreground">
                  {t(
                    "fuel.photo.partial",
                    "Some values were not visible. You can fill them in manually.",
                  )}
                </p>
              )}
              <div className="space-y-1.5">
                <Label htmlFor="receipt-paid">
                  {t("fuel.photo.total", "Total on the photo")}
                </Label>
                <Input
                  id="receipt-paid"
                  inputMode="decimal"
                  value={review.paid}
                  onChange={(e) =>
                    setReview({ ...review, paid: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="receipt-currency">
                  {t("fuel.currency", "Currency")}
                </Label>
                <select
                  id="receipt-currency"
                  className="h-11 w-full rounded-xl border border-input bg-background px-3 text-sm"
                  value={review.currency}
                  onChange={(e) =>
                    setReview({ ...review, currency: e.target.value })}
                >
                  <option value="">
                    {t("fuel.photo.confirmCurrency", "Confirm currency")}
                  </option>
                  {["USD", "BRL", "EUR"].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="receipt-quantity">
                  {t("fuel.photo.quantity", "Quantity on the photo")}
                </Label>
                <Input
                  id="receipt-quantity"
                  inputMode="decimal"
                  value={review.quantity}
                  onChange={(e) =>
                    setReview({ ...review, quantity: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="receipt-unit">
                  {t("fuel.photo.unit", "Unit on the photo")}
                </Label>
                <select
                  id="receipt-unit"
                  className="h-11 w-full rounded-xl border border-input bg-background px-3 text-sm"
                  value={review.unit}
                  onChange={(e) =>
                    setReview({ ...review, unit: e.target.value })}
                >
                  <option value="">
                    {t("fuel.photo.confirmUnit", "Confirm unit")}
                  </option>
                  {["L", "US gal", "imperial gal"].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </div>
              <Button
                type="button"
                className="w-full"
                disabled={!valid}
                onClick={apply}
              >
                {t("fuel.photo.use", "Use these values")}
              </Button>
            </div>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {t(
                `fuel.photo.${reason}`,
                reason === "limit"
                  ? "Daily photo limit reached. You can still enter the values manually."
                  : reason === "notConfigured"
                  ? "Photo reading is not available with the current AI configuration. Enter the values manually."
                  : reason === "unreadable"
                  ? "Could not read fuel values clearly. Try a closer photo or enter them manually."
                  : reason === "tooLarge"
                  ? "This photo is too large. Crop it or take another at a lower resolution."
                  : reason === "invalid"
                  ? "Choose a JPG, PNG or WebP photo up to 12 MB."
                  : "Could not read the photo. Try again or enter the values manually.",
              )}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
