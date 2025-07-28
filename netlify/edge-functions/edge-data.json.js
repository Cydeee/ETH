// netlify/edge-functions/data.json.js

export default async function handler(request) {
  // Handle CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin":  "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
      }
    });
  }

  // Reuse your existing logic to fetch and compute the `result` object
  // I assume you refactor your current data-fetching code into a function:
  const result = await buildDashboardData();

  // Add timestamp
  const payload = {
    ...result,
    timestamp: Date.now()
  };

  return new Response(JSON.stringify(payload), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    }
  });
}
