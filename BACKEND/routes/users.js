const express = require("express");
const router = express.Router();
const User = require("../models/User");
const Event = require("../models/Event");

// DELETE USER BY USERNAME
router.delete("/:username", async (req, res) => {
  try {
    const username = req.params.username;

    await User.deleteOne({ username });
    await Event.deleteMany({ createdBy: username });

    res.json({ message: `User ${username} and their events deleted` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
