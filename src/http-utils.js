function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload, null, 2));
}

function sendHtml(response, statusCode, html) {
  response.writeHead(statusCode, { "Content-Type": "text/html; charset=utf-8" });
  response.end(html);
}

function sendRedirect(response, location, statusCode = 302) {
  response.writeHead(statusCode, { Location: location });
  response.end();
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";

    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        request.destroy();
        reject(new Error("Request body is too large"));
      }
    });

    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

async function readJsonRequest(request) {
  const body = await readRequestBody(request);
  return JSON.parse(body);
}

module.exports = {
  readJsonRequest,
  readRequestBody,
  sendHtml,
  sendJson,
  sendRedirect
};
