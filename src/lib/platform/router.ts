export type LocationQueryValue = string | null;
export type LocationQuery = Record<string, LocationQueryValue | LocationQueryValue[]>;
export interface Router {
  push(location: unknown): Promise<void>;
  currentRoute: {
    value: { path: string; name?: string; params: Record<string, string>; query: LocationQuery };
  };
}

export type LocationQueryRaw = Record<string, unknown>;
export type RouteLocationRaw =
  | string
  | { name?: string; path?: string; params?: Record<string, string>; query?: LocationQueryRaw };
