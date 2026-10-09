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

export type KitchenOrderStatus = "paid" | "pending" | "preparing" | "ready" | "delivered";

export type KitchenOrderItemDto = {
  id: string;
  productName: string;
  quantity: number;
  unitPrice: string;
  notes: string;
};

export type KitchenOrderDto = {
  id: string;
  displayId: string | null;
  restaurantId: string;
  tableNumber: string | null;
  totalPrice: string;
  status: KitchenOrderStatus;
  channel: "local" | "delivery";
  paymentStatus: string | null;
  createdAt: string;
  updatedAt: string;
  items: KitchenOrderItemDto[];
};

export type TableSessionStatus = "open" | "check_requested" | "closed";

export type TableSessionSummaryDto = {
  id: string;
  restaurantId: string;
  tableNumber: string;
  status: TableSessionStatus;
  openedAt: string;
  closedAt: string | null;
  sessionTotal: string;
  orderCount: number;
};

export type TableSessionOrderItemDto = {
  id: string;
  productName: string;
  quantity: number;
  unitPrice: string;
  notes: string;
};

export type TableSessionOrderDto = {
  id: string;
  displayId: string | null;
  totalPrice: string;
  status: string;
  createdAt: string;
  paymentStatus: string | null;
  paymentConfirmedAt: string | null;
  items: TableSessionOrderItemDto[];
};

export type TableSessionDetailDto = {
  session: TableSessionSummaryDto;
  orders: TableSessionOrderDto[];
};

export type CloseTableSessionDto = {
  sessionId: string;
  status: "closed";
  closedAt: string;
  deliveredOrderIds: string[];
};

export type TransferTableSessionDto = {
  sessionId: string;
  tableNumber: string;
  updatedOrderIds: string[];
};

export type RequestCheckTableSessionDto = {
  sessionId: string;
  status: "check_requested";
};

export type OverviewPeriod = "day" | "week" | "month";

export type OverviewRestaurantDto = {
  id: string;
  name: string;
  paymentMode: "open_tab" | "prepaid";
  onboardingCompleted: boolean;
  deliveryEnabled: boolean;
};

export type OverviewOrderItemDto = {
  productName: string;
  quantity: number;
  unitPrice: string;
};

export type OverviewOrderDto = {
  id: string;
  displayId: string | null;
  totalPrice: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  items: OverviewOrderItemDto[];
};

export type OrderFeedbackDto = {
  orderId: string;
  restaurantId: string;
  rating: number;
  reasons: string[];
  comment: string | null;
  createdAt: string;
};

export type OverviewDto = {
  period: OverviewPeriod;
  periodStart: string;
  restaurant: OverviewRestaurantDto;
  orders: OverviewOrderDto[];
  feedback: OrderFeedbackDto[];
};
