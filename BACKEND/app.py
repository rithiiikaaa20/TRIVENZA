import datetime
import os

from bson.objectid import ObjectId
from dotenv import load_dotenv
from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS
from pymongo import MongoClient
from werkzeug.security import check_password_hash, generate_password_hash

load_dotenv()

app = Flask(__name__)
CORS(app)

app.config["SECRET_KEY"] = os.getenv("SECRET_KEY")

mongo_uri = os.getenv("MONGO_URI")
db_name = os.getenv("DB_NAME")

client = MongoClient(mongo_uri)
db = client[db_name]

users_collection = db["users"]
communities_collection = db["communities"]
events_collection = db["events"]
fundraisers_collection = db["fundraisers"]
posts_collection = db["posts"]
messages_collection = db["messages"]


def serialize_user(user):
    username = user.get("username") or user.get("name") or ""
    interests = user.get("interests", [])
    if isinstance(interests, str):
        interests = [item.strip() for item in interests.split(",") if item.strip()]

    return {
        "id": str(user["_id"]),
        "username": username,
        "name": username,
        "email": user.get("email", ""),
        "phone": user.get("phone", ""),
        "profilePic": user.get("profilePic", ""),
        "interests": interests,
    }


def get_username(user):
    if not user:
        return "Unknown User"
    return user.get("username") or user.get("name") or "Unknown User"


def normalize_created_by(value):
    name = (value or "").strip() if isinstance(value, str) else ""
    if not name or name.upper() == "UNKNOWN USER":
        return ""
    return name


def resolve_created_by(document):
    created_by = normalize_created_by(document.get("createdBy"))
    if created_by:
        return created_by

    creator = get_user_by_id(document.get("creator_id"))
    repaired_name = normalize_created_by(get_username(creator))
    if repaired_name and repaired_name != document.get("createdBy"):
        if "_id" in document:
            if "category" in document:
                communities_collection.update_one({"_id": document["_id"]}, {"$set": {"createdBy": repaired_name}})
            elif "target_amount" in document:
                fundraisers_collection.update_one({"_id": document["_id"]}, {"$set": {"createdBy": repaired_name}})
            else:
                events_collection.update_one({"_id": document["_id"]}, {"$set": {"createdBy": repaired_name}})
        return repaired_name

    return ""


def serialize_event(event):
    return {
        "id": str(event["_id"]),
        "title": event["title"],
        "date": event["date"],
        "location": event["location"],
        "description": event["description"],
        "image": event.get("image", ""),
        "price": float(event.get("price", 0) or 0),
        "creator_id": event.get("creator_id", ""),
        "createdBy": resolve_created_by(event) or "User",
        "createdAt": event.get("createdAt", ""),
        "communityId": event.get("communityId", ""),
    }


def get_user_by_id(user_id):
    if not user_id:
        return None
    try:
        return users_collection.find_one({"_id": ObjectId(user_id)})
    except Exception:
        return None


def normalize_interests(interests):
    if isinstance(interests, list):
        return [item.strip() for item in interests if isinstance(item, str) and item.strip()]
    if isinstance(interests, str):
        return [item.strip() for item in interests.split(",") if item.strip()]
    return []


def sync_username_references(user_id, username):
    communities_collection.update_many(
        {"creator_id": user_id},
        {"$set": {"createdBy": username}},
    )
    events_collection.update_many(
        {"creator_id": user_id},
        {"$set": {"createdBy": username}},
    )
    fundraisers_collection.update_many(
        {"creator_id": user_id},
        {"$set": {"createdBy": username}},
    )
    posts_collection.update_many(
        {"userId": user_id},
        {"$set": {"userName": username}},
    )
    messages_collection.update_many(
        {"userId": user_id},
        {"$set": {"userName": username}},
    )


# =========================
# AUTHENTICATION
# =========================


