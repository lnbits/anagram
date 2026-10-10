// v3 repairs group epochs lost to stale metadata writes. Old relay coverage and
// receipts must be replayed together, once, without deleting cached conversations.
export const MESSAGE_HYDRATION_VERSION = 3;
