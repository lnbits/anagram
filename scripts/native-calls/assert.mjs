// Failure snapshots read pixels from every source and capture video. Build them
// only after a failed check so diagnostics cannot stall an otherwise healthy call.
export const assert = (condition, message) => {
  if (!condition) throw new Error(typeof message === 'function' ? message() : message);
};