@app.route("/api/signup", methods=["POST"])
def signup():
    data = request.json or {}

    username = (data.get("username") or "").strip()
    password = data.get("password")
    email = (data.get("email") or "").strip()

    if not username or not password:
        return jsonify({"error": "Username and password are required"}), 400

    existing_user = users_collection.find_one({"$or": [{"username": username}, {"name": username}]})
    if existing_user:
        return jsonify({"error": "Username already exists"}), 400

    if email and users_collection.find_one({"email": email}):
        return jsonify({"error": "Email already exists"}), 400

    user = {
        "username": username,
        "email": email,
        "phone": "",
        "profilePic": "",
        "interests": [],
        "password": generate_password_hash(password),
        "joined_communities": [],
    }

    insert_result = users_collection.insert_one(user)
    created_user = users_collection.find_one({"_id": insert_result.inserted_id})
    return jsonify({"message": "Signup successful", "user": serialize_user(created_user)}), 201


@app.route("/api/login", methods=["POST"])
def login():
    data = request.json or {}

    username = (data.get("username") or "").strip()
    password = data.get("password")

    if not username or not password:
        return jsonify({"error": "Username and password are required"}), 400

    user = users_collection.find_one({"$or": [{"username": username}, {"name": username}]})

    if not user:
        return jsonify({"error": "User not found"}), 404

    if not check_password_hash(user["password"], password):
        return jsonify({"error": "Invalid password"}), 401

    return jsonify({
        "message": "Login successful",
        "user": serialize_user(user),
    }), 200


@app.route("/api/profile/<user_id>", methods=["GET"])
def get_profile(user_id):
    user = get_user_by_id(user_id)
    if not user:
        return jsonify({"error": "User not found"}), 404
    return jsonify(serialize_user(user)), 200


@app.route("/api/profile/<user_id>", methods=["PUT"])
def update_profile(user_id):
    user = get_user_by_id(user_id)
    if not user:
        return jsonify({"error": "User not found"}), 404

    data = request.json or {}
    requested_username = (data.get("username") or user.get("username") or "").strip()
    email = (data.get("email") or "").strip()
    phone = (data.get("phone") or "").strip()
    profile_pic = data.get("profilePic") or ""
    interests = normalize_interests(data.get("interests"))

    if not requested_username:
        return jsonify({"error": "Username is required"}), 400

    existing_username_user = users_collection.find_one({"$or": [{"username": requested_username}, {"name": requested_username}]})
    if existing_username_user and str(existing_username_user["_id"]) != user_id:
        return jsonify({"error": "Username already exists"}), 400

    if email:
        existing_email_user = users_collection.find_one({"email": email})
        if existing_email_user and str(existing_email_user["_id"]) != user_id:
            return jsonify({"error": "Email already exists"}), 400

    update_fields = {
        "username": requested_username,
        "email": email,
        "phone": phone,
        "profilePic": profile_pic,
        "interests": interests,
    }

    users_collection.update_one({"_id": ObjectId(user_id)}, {"$set": update_fields})
    sync_username_references(user_id, requested_username)
    updated_user = users_collection.find_one({"_id": ObjectId(user_id)})

    return jsonify({
        "message": "Profile updated successfully",
        "user": serialize_user(updated_user),
    }), 200


# =========================
# COMMUNITIES
# =========================


@app.route("/api/communities", methods=["POST"])
def create_community():
    data = request.json or {}

    name = data.get("name")
    category = data.get("category")
    description = data.get("description")
    image = data.get("image")
    gallery = data.get("gallery", [])
    creator_id = data.get("creator_id")
    created_by = data.get("createdBy")

    if not name or not category or not description:
        return jsonify({"error": "Missing required fields"}), 400

    creator = get_user_by_id(creator_id)
    created_by = normalize_created_by(created_by) or normalize_created_by(get_username(creator)) or "User"

    community = {
        "name": name,
        "category": category,
        "description": description,
        "image": image,
        "gallery": gallery,
        "members": 0,
        "members_list": [],
        "creator_id": creator_id,
        "createdBy": created_by,
        "createdAt": datetime.datetime.utcnow().isoformat(),
    }

    result = communities_collection.insert_one(community)
    created = communities_collection.find_one({"_id": result.inserted_id})
    return jsonify({
        "message": "Community created successfully",
        "community": {
            "id": str(created["_id"]),
            "name": created["name"],
            "category": created["category"],
            "description": created["description"],
            "image": created.get("image", ""),
            "gallery": created.get("gallery", []),
            "members": created.get("members", 0),
            "members_list": created.get("members_list", []),
            "creator_id": created.get("creator_id", ""),
            "createdBy": resolve_created_by(created) or "User",
            "createdAt": created.get("createdAt", ""),
        },
    }), 201


