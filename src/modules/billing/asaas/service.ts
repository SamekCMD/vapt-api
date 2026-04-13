import { createRestaurantAccessChecker } from "../../../lib/permissions.js";

type AsaasClient = {
  asaas: {
    setup: (input: {
      restaurantId: string;
      asaasApiKey: string;
      asaasEnvironment: "production" | "sandbox";
      asaasBillingDocument: string;
    }) => Promise<{
      data: {
        valid: boolean;
        webhook_registered: boolean;
        webhook_id: string | null;
        setup_status: string;
        message: string;
      };
    }>;
    getSetupStatus: (restaurantId: string) => Promise<{
      data: {
        restaurant_id: string;
        name: string;
        setup_status: string | null;
        webhook_id: string | null;
        webhook_url: string | null;
        last_validated_at: string | null;
        last_error: string | null;
        has_api_key: boolean;
        asaas_environment: "production" | "sandbox" | null;
      };
    }>;
    createPix: (input: {
      restaurantId: string;
      orderId: string;
      totalPrice: number;
    }) => Promise<{
      data: {
        payment_id: string;
        qr_code_base64: string | null;
        pix_payload: string | null;
        expiration: string | null;
        status: string;
      };
    }>;
  };
};

type OwnershipLookup = (input: { userId: string; restaurantId: string }) => Promise<boolean>;

const defaultOwnershipLookup: OwnershipLookup = async ({ userId, restaurantId }) =>
  userId === "user-1" && restaurantId === "rest-1";

export function createAsaasBillingService(
  client: AsaasClient,
  ownershipLookup: OwnershipLookup = defaultOwnershipLookup,
) {
  const assertRestaurantAccess = createRestaurantAccessChecker(ownershipLookup);

  return {
    async setup(input: {
      userId: string;
      restaurantId: string;
      asaasApiKey: string;
      asaasEnvironment: "production" | "sandbox";
      asaasBillingDocument: string;
    }) {
      await assertRestaurantAccess({ userId: input.userId, restaurantId: input.restaurantId });

      const response = await client.asaas.setup({
        restaurantId: input.restaurantId,
        asaasApiKey: input.asaasApiKey,
        asaasEnvironment: input.asaasEnvironment,
        asaasBillingDocument: input.asaasBillingDocument,
      });

      return {
        valid: response.data.valid,
        webhookRegistered: response.data.webhook_registered,
        webhookId: response.data.webhook_id,
        setupStatus: response.data.setup_status,
        message: response.data.message,
      };
    },

    async getSetupStatus(input: {
      userId: string;
      restaurantId: string;
    }) {
      await assertRestaurantAccess({ userId: input.userId, restaurantId: input.restaurantId });

      const response = await client.asaas.getSetupStatus(input.restaurantId);

      return {
        restaurantId: response.data.restaurant_id,
        name: response.data.name,
        setupStatus: response.data.setup_status,
        webhookId: response.data.webhook_id,
        webhookUrl: response.data.webhook_url,
        lastValidatedAt: response.data.last_validated_at,
        lastError: response.data.last_error,
        hasApiKey: response.data.has_api_key,
        asaasEnvironment: response.data.asaas_environment,
      };
    },

    async createPix(input: {
      userId: string;
      restaurantId: string;
      orderId: string;
      totalPrice: number;
    }) {
      await assertRestaurantAccess({ userId: input.userId, restaurantId: input.restaurantId });

      const response = await client.asaas.createPix({
        restaurantId: input.restaurantId,
        orderId: input.orderId,
        totalPrice: input.totalPrice,
      });

      return {
        paymentId: response.data.payment_id,
        qrCodeBase64: response.data.qr_code_base64,
        pixPayload: response.data.pix_payload,
        expiration: response.data.expiration,
        status: response.data.status,
      };
    },

    async createPixPublic(input: {
      restaurantId: string;
      orderId: string;
      totalPrice: number;
    }) {
      const response = await client.asaas.createPix({
        restaurantId: input.restaurantId,
        orderId: input.orderId,
        totalPrice: input.totalPrice,
      });

      return {
        paymentId: response.data.payment_id,
        qrCodeBase64: response.data.qr_code_base64,
        pixPayload: response.data.pix_payload,
        expiration: response.data.expiration,
        status: response.data.status,
      };
    },
  };
}
