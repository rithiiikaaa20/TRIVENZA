const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const Event = require("../models/Event");

// TEST ROUTE
router.get("/test", (req, res) => {
  res.send("Events route working");
});

// CREATE EVENT
router.post("/", async (req, res) => {
  try {
    const event = new Event(req.body);
    const saved = await event.save();
    res.json(saved);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET EVENTS
router.get("/", async (req, res) => {
  try {
    const events = await Event.find();
    res.json(events);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE ALL EVENTS BY USER
router.delete("/user/:username", async (req, res) => {
  try {
    const username = req.params.username;
    const result = await Event.deleteMany({ createdBy: username });

    res.json({
      message: `Deleted ${result.deletedCount} events for ${username}`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE EVENT
router.delete("/:id", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid event id" });
    }

    const user = req.query.user;
    const event = await Event.findById(req.params.id);

    if (!event) {
      return res.status(404).json({ message: "Event not found" });
    }

    if (event.createdBy !== user) {
      return res.status(403).json({ message: "Unauthorized" });
    }

    await Event.findByIdAndDelete(req.params.id);
    res.json({ message: "Event deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
