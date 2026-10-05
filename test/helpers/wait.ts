export async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 10_000, intervalMs = 25): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await check()) return;
        await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(`condition not met within ${timeoutMs} ms`);
}
