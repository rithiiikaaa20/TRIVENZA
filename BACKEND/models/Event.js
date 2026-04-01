const mongoose = require("mongoose");

const eventSchema = new mongoose.Schema({
  title: String,
  date: String,
  location: String,
  description: String,
  createdBy: {
    type: String,
    required: true
  },
  price: {
    type: Number,
    default: 0
  },
  image: {
    type: String,
    default: ""
  },
  creator_id: {
    type: String,
    default: ""
  },
  communityId: {
    type: String,
    default: ""
  }
}, { timestamps: true });

module.exports = mongoose.model("Event", eventSchema);
