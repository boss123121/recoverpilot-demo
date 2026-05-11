const http = require("http");

const request = http.request(
  {
    hostname: "localhost",
    port: Number(process.env.PORT || 3000),
    path: "/scheduler/run",
    method: "POST"
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
  console.error("Could not run scheduler.");
  console.error(error.message);
  process.exitCode = 1;
});

request.end();
