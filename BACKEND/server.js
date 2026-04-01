const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

const eventRoutes = require("./routes/events");
const userRoutes = require("./routes/users");

app.use("/api/events", eventRoutes);
app.use("/api/users", userRoutes);

mongoose.connect("mongodb://127.0.0.1:27017/trivenza")
  .then(() => console.log("MongoDB Connected"))
  .catch((err) => console.log(err));

app.get("/", (req, res) => {
  res.send("Backend Running");
});

app.listen(5000, () => {
  console.log("Server running on port 5000");
});
