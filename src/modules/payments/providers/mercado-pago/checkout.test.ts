import assert from "node:assert/strict";
import test from "node:test";

type CheckoutClient = {
  createPreference(input: {
    accessToken: string;
    environment: "sandbox" | "production";
    transactionId: string;
    restaurantId: string;
    orderId: string;
    amount: { amount: string; currency: string };
    description: string;
    returnUrls: { success: URL; pending: URL; failure: URL };
    notificationUrl: URL;
  }): Promise<{
    preferenceId: string;
    checkoutUrl: URL;
    diagnostics: {
      collectorId: string | null;
      clientId: string | null;
      marketplace: string | null;
      siteId: string | null;
      operationType: string | null;
      checkoutHost: string;
      sandboxCheckoutHost: string | null;
    };
  }>;
  getPreference(input: {
    accessToken: string;
    preferenceId: string;
  }): Promise<Record<string, unknown>>;
};

test("Mercado Pago client creates a hosted preference from server-owned payment data", async () => {
  const clientModule = await import("./client.js") as unknown as {
    createMercadoPagoCheckoutClient?: (input: { fetchImpl: typeof fetch }) => CheckoutClient;
  };
  assert.equal(typeof clientModule.createMercadoPagoCheckoutClient, "function");

  let request: { url: string; init: RequestInit } | null = null;
  const client = clientModule.createMercadoPagoCheckoutClient!({
    fetchImpl: async (input, init) => {
      request = { url: String(input), init: init ?? {} };
      return new Response(JSON.stringify({
        id: "preference-123",
        collector_id: 3595396809,
        client_id: "883582241802094",
        marketplace: "MP-MKT-883582241802094",
        site_id: "MLB",
        operation_type: "regular_payment",
        init_point: "https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=preference-123",
        sandbox_init_point: "https://sandbox.mercadopago.com.br/checkout/v1/redirect?pref_id=preference-123",
      }), { status: 201, headers: { "content-type": "application/json" } });
    },
  });

  const result = await client.createPreference({
    accessToken: "APP_USR-sandbox-oauth-access-token",
    environment: "sandbox",
    transactionId: "30000000-0000-4000-8000-000000000001",
    restaurantId: "20000000-0000-4000-8000-000000000001",
    orderId: "10000000-0000-4000-8000-000000000001",
    amount: { amount: "42.50", currency: "BRL" },
    description: "Pedido 42",
    returnUrls: {
      success: new URL("https://vapt.example.com/payment/return?result=success"),
      pending: new URL("https://vapt.example.com/payment/return?result=pending"),
      failure: new URL("https://vapt.example.com/payment/return?result=failure"),
    },
    notificationUrl: new URL("https://api.vapt.example.com/payments/mercado-pago/webhook"),
  });

  const captured = request as unknown as { url: string; init: RequestInit };
  assert.equal(captured.url, "https://api.mercadopago.com/checkout/preferences");
  assert.equal(captured.init.method, "POST");
  assert.deepEqual(captured.init.headers, {
    accept: "application/json",
    authorization: "Bearer APP_USR-sandbox-oauth-access-token",
    "content-type": "application/json",
  });
  assert.deepEqual(JSON.parse(String(captured.init.body)), {
    items: [{
      id: "10000000-0000-4000-8000-000000000001",
      title: "Pedido 42",
      quantity: 1,
      currency_id: "BRL",
      unit_price: 42.5,
    }],
    external_reference: "30000000-0000-4000-8000-000000000001",
    metadata: {
      transaction_id: "30000000-0000-4000-8000-000000000001",
      restaurant_id: "20000000-0000-4000-8000-000000000001",
      order_id: "10000000-0000-4000-8000-000000000001",
    },
    back_urls: {
      success: "https://vapt.example.com/payment/return?result=success",
      pending: "https://vapt.example.com/payment/return?result=pending",
      failure: "https://vapt.example.com/payment/return?result=failure",
    },
    auto_return: "approved",
    notification_url: "https://api.vapt.example.com/payments/mercado-pago/webhook",
    marketplace_fee: 0,
  });
  assert.equal(result.preferenceId, "preference-123");
  assert.equal(
    result.checkoutUrl.toString(),
    "https://sandbox.mercadopago.com.br/checkout/v1/redirect?pref_id=preference-123",
  );
  assert.deepEqual(result.diagnostics, {
    collectorId: "3595396809",
    clientId: "883582241802094",
    marketplace: "MP-MKT-883582241802094",
    siteId: "MLB",
    operationType: "regular_payment",
    checkoutHost: "sandbox.mercadopago.com.br",
    sandboxCheckoutHost: "sandbox.mercadopago.com.br",
  });
});