@app.route("/api/communities", methods=["GET"])
def get_communities():
    communities = []
    for c in communities_collection.find():
        created_by = resolve_created_by(c)
        if not created_by:
            continue
        communities.append({
            "id": str(c["_id"]),
            "name": c["name"],
            "category": c["category"],
            "description": c["description"],
            "image": c.get("image", ""),
            "gallery": c.get("gallery", []),
            "members": c.get("members", 0),
            "members_list": c.get("members_list", []),
            "creator_id": c.get("creator_id", ""),
            "createdBy": created_by,
            "createdAt": c.get("createdAt", ""),
        })
    return jsonify(communities), 200


@app.route("/api/communities/<community_id>", methods=["GET"])
def get_community(community_id):
    try:
        c = communities_collection.find_one({"_id": ObjectId(community_id)})
        if not c:
            return jsonify({"error": "Community not found"}), 404
        return jsonify({
            "id": str(c["_id"]),
            "name": c["name"],
            "category": c["category"],
            "description": c["description"],
            "image": c.get("image", ""),
            "members": c.get("members", 0),
            "members_list": c.get("members_list", []),
            "creator_id": c.get("creator_id", ""),
            "createdBy": resolve_created_by(c) or "User",
            "createdAt": c.get("createdAt", ""),
        }), 200
    except Exception:
        return jsonify({"error": "Invalid community ID"}), 400


@app.route("/api/communities/<community_id>", methods=["PUT"])
def update_community(community_id):
    data = request.json or {}
    user_id = data.get("user_id")
    try:
        community = communities_collection.find_one({"_id": ObjectId(community_id)})
        if not community:
            return jsonify({"error": "Community not found"}), 404

        if community.get("creator_id") != user_id:
            return jsonify({"error": "Unauthorized: Only the creator can edit this community"}), 403

        update_fields = {}
        if "name" in data:
            update_fields["name"] = data["name"]
        if "category" in data:
            update_fields["category"] = data["category"]
        if "description" in data:
            update_fields["description"] = data["description"]
        if "image" in data and data["image"]:
            update_fields["image"] = data["image"]

        communities_collection.update_one(
            {"_id": ObjectId(community_id)},
            {"$set": update_fields},
        )
        return jsonify({"message": "Community updated successfully"}), 200
    except Exception:
        return jsonify({"error": "Update failed"}), 400


@app.route("/api/communities/<community_id>", methods=["DELETE"])
def delete_community(community_id):
    user_id = request.args.get("user_id")
    if not user_id:
        data = request.json or {}
        user_id = data.get("user_id")

    try:
        community = communities_collection.find_one({"_id": ObjectId(community_id)})
        if not community:
            return jsonify({"error": "Community not found"}), 404

        if community.get("creator_id") != user_id:
            return jsonify({"error": "Unauthorized: Only the creator can delete this community"}), 403

        result = communities_collection.delete_one({"_id": ObjectId(community_id)})
        if result.deleted_count == 1:
            posts_collection.delete_many({"communityId": community_id})
            messages_collection.delete_many({"communityId": community_id})
            events_collection.delete_many({"communityId": community_id})
            return jsonify({"message": "Community and related data deleted successfully"}), 200
        return jsonify({"error": "Community not found"}), 404
    except Exception:
        return jsonify({"error": "Invalid community ID"}), 400


@app.route("/api/communities/<community_id>/join", methods=["POST"])
def join_community(community_id):
    data = request.json or {}
    user_id = data.get("user_id")

    community = communities_collection.find_one({"_id": ObjectId(community_id)})

    if not community:
        return jsonify({"error": "Community not found"}), 404

    members_list = community.get("members_list", [])

    if user_id:
        if user_id in members_list:
            communities_collection.update_one(
                {"_id": ObjectId(community_id)},
                {"$pull": {"members_list": user_id}, "$inc": {"members": -1}},
            )
            return jsonify({"message": "Left community successfully", "status": "left"}), 200
        communities_collection.update_one(
            {"_id": ObjectId(community_id)},
            {"$push": {"members_list": user_id}, "$inc": {"members": 1}},
        )
        return jsonify({"message": "Joined community successfully", "status": "joined"}), 200

    communities_collection.update_one(
        {"_id": ObjectId(community_id)},
        {"$inc": {"members": 1}},
    )
    return jsonify({"message": "Joined community successfully", "status": "joined"}), 200


