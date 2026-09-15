export function retryDelay(attempt: number): number {
  return Math.min(2 ** attempt, 32);
}

export function isRetryable(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "status" in error) {
    if (typeof error.status !== "number") return true; // status 不可读：按网络错误处理，可重试
    return error.status === 429 || error.status >= 500;
  }
  return true; // 无 status：网络错误等，可重试
}

function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  maxAttempts = 5,
): Promise<T> {
  let attempts = 0;
  for (;;) {
    try {
      return await operation();
    } catch (error) {
      attempts += 1;
      if (attempts >= maxAttempts || !isRetryable(error)) throw error;
      await sleep(retryDelay(attempts));
    }
  }
}
