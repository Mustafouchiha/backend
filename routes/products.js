const express = require("express");
const Product = require("../models/Product");
const authMiddleware = require("../middleware/auth");
const optionalAuth = require("../middleware/optionalAuth");

const router = express.Router();

const OPERATOR_PHONES = (process.env.OPERATOR_PHONES || "331350206").split(",").map(p => p.trim());

function isOperatorUser(user) {
  if (!user) return false;
  if (user.role === "operator") return true;
  const core = String(user.phone || "").replace(/\D/g, "").slice(-9);
  return OPERATOR_PHONES.includes(core);
}

function formatProduct(p) {
  const price1   = Number(p.price_1   || p.price || 0);
  const price10  = Number(p.price_10  || p.price || 0);
  const price100 = Number(p.price_100 || p.price || 0);
  return {
    id:           p.id,
    name:         p.name,
    category:     p.category,
    price:        price1,
    price_1:      price1,
    price_10:     price10,
    price_100:    price100,
    unit:         p.unit,
    qty:          p.qty,
    condition:    p.condition,
    viloyat:      p.viloyat,
    tuman:        p.tuman,
    photo:        p.photo,
    photos:       p.photos ? JSON.parse(p.photos) : (p.photo ? [p.photo] : []),
    dim_x:        p.dim_x ? Number(p.dim_x) : null,
    dim_y:        p.dim_y ? Number(p.dim_y) : null,
    dim_z:        p.dim_z ? Number(p.dim_z) : null,
    ownerId:      p.owner_id,
    ownerName:    p.owner_name || "Noma'lum",
    ownerPhone:   p.owner_phone || null,
    ownerTelegram: p.owner_telegram || null,
    status:       p.status || "active",
    rejectedReason: p.rejected_reason || null,
    createdAt:    p.created_at,
  };
}

// GET /api/products — barcha active postlar (narx ko'rinadi)
router.get("/", optionalAuth, async (req, res) => {
  try {
    const { category, viloyat, tuman, search, dim_x_min, dim_x_max, dim_y_min, dim_y_max } = req.query;
    const filter = { status: "active" };

    if (category && category !== "Barchasi") filter.category = category;
    if (viloyat)   filter.viloyat   = viloyat;
    if (tuman)     filter.tuman     = tuman;
    if (search)    filter.search    = search;
    if (dim_x_min) filter.dim_x_min = Number(dim_x_min);
    if (dim_x_max) filter.dim_x_max = Number(dim_x_max);
    if (dim_y_min) filter.dim_y_min = Number(dim_y_min);
    if (dim_y_max) filter.dim_y_max = Number(dim_y_max);

    const products = await Product.find(filter);
    const formatted = products.map(p => formatProduct(p));

    // Agar natija bo'sh va o'lcham filter bor bo'lsa — yaqin o'lchamlarni qo'shamiz
    if (formatted.length === 0 && (dim_x_min || dim_x_max || dim_y_min || dim_y_max)) {
      const dim_x = dim_x_min ? (Number(dim_x_min) + Number(dim_x_max || dim_x_min)) / 2 : null;
      const dim_y = dim_y_min ? (Number(dim_y_min) + Number(dim_y_max || dim_y_min)) / 2 : null;
      const similar = await Product.findSimilarDims({ dim_x, dim_y, category: filter.category });
      return res.json({ products: [], similar: similar.map(p => formatProduct(p)), hasSimilar: true });
    }

    res.json(formatted);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/products/similar — yaqin o'lchamdagi mahsulotlar
router.get("/similar", optionalAuth, async (req, res) => {
  try {
    const { dim_x, dim_y, category, excludeId } = req.query;
    const similar = await Product.findSimilarDims({
      dim_x: dim_x ? Number(dim_x) : null,
      dim_y: dim_y ? Number(dim_y) : null,
      category,
      excludeId,
    });
    res.json(similar.map(p => formatProduct(p)));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/products/my — o'z postlari
router.get("/my", authMiddleware, async (req, res) => {
  try {
    const products = await Product.find({ owner_id: req.user.id, status: "all" });
    res.json(products.map(p => formatProduct(p)));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/products — faqat operator yaratadi (to'g'ridan active)
router.post("/", authMiddleware, async (req, res) => {
  try {
    if (!isOperatorUser(req.user)) {
      return res.status(403).json({ message: "Faqat operator mahsulot qo'sha oladi" });
    }

    const { name, category, price_1, price_10, price_100,
            unit, qty, condition, viloyat, tuman, photo, photos,
            dim_x, dim_y, dim_z } = req.body;

    if (!name || !price_1 || !qty || !viloyat) {
      return res.status(400).json({ message: "Barcha majburiy maydonlarni to'ldiring" });
    }

    const photosJson = Array.isArray(photos) && photos.length
      ? JSON.stringify(photos)
      : (photo ? JSON.stringify([photo]) : null);

    const product = await Product.create({
      name,
      category: category || "yog'och",
      price_1:   Number(price_1),
      price_10:  Number(price_10  || price_1),
      price_100: Number(price_100 || price_1),
      unit: unit || "dona",
      qty:  Number(qty),
      condition: condition || "A'lo",
      viloyat,
      tuman: tuman || "",
      photo: photo || (Array.isArray(photos) ? photos[0] : null) || null,
      photos: photosJson,
      dim_x: dim_x ? Number(dim_x) : null,
      dim_y: dim_y ? Number(dim_y) : null,
      dim_z: dim_z ? Number(dim_z) : null,
      owner_id: req.user.id,
      status: "active",
    });

    const parsedPhotos = product.photos ? JSON.parse(product.photos) : (product.photo ? [product.photo] : []);

    res.status(201).json({
      ...formatProduct(product),
      photos: parsedPhotos,
      ownerName: req.user.name,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PUT /api/products/:id — yangilash (faqat operator)
router.put("/:id", authMiddleware, async (req, res) => {
  try {
    if (!isOperatorUser(req.user)) {
      return res.status(403).json({ message: "Faqat operator yangilay oladi" });
    }
    const fields = {};
    const allowed = ["name","category","price_1","price_10","price_100",
                     "unit","qty","condition","viloyat","tuman","photo","photos",
                     "dim_x","dim_y","dim_z"];
    for (const f of allowed) {
      if (req.body[f] !== undefined) fields[f] = req.body[f];
    }
    const updated = await Product.update(req.params.id, req.user.id, fields);
    if (!updated) return res.status(404).json({ message: "Mahsulot topilmadi yoki ruxsat yo'q" });
    res.json({ message: "Yangilandi", id: updated.id });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// DELETE /api/products/:id — o'chirish (faqat operator)
router.delete("/:id", authMiddleware, async (req, res) => {
  try {
    if (!isOperatorUser(req.user)) {
      return res.status(403).json({ message: "Faqat operator o'chira oladi" });
    }
    const updated = await Product.update(req.params.id, req.user.id, { status: "deleted", is_active: false });
    if (!updated) return res.status(404).json({ message: "Mahsulot topilmadi yoki ruxsat yo'q" });
    res.json({ message: "O'chirildi" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/products/:id — bitta mahsulot
router.get("/:id", optionalAuth, async (req, res) => {
  try {
    const p = await Product.findById(req.params.id);
    if (!p) return res.status(404).json({ message: "Topilmadi" });
    res.json(formatProduct(p));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
