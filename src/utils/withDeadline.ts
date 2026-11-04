// A deadline bounds the caller's wait, not the underlying operation. Callers
// must retain/serialize work that can still complete after this rejects.
export async function withDeadline<T>(
  work: Promise<T>,
  milliseconds: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}
