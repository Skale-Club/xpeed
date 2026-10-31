import { beforeEach, expect, it, vi } from "vitest";
import { createReceiptHandler } from "../../supabase/functions/_shared/fuel-receipt-handler";
const carId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const image = "data:image/jpeg;base64," + btoa("\xff\xd8\xff" + "x".repeat(20));
const receipt = {
  totalPaid: 35.9,
  quantity: 10,
  currency: "USD",
  volumeUnit: "US gal",
};
const deps = {
  authenticate: vi.fn(),
  ownsCar: vi.fn(),
  apiKey: vi.fn(),
  model: vi.fn(),
  consume: vi.fn(),
  refund: vi.fn(),
  fetch: vi.fn(),
};
const reply = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status });
const request = (body: unknown = { carId, image }, method = "POST") =>
  new Request("https://example.test/read-fuel-receipt", {
    method,
    headers: { Authorization: "Bearer fake" },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });
beforeEach(() => {
  vi.clearAllMocks();
  deps.authenticate.mockResolvedValue("owner");
  deps.ownsCar.mockResolvedValue(true);
  deps.apiKey.mockResolvedValue("fake-key");
  deps.model.mockResolvedValue("configured-model");
  deps.consume.mockResolvedValue({ remaining: 9 });
  deps.refund.mockResolvedValue(undefined);
  deps.fetch.mockReset().mockImplementation(async (url: string) =>
    url.endsWith("/models")
      ? reply({
        data: [{
          id: "configured-model",
          architecture: { input_modalities: ["text", "image"] },
          supported_parameters: ["structured_outputs"],
        }],
      })
      : reply({ choices: [{ message: { content: JSON.stringify(receipt) } }] })
  );
});
it("extracts fields for the authenticated owner without saving a purchase", async () => {
  const response = await createReceiptHandler(deps)(request());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ receipt });
  expect(deps.ownsCar).toHaveBeenCalledWith("owner", carId);
  expect(deps.consume).toHaveBeenCalledOnce();
  expect(deps.refund).not.toHaveBeenCalled();
  const input = JSON.parse(deps.fetch.mock.calls[1][1].body);
  expect(input.model).toBe("configured-model");
  expect(input.max_tokens).toBe(300);
  expect(input.messages[1].content[1].image_url.url).toBe(image);
});
it("requires authentication and car ownership before spending quota or calling the provider", async () => {
  deps.authenticate.mockResolvedValueOnce(null);
  expect((await createReceiptHandler(deps)(request())).status).toBe(401);
  deps.ownsCar.mockResolvedValueOnce(false);
  expect((await createReceiptHandler(deps)(request())).status).toBe(404);
  expect(deps.consume).not.toHaveBeenCalled();
  expect(deps.fetch).not.toHaveBeenCalled();
});
it("rejects arbitrary URLs, invalid MIME signatures and oversized streamed bodies before inference", async () => {
  const handler = createReceiptHandler(deps);
  for (
    const value of [
      "https://localhost/secret",
      "data:image/jpeg;base64," + btoa("bad image"),
    ]
  ) expect((await handler(request({ carId, image: value }))).status).toBe(400);
  expect((await handler(request({ carId, image: "x".repeat(3000000) }))).status)
    .toBe(413);
  expect(deps.consume).not.toHaveBeenCalled();
  expect(deps.fetch).not.toHaveBeenCalled();
});
it("does not silently switch models when the configured model cannot see images", async () => {
  deps.fetch.mockResolvedValueOnce(
    reply({
      data: [{
        id: "configured-model",
        architecture: { input_modalities: ["text"] },
        supported_parameters: ["structured_outputs"],
      }],
    }),
  );
  const response = await createReceiptHandler(deps)(request());
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ code: "vision_unavailable" });
  expect(deps.consume).not.toHaveBeenCalled();
});
it("does not call paid inference after quota failure", async () => {
  deps.consume.mockRejectedValueOnce(
    new Error("Daily limit reached: 10/10 fuel_receipts"),
  );
  const response = await createReceiptHandler(deps)(request());
  expect(response.status).toBe(429);
  expect(deps.fetch).toHaveBeenCalledOnce();
  expect(deps.refund).not.toHaveBeenCalled();
});
it.each(["upstream", "invalid", "empty", "timeout"])(
  "refunds quota after %s failures without leaking internals",
  async (kind) => {
    deps.fetch.mockImplementationOnce(async () =>
      reply({
        data: [{
          id: "configured-model",
          architecture: { input_modalities: ["image"] },
          supported_parameters: ["structured_outputs"],
        }],
      })
    );
    if (kind === "timeout") {
      deps.fetch.mockRejectedValueOnce(
        new Error("private upstream detail"),
      );
    } else {deps.fetch.mockResolvedValueOnce(
        kind === "upstream"
          ? reply({ error: "private upstream detail" }, 500)
          : reply({
            choices: [{
              message: {
                content: kind === "invalid" ? "not json" : JSON.stringify({
                  totalPaid: null,
                  quantity: null,
                  currency: null,
                  volumeUnit: null,
                }),
              },
            }],
          }),
      );}
    const response = await createReceiptHandler(deps)(request());
    expect(response.ok).toBe(false);
    expect(await response.text()).not.toContain("private upstream detail");
    expect(deps.refund).toHaveBeenCalledWith("owner");
  },
);
it("returns partial evidence with unknown units for explicit user review", async () => {
  deps.fetch.mockImplementationOnce(async () =>
    reply({
      data: [{
        id: "configured-model",
        architecture: { input_modalities: ["image"] },
        supported_parameters: ["structured_outputs"],
      }],
    })
  );
  deps.fetch.mockResolvedValueOnce(
    reply({
      choices: [{
        message: {
          content: JSON.stringify({
            ...receipt,
            currency: null,
            volumeUnit: null,
          }),
        },
      }],
    }),
  );
  const response = await createReceiptHandler(deps)(request());
  expect(await response.json()).toEqual({
    receipt: { ...receipt, currency: null, volumeUnit: null },
  });
});
