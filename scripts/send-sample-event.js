const fs = require("fs");
const http = require("http");
const path = require("path");

const samplePath = path.join(__dirname, "..", "sample-data", "abandoned-cart-event.json");
const sampleEvent = fs.readFileSync(samplePath, "utf8");

const request = http.request(
  {
    hostname: "localhost",
    port: Number(process.env.PORT || 3000),
    path: "/events/abandoned-cart",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(sampleEvent)
    }
  },
  (response) => {
    let body = "";

    response.on("data", (chunk) => {
      body += chunk;
    });

    response.on("end", () => {
      console.log(`Status: ${response.statusCode}`);
      console.log(body);
    });
  }
);

request.on("error", (error) => {
  console.error("Could not send sample event.");
  console.error(error.message);
  process.exitCode = 1;
});

request.write(sampleEvent);
request.end();