# =========================
# POSTS & MESSAGES
# =========================


@app.route("/api/communities/<community_id>/posts", methods=["POST"])
def create_post(community_id):
    data = request.json or {}
    user_id = data.get("user_id")
    user_name = data.get("user_name")
    content = data.get("content")
    image = data.get("image")

    if not user_id or not content:
        return jsonify({"error": "User ID and content are required"}), 400

    post = {
        "communityId": community_id,
        "userId": user_id,
        "userName": user_name or "Anonymous",
        "content": content,
        "image": image,
        "createdAt": datetime.datetime.now().strftime("%Y-%m-%d %H:%M"),
    }
    posts_collection.insert_one(post)
    return jsonify({"message": "Post created"}), 201


@app.route("/api/communities/<community_id>/posts", methods=["GET"])
def get_posts(community_id):
    posts = []
    for p in posts_collection.find({"communityId": community_id}).sort("_id", -1):
        posts.append({
            "id": str(p["_id"]),
            "userId": p["userId"],
            "userName": p.get("userName", "Anonymous"),
            "content": p["content"],
            "image": p.get("image"),
            "createdAt": p["createdAt"],
        })
    return jsonify(posts), 200


@app.route("/api/communities/<community_id>/messages", methods=["POST"])
def send_message(community_id):
    data = request.json or {}
    user_id = data.get("user_id")
    user_name = data.get("user_name")
    message = data.get("message")

    if not user_id or not message:
        return jsonify({"error": "User ID and message are required"}), 400

    msg = {
        "communityId": community_id,
        "userId": user_id,
        "userName": user_name or "Anonymous",
        "message": message,
        "timestamp": datetime.datetime.now().strftime("%H:%M"),
    }
    messages_collection.insert_one(msg)
    return jsonify({"message": "Message sent"}), 201


@app.route("/api/communities/<community_id>/messages", methods=["GET"])
def get_messages(community_id):
    messages = []
    for m in messages_collection.find({"communityId": community_id}).sort("_id", 1):
        messages.append({
            "id": str(m["_id"]),
            "userId": m["userId"],
            "userName": m.get("userName", "Anonymous"),
            "message": m["message"],
            "timestamp": m["timestamp"],
        })
    return jsonify(messages), 200


# =========================
# EVENTS
# =========================


@app.route("/api/events", methods=["POST"])
def create_event():
    data = request.json or {}

    title = data.get("title")
    date = data.get("date")
    location = data.get("location")
    description = data.get("description")
    image = data.get("image")
    price = data.get("price", 0)
    community_id = data.get("communityId")
    creator_id = data.get("creator_id")
    created_by = data.get("createdBy")

    if not title or not date or not location or not description:
        return jsonify({"error": "Missing required fields"}), 400

    try:
        price = float(price or 0)
    except (TypeError, ValueError):
        return jsonify({"error": "Price must be a valid number"}), 400

    if price < 0:
        return jsonify({"error": "Price cannot be negative"}), 400

    creator = get_user_by_id(creator_id)
    created_by = normalize_created_by(created_by) or normalize_created_by(get_username(creator)) or "User"

    event = {
        "title": title,
        "date": date,
        "location": location,
        "description": description,
        "image": image,
        "price": price,
        "creator_id": creator_id,
        "createdBy": created_by,
        "createdAt": data.get("createdAt") or datetime.datetime.utcnow().isoformat(),
    }
    if community_id:
        event["communityId"] = community_id

    result = events_collection.insert_one(event)
    created = events_collection.find_one({"_id": result.inserted_id})
    return jsonify({
        "message": "Event created successfully",
        "event": serialize_event(created),
    }), 201


@app.route("/api/events", methods=["GET"])
def get_events():
    community_id = request.args.get("communityId")
    if community_id:
        query = {"communityId": community_id}
    else:
        query = {"$or": [
            {"communityId": {"$exists": False}},
            {"communityId": None},
            {"communityId": ""},
        ]}

    events = []
    for e in events_collection.find(query).sort("_id", -1):
        events.append(serialize_event(e))
    return jsonify(events), 200


