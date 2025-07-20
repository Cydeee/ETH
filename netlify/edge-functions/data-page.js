// netlify/edge-functions/data-page.js
export default async (request) => {
  // Build the URL for your JSON endpoint
  const u = new URL(request.url);
  u.pathname = '/data';

  // Fetch the live JSON
  const res = await fetch(u.href);
  const data = await res.json();

  // Inline it into HTML
  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Dashboard Data</title></head>
<body>
<pre id="dashboard-data">
${JSON.stringify(data, null, 2)}
</pre>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html' }
  });
}
