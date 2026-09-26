export type RestaurantDto = {
  id: string;
  name: string;
  slug: string;
  cnpj: string | null;
  whatsapp: string | null;
  address: string | null;
  phone: string | null;
  hours: string | null;
  description: string | null;
  primaryColor: string;
  secondaryColor: string;
  fontFamily: string;
  logoUrl: string | null;
  planType: "starter" | "pro" | "business";
  planStatus: "trialing" | "active" | "expired" | "cancelled";
  trialEndsAt: string | null;
  totalTables: number;
  maxTables: number;
  paymentMode: "open_tab" | "prepaid";
  maxPendingOrders: number;
  localEnabled: boolean;
  deliveryEnabled: boolean;
  onboardingCompleted: boolean;
  updatedAt: string;
};

export type MenuVariationDto = {
  id: string;
  name: string;
  options: string[];
  required: boolean;
};

export type MenuItemDto = {
  id: string;
  restaurantId: string;
  name: string;
  price: string;
  description: string | null;
  category: string;
  available: boolean;
  imageUrl: string | null;
  availableFrom: string | null;
  availableUntil: string | null;
  badge: string | null;
  isChefSuggestion: boolean;
  prepTimeMinutes: number | null;
  createdAt: string;
  updatedAt: string;
  variations: MenuVariationDto[];
};

export type PublicRestaurantDto = Pick<
  RestaurantDto,
  | "id"
  | "name"
  | "slug"
  | "whatsapp"
  | "address"
  | "phone"
  | "hours"
  | "description"
  | "primaryColor"
  | "secondaryColor"
  | "fontFamily"
  | "logoUrl"
  | "totalTables"
  | "maxTables"
  | "paymentMode"
  | "maxPendingOrders"
  | "localEnabled"
  | "deliveryEnabled"
  | "updatedAt"
>;

export type PublicCatalogDto = {
  restaurant: PublicRestaurantDto;
  items: MenuItemDto[];
};
