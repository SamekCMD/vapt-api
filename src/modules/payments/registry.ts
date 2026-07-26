import type { PaymentProvider } from "./provider.js";
import type { PaymentProviderCode } from "./types.js";

export class DuplicatePaymentProviderError extends Error {
  constructor(public readonly providerCode: PaymentProviderCode) {
    super(`Payment provider already registered: ${providerCode}`);
    this.name = "DuplicatePaymentProviderError";
  }
}

export class PaymentProviderNotFoundError extends Error {
  constructor(public readonly providerCode: PaymentProviderCode) {
    super(`Payment provider is not registered: ${providerCode}`);
    this.name = "PaymentProviderNotFoundError";
  }
}

export interface PaymentProviderRegistry {
  register(provider: PaymentProvider): void;
  get(code: PaymentProviderCode): PaymentProvider;
  has(code: PaymentProviderCode): boolean;
  codes(): PaymentProviderCode[];
}

class DefaultPaymentProviderRegistry implements PaymentProviderRegistry {
  readonly #providers = new Map<PaymentProviderCode, PaymentProvider>();

  constructor(providers: readonly PaymentProvider[]) {
    for (const provider of providers) {
      this.register(provider);
    }
  }

  register(provider: PaymentProvider): void {
    if (this.#providers.has(provider.code)) {
      throw new DuplicatePaymentProviderError(provider.code);
    }

    this.#providers.set(provider.code, provider);
  }

  get(code: PaymentProviderCode): PaymentProvider {
    const provider = this.#providers.get(code);

    if (!provider) {
      throw new PaymentProviderNotFoundError(code);
    }

    return provider;
  }

  has(code: PaymentProviderCode): boolean {
    return this.#providers.has(code);
  }

  codes(): PaymentProviderCode[] {
    return [...this.#providers.keys()];
  }
}

export function createPaymentProviderRegistry(
  providers: readonly PaymentProvider[] = [],
): PaymentProviderRegistry {
  return new DefaultPaymentProviderRegistry(providers);
}
