/**
 * The fetch Lifo's own requests use (Lifo Cloud calls that carry the person's token).
 *
 * In a box's Web Worker, lockDownCredentials puts its credential-free fetch here and lets
 * programs replace globalThis.fetch, as in Node (Next.js installs its caching fetch over the
 * global): a replaced global never sees these requests. Elsewhere (a box on the page, the
 * host CLI) it's the global fetch at the time of the call, as before.
 */
let locked: typeof fetch | undefined;

export function platformFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	return (locked ?? globalThis.fetch)(input, init);
}

export function setPlatformFetch(f: typeof fetch): void {
	locked = f;
}
