const VERSION = "1.0.7";
const cacheQuery = new URL(import.meta.url).search || `?v=${VERSION}`;

await import(`./device-card-list-panel.js${cacheQuery}`);
await import(`./device-map-panel.js${cacheQuery}`);
