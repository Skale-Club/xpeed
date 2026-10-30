import { supabase } from "@/integrations/supabase/client";
import {
  type FuelReceipt,
  MAX_RECEIPT_BYTES,
  parseFuelReceipt,
} from "../../supabase/functions/_shared/fuel-receipt";
export type { FuelReceipt };
export class ReceiptError extends Error {}
/** Resize and re-encode locally: only the selected image, without its EXIF metadata. */
export async function prepareReceiptImage(file: File): Promise<string> {
  if (
    !["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
    file.size === 0 || file.size > 12 * 1024 * 1024
  ) throw new ReceiptError("invalid_image");
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new ReceiptError("invalid_image");
  }
  try {
    if (bitmap.width * bitmap.height > 40_000_000) {
      throw new ReceiptError("image_too_large");
    }
    const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new ReceiptError("invalid_image");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (value) =>
          value ? resolve(value) : reject(new ReceiptError("invalid_image")),
        "image/jpeg",
        .88,
      )
    );
    if (blob.size > MAX_RECEIPT_BYTES) {
      throw new ReceiptError("image_too_large");
    }
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new ReceiptError("invalid_image"));
      reader.readAsDataURL(blob);
    });
  } finally {
    bitmap.close();
  }
}
export async function readFuelReceipt(
  carId: string,
  image: string,
  signal: AbortSignal,
): Promise<FuelReceipt> {
  const { data, error } = await supabase.functions.invoke("read-fuel-receipt", {
    body: { carId, image },
    signal,
  });
  if (error) {
    let code = "unavailable";
    try {
      const response = (error as { context?: Response }).context;
      const body = await response?.json();
      if (typeof body?.code === "string") code = body.code;
    } catch { /* No provider detail is shown to the owner. */ }
    throw new ReceiptError(code);
  }
  const receipt = parseFuelReceipt(data?.receipt);
  if (!receipt) throw new ReceiptError("unreadable");
  return receipt;
}