test("Mercado Pago client declares a zero marketplace fee in production", async () => {
  const clientModule = await import("./client.js") as unknown as {
    createMercadoPagoCheckoutClient?: (input: { fetchImpl: typeof fetch }) => CheckoutClient;
  };
  let requestBody: Record<string, unknown> | null = null;
  const client = clientModule.createMercadoPagoCheckoutClient!({
    fetchImpl: async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        id: "preference-production",
        init_point: "https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=preference-production",
        sandbox_init_point: "https://sandbox.mercadopago.com.br/checkout/v1/redirect?pref_id=preference-production",
      }), { status: 201, headers: { "content-type": "application/json" } });
    },
  });

  const result = await client.createPreference({
    accessToken: "APP_USR-production-access-token",
    environment: "production",
    transactionId: "transaction-production",
    restaurantId: "restaurant-production",
    orderId: "order-production",
    amount: { amount: "10.00", currency: "BRL" },
    description: "Pedido em produção",
    returnUrls: {
      success: new URL("https://vapt.example.com/payment/return?result=success"),
      pending: new URL("https://vapt.example.com/payment/return?result=pending"),
      failure: new URL("https://vapt.example.com/payment/return?result=failure"),
    },
    notificationUrl: new URL("https://api.vapt.example.com/payments/mercado-pago/webhook"),
  });

  const capturedBody = requestBody as unknown as Record<string, unknown>;
  assert.equal(capturedBody.marketplace_fee, 0);
  assert.equal(
    result.checkoutUrl.toString(),
    "https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=preference-production",
  );
});

