import { ConvexHttpClient } from "convex/browser";
import { createConvexFetch, createNodeHttpFetch } from "./convex-fetch.js";

const url = process.env.CONVEX_URL ?? process.env.VITE_CONVEX_URL;
if (!url) {
  throw new Error(
    "Convex URL is not set. Run `npm run setup` or `npx convex dev` to configure VITE_CONVEX_URL.",
  );
}

const convexFetch = createConvexFetch({
  fetchImpl: createNodeHttpFetch(),
  onRetry: ({ attempt, delayMs, phase }) => {
    console.warn(
      `[convex] transient ${phase} failure; retrying (${attempt}/3) in ${delayMs}ms`,
    );
  },
});

export const convex = new ConvexHttpClient(url, { fetch: convexFetch });