@app.route("/api/events/<event_id>", methods=["PUT"])
def update_event(event_id):
    data = request.json or {}
    user_id = data.get("user_id")

    try:
        event = events_collection.find_one({"_id": ObjectId(event_id)})
        if not event:
            return jsonify({"error": "Event not found"}), 404

        if event.get("creator_id") != user_id:
            return jsonify({"error": "Unauthorized: Only the creator can edit this event"}), 403

        title = data.get("title")
        date = data.get("date")
        location = data.get("location")
        description = data.get("description")
        price = data.get("price", event.get("price", 0))

        if not title or not date or not location or not description:
            return jsonify({"error": "Missing required fields"}), 400

        try:
            price = float(price or 0)
        except (TypeError, ValueError):
            return jsonify({"error": "Price must be a valid number"}), 400

        if price < 0:
            return jsonify({"error": "Price cannot be negative"}), 400

        update_fields = {
            "title": title,
            "date": date,
            "location": location,
            "description": description,
            "price": price,
            "createdBy": normalize_created_by(data.get("createdBy")) or resolve_created_by(event) or "User",
        }
        if "image" in data:
            update_fields["image"] = data.get("image") or event.get("image", "")

        events_collection.update_one({"_id": ObjectId(event_id)}, {"$set": update_fields})
        updated_event = events_collection.find_one({"_id": ObjectId(event_id)})
        return jsonify({"message": "Event updated successfully", "event": serialize_event(updated_event)}), 200
    except Exception:
        return jsonify({"error": "Update failed"}), 400


@app.route("/api/events/<event_id>", methods=["DELETE"])
def delete_event(event_id):
    user_id = request.args.get("user_id")
    if not user_id:
        data = request.json or {}
        user_id = data.get("user_id")

    try:
        event = events_collection.find_one({"_id": ObjectId(event_id)})
        if not event:
            return jsonify({"error": "Event not found"}), 404

        if event.get("creator_id") != user_id:
            return jsonify({"error": "Unauthorized: Only the creator can delete this event"}), 403

        result = events_collection.delete_one({"_id": ObjectId(event_id)})
        if result.deleted_count == 1:
            return jsonify({"message": "Event deleted successfully"}), 200
        return jsonify({"error": "Event not found"}), 404
    except Exception:
        return jsonify({"error": "Invalid event ID"}), 400


# =========================
# FUNDRAISERS
# =========================


@app.route("/api/fundraisers", methods=["POST"])
def create_fundraiser():
    data = request.json or {}

    title = data.get("title")
    target_amount = data.get("target_amount")
    description = data.get("description")
    image = data.get("image")
    creator_id = data.get("creator_id")
    created_by = data.get("createdBy")

    if not title or not target_amount or not description:
        return jsonify({"error": "Missing required fields"}), 400

    creator = get_user_by_id(creator_id)
    created_by = normalize_created_by(created_by) or normalize_created_by(get_username(creator)) or "User"

    fundraiser = {
        "title": title,
        "target_amount": target_amount,
        "description": description,
        "image": image,
        "raised_amount": 0,
        "creator_id": creator_id,
        "createdBy": created_by,
        "createdAt": datetime.datetime.utcnow().isoformat(),
    }

    result = fundraisers_collection.insert_one(fundraiser)
    created = fundraisers_collection.find_one({"_id": result.inserted_id})
    return jsonify({
        "message": "Fundraiser created successfully",
        "fundraiser": {
            "id": str(created["_id"]),
            "title": created["title"],
            "target_amount": created["target_amount"],
            "description": created["description"],
            "image": created.get("image", ""),
            "raised_amount": created.get("raised_amount", 0),
            "creator_id": created.get("creator_id", ""),
            "createdBy": resolve_created_by(created) or "User",
            "createdAt": created.get("createdAt", ""),
        },
    }), 201


