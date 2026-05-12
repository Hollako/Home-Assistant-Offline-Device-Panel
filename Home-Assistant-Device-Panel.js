const cacheQuery = new URL(import.meta.url).search;

await import(`./device-card-list-panel.js${cacheQuery}`);
await import(`./device-map-panel.js${cacheQuery}`);
