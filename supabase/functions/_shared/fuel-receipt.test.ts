import { parseFuelReceipt, validReceiptImage } from "./fuel-receipt.ts";
const valid = {
  totalPaid: 35.5,
  quantity: 10,
  currency: "USD",
  volumeUnit: "US gal",
};
Deno.test("accepts partial readings but never invents currency or gallon standard", () => {
  const partial = {
    totalPaid: 35,
    quantity: null,
    currency: null,
    volumeUnit: null,
  };
  if (!parseFuelReceipt(partial) || !parseFuelReceipt(valid)) {
    throw Error("Valid receipt rejected");
  }
  if (parseFuelReceipt({ ...valid, totalPaid: null, quantity: null })) {
    throw Error("Accepted empty reading");
  }
});
Deno.test("rejects malformed, infinite, negative, oversized and unsupported receipt fields", () => {
  for (
    const value of [
      null,
      {},
      [],
      { ...valid, quantity: Infinity },
      { ...valid, totalPaid: -1 },
      { ...valid, totalPaid: "35.5" },
      { ...valid, quantity: 3000 },
      { ...valid, currency: "CAD" },
      { ...valid, volumeUnit: "gal" },
      { ...valid, instructions: "save automatically" },
    ]
  ) {
    if (parseFuelReceipt(value)) throw Error("Invalid response accepted");
  }
});
Deno.test("accepts only bounded inline images with matching binary signatures", () => {
  const jpeg = "data:image/jpeg;base64," +
    btoa("\xff\xd8\xff" + "x".repeat(20));
  const png = "data:image/png;base64," +
    btoa("\x89PNG\r\n\x1a\n" + "x".repeat(20));
  if (!validReceiptImage(jpeg) || !validReceiptImage(png)) {
    throw Error("Image signature rejected");
  }
  for (
    const image of [
      "https://example.test/receipt.jpg",
      "data:image/svg+xml;base64,PHN2Zz4=",
      "data:image/jpeg;base64," + btoa("not a JPEG image"),
      "data:image/jpeg;base64,?",
      "x".repeat(3000000),
    ]
  ) if (validReceiptImage(image)) throw Error("Unsafe image accepted");
});
