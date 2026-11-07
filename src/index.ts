import { serve } from "bun";
import index from "./index.html";
import { resolve, sep } from "node:path";

const dataDirectory = resolve(import.meta.dir, "../public/data");
const faviconPath = resolve(import.meta.dir, "../public/favicon.svg");

const server = serve({
  routes: {
    "/favicon.svg": () => new Response(Bun.file(faviconPath), {
      headers: { "Content-Type": "image/svg+xml" },
    }),
    "/data/*": async (request) => {
      let relativePath: string;
      try {
        relativePath = decodeURIComponent(new URL(request.url).pathname.slice("/data/".length));
      } catch {
        return new Response("Invalid data path.", { status: 400 });
      }

      const filePath = resolve(dataDirectory, relativePath);
      if (!filePath.startsWith(`${dataDirectory}${sep}`)) {
        return new Response("Invalid data path.", { status: 400 });
      }

      const file = Bun.file(filePath);
      return (await file.exists())
        ? new Response(file)
        : new Response("Terrain data not found. Run `bun run process:terrain`.", { status: 404 });
    },
    "/*": index,
  },

  development: process.env.NODE_ENV !== "production" && {
    // Enable browser hot reloading in development
    hmr: true,

    // Echo console logs from the browser to the server
    console: true,
  },
});

console.log(`🚀 Server running at ${server.url}`);
