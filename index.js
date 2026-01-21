const express = require("express");
const app = express();

app.use(express.json());

app.post("/webhook", (req, res) => {
  console.log("=== WEBHOOK DATA ===");
  console.log(JSON.stringify(req.body, null, 2));
  res.sendStatus(200);
});

app.get("/", (req, res) => {
  res.send("LINE Webhook is running");
});

app.listen(3000, () => {
  console.log("Server running on port 3000");
});