test("Mercado Pago client reads safe persisted preference diagnostics", async () => {
  const clientModule = await import("./client.js") as unknown as {
    createMercadoPagoCheckoutClient?: (input: { fetchImpl: typeof fetch }) => CheckoutClient;
  };
  let request: { url: string; init: RequestInit } | null = null;
  const client = clientModule.createMercadoPagoCheckoutClient!({
    fetchImpl: async (input, init) => {
      request = { url: String(input), init: init ?? {} };
      return new Response(JSON.stringify({
        id: "preference-123",
        collector_id: 3595396809,
        client_id: "883582241802094",
        marketplace: "MP-MKT-883582241802094",
        marketplace_fee: 0.01,
        site_id: "MLB",
        operation_type: "regular_payment",
        external_reference: "transaction-123",
        binary_mode: false,
        expires: false,
        preference_expired: false,
        purpose: "wallet_purchase",
        processing_modes: ["aggregator"],
        items: [{ currency_id: "BRL", quantity: 1, unit_price: 23 }],
        back_urls: {
          success: "https://vapt.example.com/payment/return?result=success",
          pending: "https://vapt.example.com/payment/return?result=pending",
          failure: "https://vapt.example.com/payment/return?result=failure",
        },
        notification_url: "https://api.vapt.example.com/webhooks/payments/mercado-pago",
        init_point: "https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=preference-123",
        sandbox_init_point: "https://sandbox.mercadopago.com.br/checkout/v1/redirect?pref_id=preference-123",
        payer: { email: "must-not-leak@example.com", identification: { number: "12345678909" } },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  const result = await client.getPreference({
    accessToken: "TEST-private-token",
    preferenceId: "preference-123",
  });

  const captured = request as unknown as { url: string; init: RequestInit };
  assert.equal(captured.url, "https://api.mercadopago.com/checkout/preferences/preference-123");
  assert.deepEqual(captured.init.headers, {
    accept: "application/json",
    authorization: "Bearer TEST-private-token",
  });
  assert.deepEqual(result, {
    preferenceId: "preference-123",
    collectorId: "3595396809",
    clientId: "883582241802094",
    marketplace: "MP-MKT-883582241802094",
    marketplaceFee: "0.01",
    siteId: "MLB",
    operationType: "regular_payment",
    externalReference: "transaction-123",
    binaryMode: false,
    expires: false,
    preferenceExpired: false,
    purpose: "wallet_purchase",
    processingModes: ["aggregator"],
    itemCount: 1,
    amount: "23.00",
    currency: "BRL",
    backUrlHosts: ["vapt.example.com"],
    notificationHost: "api.vapt.example.com",
    checkoutHost: "www.mercadopago.com.br",
    sandboxCheckoutHost: "sandbox.mercadopago.com.br",
  });
  assert.equal(JSON.stringify(result).includes("must-not-leak"), false);
  assert.equal(JSON.stringify(result).includes("12345678909"), false);
});

test("Mercado Pago client reports only the safe provider code when preference lookup fails", async () => {
  const clientModule = await import("./client.js") as unknown as {
    createMercadoPagoCheckoutClient?: (input: { fetchImpl: typeof fetch }) => CheckoutClient;
  };
  const secret = "TEST-private-token-must-not-leak";
  const client = clientModule.createMercadoPagoCheckoutClient!({
    fetchImpl: async () => new Response(JSON.stringify({
      error: "invalid_access_token",
      message: `sensitive provider detail containing ${secret}`,
    }), { status: 401, headers: { "content-type": "application/json" } }),
  });

  await assert.rejects(
    client.getPreference({ accessToken: secret, preferenceId: "preference-123" }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message,
        "Mercado Pago preference request failed (status 401: invalid_access_token)",
      );
      assert.equal(error.message.includes(secret), false);
      assert.equal(error.message.includes("sensitive provider detail"), false);
      return true;
    },
  );
});

test("Mercado Pago application token resolver uses the client credentials flow", async () => {
  const clientModule = await import("./client.js") as unknown as {
    createMercadoPagoApplicationAccessTokenResolver?: (input: {
      clientId: string;
      clientSecret: string;
      fetchImpl: typeof fetch;
    }) => () => Promise<string>;
  };
  assert.equal(typeof clientModule.createMercadoPagoApplicationAccessTokenResolver, "function");

  let request: { url: string; init: RequestInit } | null = null;
  const resolveAccessToken = clientModule.createMercadoPagoApplicationAccessTokenResolver!({
    clientId: "app-123",
    clientSecret: "private-client-secret",
    fetchImpl: async (input, init) => {
      request = { url: String(input), init: init ?? {} };
      return new Response(JSON.stringify({
        access_token: "APP_USR-application-token",
        token_type: "bearer",
        expires_in: 21_600,
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  assert.equal(await resolveAccessToken(), "APP_USR-application-token");
  const captured = request as unknown as { url: string; init: RequestInit };
  assert.equal(captured.url, "https://api.mercadopago.com/oauth/token");
  assert.deepEqual(captured.init.headers, {
    accept: "application/json",
    "content-type": "application/json",
  });
  assert.deepEqual(JSON.parse(String(captured.init.body)), {
    client_id: "app-123",
    client_secret: "private-client-secret",
    grant_type: "client_credentials",
  });
});

test("Mercado Pago client rejects malformed responses without leaking provider payloads", async () => {
  const clientModule = await import("./client.js") as unknown as {
    createMercadoPagoCheckoutClient?: (input: { fetchImpl: typeof fetch }) => CheckoutClient;
  };
  assert.equal(typeof clientModule.createMercadoPagoCheckoutClient, "function");
  const secret = "TEST-sensitive-token";
  const client = clientModule.createMercadoPagoCheckoutClient!({
    fetchImpl: async () => new Response(JSON.stringify({
      message: `invalid ${secret}`,
      id: "preference-123",
      init_point: "javascript:alert(1)",
    }), { status: 201 }),
  });

  await assert.rejects(
    client.createPreference({
      accessToken: secret,
      environment: "sandbox",
      transactionId: "transaction-1",
      restaurantId: "restaurant-1",
      orderId: "order-1",
      amount: { amount: "42.50", currency: "BRL" },
      description: "Pedido 42",
      returnUrls: {
        success: new URL("https://vapt.example.com/payment/return"),
        pending: new URL("https://vapt.example.com/payment/return"),
        failure: new URL("https://vapt.example.com/payment/return"),
      },
      notificationUrl: new URL("https://api.vapt.example.com/payments/mercado-pago/webhook"),
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes(secret), false);
      return true;
    },
  );
});

test("Mercado Pago provider resolves credentials internally and returns a pending checkout", async () => {
  const paymentModule = await import("./payment.js").catch(() => ({})) as {
    createMercadoPagoPaymentProvider?: (input: {
      client: CheckoutClient;
      resolveAccessToken: (input: { providerAccountId: string; restaurantId: string }) => Promise<string>;
      notificationUrl: URL;
    }) => {
      getCapabilities(): Record<string, boolean>;
      createPayment(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    };
  };
  assert.equal(typeof paymentModule.createMercadoPagoPaymentProvider, "function");

  let credentialRequest: unknown = null;
  let preferenceRequest: unknown = null;
  const provider = paymentModule.createMercadoPagoPaymentProvider!({
    client: {
      async createPreference(input) {
        preferenceRequest = input;
        return {
          preferenceId: "preference-123",
          checkoutUrl: new URL("https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=preference-123"),
          diagnostics: {
            collectorId: "3595396809",
            clientId: "883582241802094",
            marketplace: "MP-MKT-883582241802094",
            siteId: "MLB",
            operationType: "regular_payment",
            checkoutHost: "www.mercadopago.com.br",
            sandboxCheckoutHost: "sandbox.mercadopago.com.br",
          },
        };
      },
      async getPreference() {
        throw new Error("getPreference should not be called while creating a payment");
      },
    },
    resolveAccessToken: async (input) => {
      credentialRequest = input;
      return "TEST-private-access-token";
    },
    notificationUrl: new URL("https://api.vapt.example.com/payments/mercado-pago/webhook"),
  });

  assert.deepEqual(provider.getCapabilities(), {
    onlineCheckout: true,
    webhooks: true,
    cancellation: false,
    fullRefunds: false,
    partialRefunds: false,
    oauthConnection: true,
  });

  const result = await provider.createPayment({
    transactionId: "transaction-1",
    restaurantId: "restaurant-1",
    orderId: "order-1",
    providerAccountId: "account-1",
    environment: "sandbox",
    amount: { amount: "42.50", currency: "BRL" },
    paymentMethod: null,
    description: "Pedido 42",
    idempotencyKey: "checkout-1",
    returnUrls: {
      success: new URL("https://vapt.example.com/payment/return?result=success"),
      pending: new URL("https://vapt.example.com/payment/return?result=pending"),
      failure: new URL("https://vapt.example.com/payment/return?result=failure"),
    },
  });

  assert.deepEqual(credentialRequest, {
    providerAccountId: "account-1",
    restaurantId: "restaurant-1",
  });
  assert.equal((preferenceRequest as { accessToken: string }).accessToken, "TEST-private-access-token");
  assert.equal((preferenceRequest as { environment: string }).environment, "sandbox");
  assert.equal(result.status, "pending");
  assert.equal(result.providerStatus, "preference_created");
  assert.equal(result.externalPaymentId, null);
  assert.deepEqual(result.metadata, {
    preferenceId: "preference-123",
    checkoutDiagnostics: {
      collectorId: "3595396809",
      clientId: "883582241802094",
      marketplace: "MP-MKT-883582241802094",
      siteId: "MLB",
      operationType: "regular_payment",
      checkoutHost: "www.mercadopago.com.br",
      sandboxCheckoutHost: "sandbox.mercadopago.com.br",
    },
  });
});
