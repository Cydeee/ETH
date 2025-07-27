export const config = {
  path: "/data.html",
  cache: "manual",
};

export default async function handler(request) {
  const u = new URL(request.url);
  u.pathname = "/data";
  const res = await fetch(u.href);
  const data = await res.json();

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Dashboard Data</title></head>
<body>
<pre id="dashboard-data">${JSON.stringify(data, null, 2)}</pre>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