@app.route("/api/fundraisers/<fundraiser_id>", methods=["PUT"])
def update_fundraiser(fundraiser_id):
    data = request.json or {}
    user_id = data.get("user_id")
    try:
        fundraiser = fundraisers_collection.find_one({"_id": ObjectId(fundraiser_id)})
        if not fundraiser:
            return jsonify({"error": "Fundraiser not found"}), 404

        if fundraiser.get("creator_id") != user_id:
            return jsonify({"error": "Unauthorized: Only the creator can edit this fundraiser"}), 403

        update_fields = {}
        if "title" in data:
            update_fields["title"] = data["title"]
        if "target_amount" in data:
            update_fields["target_amount"] = data["target_amount"]
        if "description" in data:
            update_fields["description"] = data["description"]
        if "image" in data and data["image"]:
            update_fields["image"] = data["image"]

        fundraisers_collection.update_one(
            {"_id": ObjectId(fundraiser_id)},
            {"$set": update_fields},
        )
        return jsonify({"message": "Fundraiser updated successfully"}), 200
    except Exception:
        return jsonify({"error": "Update failed"}), 400


@app.route("/api/fundraisers/<fundraiser_id>", methods=["DELETE"])
def delete_fundraiser(fundraiser_id):
    user_id = request.args.get("user_id")
    if not user_id:
        data = request.json or {}
        user_id = data.get("user_id")

    try:
        fundraiser = fundraisers_collection.find_one({"_id": ObjectId(fundraiser_id)})
        if not fundraiser:
            return jsonify({"error": "Fundraiser not found"}), 404

        if fundraiser.get("creator_id") != user_id:
            return jsonify({"error": "Unauthorized: Only the creator can delete this fundraiser"}), 403

        result = fundraisers_collection.delete_one({"_id": ObjectId(fundraiser_id)})
        if result.deleted_count == 1:
            return jsonify({"message": "Fundraiser deleted successfully"}), 200
        return jsonify({"error": "Fundraiser not found"}), 404
    except Exception:
        return jsonify({"error": "Invalid fundraiser ID"}), 400


@app.route("/api/fundraisers", methods=["GET"])
def get_fundraisers():
    fundraisers = []
    for f in fundraisers_collection.find().sort("_id", -1):
        fundraisers.append({
            "id": str(f["_id"]),
            "title": f["title"],
            "target_amount": f["target_amount"],
            "description": f["description"],
            "image": f.get("image", ""),
            "raised_amount": f.get("raised_amount", 0),
            "creator_id": f.get("creator_id", ""),
            "createdBy": resolve_created_by(f) or "User",
            "createdAt": f.get("createdAt", ""),
        })
    return jsonify(fundraisers), 200


@app.route("/api/fundraisers/<fundraiser_id>/contribute", methods=["POST"])
def contribute_fundraiser(fundraiser_id):
    try:
        data = request.json or {}
        amount = float(data.get("amount", 0))
        if amount <= 0:
            return jsonify({"error": "Invalid amount"}), 400

        result = fundraisers_collection.update_one(
            {"_id": ObjectId(fundraiser_id)},
            {"$inc": {"raised_amount": amount}},
        )
        if result.modified_count:
            return jsonify({"message": f"Successfully contributed Rs.{amount:g}"}), 200
        return jsonify({"error": "Fundraiser not found"}), 404
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400


# =========================
# CLEAN URL ROUTING
# =========================


@app.route("/<path:path>")
def serve_static_page(path):
    if "." not in path:
        html_path = f"{path}.html"
        full_html_path = os.path.join("../FRONTEND", html_path)
        if os.path.exists(full_html_path):
            return send_from_directory("../FRONTEND", html_path)

    return send_from_directory("../FRONTEND", path)


@app.route("/")
def serve_home():
    return send_from_directory("../FRONTEND", "index.html")


@app.route("/home")
def serve_home_alias():
    return send_from_directory("../FRONTEND", "index.html")


@app.route("/communities")
def serve_communities():
    return send_from_directory("../FRONTEND", "communities.html")


@app.route("/events")
def serve_events():
    return send_from_directory("../FRONTEND", "events.html")


@app.route("/fundraisers")
def serve_fundraisers():
    return send_from_directory("../FRONTEND", "fundraisers.html")


@app.route("/profile")
def serve_profile():
    return send_from_directory("../FRONTEND", "profile.html")


@app.route("/community/<community_id>")
def serve_community_detail(community_id):
    return send_from_directory("../FRONTEND", "community.html")


if __name__ == "__main__":
    app.run(debug=True)
