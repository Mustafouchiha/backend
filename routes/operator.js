const express = require("express");
const { query } = require("../db");
const Product = require("../models/Product");
const User = require("../models/User");
const operatorAuth = require("../middleware/operatorAuth");

const router = express.Router();
router.use(operatorAuth);

const MAIN_OPERATOR_PHONE = "331350206";
const depositInProgress = new Set();

function isMainOp(user) {
  return (user.phone || "").replace(/\D/g, "").slice(-9) === MAIN_OPERATOR_PHONE;
}

// ── Pending postlar (tasdiqlash navbati) ─────────────────────────
router.get("/pending-posts", async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT p.*, u.name AS owner_name, u.phone AS owner_phone, u.telegram AS owner_telegram
       FROM products p
       LEFT JOIN users u ON u.id = p.owner_id
       WHERE p.status = 'pending_approval'
       ORDER BY p.created_at ASC`
    );
    res.json(rows.map(p => ({
      id: p.id, name: p.name, category: p.category,
      price: Number(p.price), unit: p.unit, qty: p.qty,
      condition: p.condition, viloyat: p.viloyat, tuman: p.tuman,
      photo: p.photo,
      photos: p.photos ? JSON.parse(p.photos) : (p.photo ? [p.photo] : []),
      status: p.status,
      ownerName: p.owner_name || "Noma'lum",
      ownerPhone: p.owner_phone || "",
      ownerTelegram: p.owner_telegram || "",
      ownerId: p.owner_id,
      createdAt: p.created_at,
    })));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── Postni tasdiqlash → pending_payment ──────────────────────────
router.put("/posts/:id/approve", async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ message: "Post topilmadi" });
    if (product.status !== "pending_approval") {
      return res.status(400).json({ message: "Bu post allaqachon ko'rib chiqilgan" });
    }

    const updated = await Product.setStatus(req.params.id, "pending_payment", {
      approved_by: req.user.id,
    });

    // Egasiga xabar
    if (product.owner_id) {
      const owner = await User.findById(product.owner_id);
      if (owner?.tg_chat_id) {
        const { notifyUser } = require("../bot");
        await notifyUser(owner.tg_chat_id,
          `✅ *E'loningiz tasdiqlandi!*\n\n` +
          `📦 Mahsulot: ${product.name}\n\n` +
          `💳 Endi to'lov qiling:\n` +
          `Karta: *${process.env.OPERATOR_CARD || "9860 0000 0000 0000"}*\n` +
          `Egasi: ${process.env.OPERATOR_NAME || "Operator"}\n\n` +
          `To'lov qilgandan so'ng e'loningiz faollashtiriladi.`,
          { parse_mode: "Markdown" }
        ).catch(() => {});
      }
    }

    res.json({ message: "Tasdiqlandi", product: updated });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── Postni rad etish → deleted ───────────────────────────────────
router.put("/posts/:id/reject", async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason?.trim()) return res.status(400).json({ message: "Rad etish sababi majburiy" });

    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ message: "Post topilmadi" });

    const updated = await Product.setStatus(req.params.id, "deleted", {
      rejected_reason: reason.trim(),
    });

    // Egasiga xabar
    if (product.owner_id) {
      const owner = await User.findById(product.owner_id);
      if (owner?.tg_chat_id) {
        const { notifyUser } = require("../bot");
        await notifyUser(owner.tg_chat_id,
          `❌ *E'loningiz rad etildi*\n\n` +
          `📦 Mahsulot: ${product.name}\n` +
          `📝 Sabab: ${reason.trim()}`,
          { parse_mode: "Markdown" }
        ).catch(() => {});
      }
    }

    res.json({ message: "Rad etildi", product: updated });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── Postni yashirish ─────────────────────────────────────────────
router.put("/posts/:id/hide", async (req, res) => {
  try {
    const updated = await Product.setStatus(req.params.id, "hidden");
    if (!updated) return res.status(404).json({ message: "Post topilmadi" });
    res.json({ message: "Yashirildi", product: updated });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── Postni ko'rsatish ────────────────────────────────────────────
router.put("/posts/:id/show", async (req, res) => {
  try {
    const updated = await Product.setStatus(req.params.id, "active");
    if (!updated) return res.status(404).json({ message: "Post topilmadi" });
    res.json({ message: "Ko'rsatildi", product: updated });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── Postni o'chirish (permanent soft delete) ─────────────────────
router.delete("/posts/:id", async (req, res) => {
  try {
    const updated = await Product.setStatus(req.params.id, "deleted");
    if (!updated) return res.status(404).json({ message: "Post topilmadi" });
    res.json({ message: "O'chirildi" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── Barcha postlar (operator panel) ─────────────────────────────
router.get("/products", async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    const VALID_STATUSES = ["active", "pending_approval", "pending_payment", "hidden", "deleted"];
    const statusFilter = req.query.status || "all";
    const useStatus = statusFilter !== "all" && VALID_STATUSES.includes(statusFilter);

    let rows;
    if (!q && !useStatus) {
      ({ rows } = await query(
        `SELECT p.id, p.name, p.price, p.unit, p.qty, p.category, p.viloyat, p.status,
                u.name AS owner_name, u.phone AS owner_phone, p.created_at
         FROM products p LEFT JOIN users u ON p.owner_id = u.id
         WHERE p.status != 'deleted'
         ORDER BY p.created_at DESC LIMIT 50`
      ));
    } else if (!q && useStatus) {
      ({ rows } = await query(
        `SELECT p.id, p.name, p.price, p.unit, p.qty, p.category, p.viloyat, p.status,
                u.name AS owner_name, u.phone AS owner_phone, p.created_at
         FROM products p LEFT JOIN users u ON p.owner_id = u.id
         WHERE p.status = $1
         ORDER BY p.created_at DESC LIMIT 50`,
        [statusFilter]
      ));
    } else if (q && !useStatus) {
      ({ rows } = await query(
        `SELECT p.id, p.name, p.price, p.unit, p.qty, p.category, p.viloyat, p.status,
                u.name AS owner_name, u.phone AS owner_phone, p.created_at
         FROM products p LEFT JOIN users u ON p.owner_id = u.id
         WHERE p.status != 'deleted'
           AND (p.name ILIKE $1 OR p.id::text ILIKE $1 OR u.phone ILIKE $1 OR u.name ILIKE $1)
         ORDER BY p.created_at DESC LIMIT 30`,
        [`%${q}%`]
      ));
    } else {
      ({ rows } = await query(
        `SELECT p.id, p.name, p.price, p.unit, p.qty, p.category, p.viloyat, p.status,
                u.name AS owner_name, u.phone AS owner_phone, p.created_at
         FROM products p LEFT JOIN users u ON p.owner_id = u.id
         WHERE p.status = $1
           AND (p.name ILIKE $2 OR p.id::text ILIKE $2 OR u.phone ILIKE $2 OR u.name ILIKE $2)
         ORDER BY p.created_at DESC LIMIT 30`,
        [statusFilter, `%${q}%`]
      ));
    }
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── Foydalanuvchilar ─────────────────────────────────────────────
router.get("/users", async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    let rows;
    if (!q) {
      ({ rows } = await query(
        "SELECT id, name, phone, telegram, balance, tg_chat_id, is_blocked, role, joined FROM users ORDER BY joined DESC LIMIT 50"
      ));
    } else {
      ({ rows } = await query(
        `SELECT id, name, phone, telegram, balance, tg_chat_id, is_blocked, role, joined FROM users
         WHERE phone ILIKE $1 OR name ILIKE $1 OR id::text ILIKE $1
         ORDER BY joined DESC LIMIT 30`,
        [`%${q}%`]
      ));
    }
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── Foydalanuvchini bloklash ─────────────────────────────────────
router.put("/users/:id/block", async (req, res) => {
  try {
    const { rows } = await query(
      "SELECT phone FROM users WHERE id = $1 LIMIT 1",
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ message: "Topilmadi" });
    const phone = rows[0].phone?.replace(/\D/g, "").slice(-9);
    if (phone === MAIN_OPERATOR_PHONE) {
      return res.status(403).json({ message: "Bosh operatorni bloklab bo'lmaydi" });
    }
    await query(
      "UPDATE users SET is_blocked = TRUE WHERE id = $1",
      [req.params.id]
    );
    res.json({ message: "Bloklandi" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── Foydalanuvchi blokini ochish ─────────────────────────────────
router.put("/users/:id/unblock", async (req, res) => {
  try {
    await query("UPDATE users SET is_blocked = FALSE WHERE id = $1", [req.params.id]);
    res.json({ message: "Blok ochildi" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── Foydalanuvchini o'chirish ────────────────────────────────────
router.delete("/users/:id", async (req, res) => {
  try {
    const { rows } = await query("SELECT phone FROM users WHERE id = $1 LIMIT 1", [req.params.id]);
    if (!rows[0]) return res.status(404).json({ message: "Topilmadi" });
    const phone = rows[0].phone?.replace(/\D/g, "").slice(-9);
    if (phone === MAIN_OPERATOR_PHONE) {
      return res.status(403).json({ message: "Bosh operatorni o'chirib bo'lmaydi" });
    }
    if (req.params.id === req.user.id) {
      return res.status(400).json({ message: "O'zingizni o'chira olmaysiz" });
    }
    // Postlari owner_id = NULL qolsin
    await Product.setOwnerNull(req.params.id);
    await query("DELETE FROM users WHERE id = $1", [req.params.id]);
    res.json({ message: "O'chirildi" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── Pul qo'shish ─────────────────────────────────────────────────
router.post("/deposit", async (req, res) => {
  const { phone, amount } = req.body;
  if (!phone || !amount) return res.status(400).json({ message: "phone va amount majburiy" });
  const sum = Number(amount);
  if (isNaN(sum) || sum <= 0) return res.status(400).json({ message: "Summa noto'g'ri" });

  const phoneKey = phone.replace(/\D/g, "").slice(-9);
  if (depositInProgress.has(phoneKey)) {
    return res.status(429).json({ message: "Iltimos kuting, avvalgi amal bajarilmoqda" });
  }
  depositInProgress.add(phoneKey);

  try {
    const { rows: found } = await query(
      "SELECT * FROM users WHERE phone = $1 LIMIT 1", [phoneKey]
    );
    if (!found[0]) return res.status(404).json({ message: "Foydalanuvchi topilmadi" });

    const { rows } = await query(
      "UPDATE users SET balance = balance + $1 WHERE id = $2 RETURNING id, name, phone, balance",
      [sum, found[0].id]
    );

    if (found[0].tg_chat_id) {
      const { notifyUser } = require("../bot");
      await notifyUser(found[0].tg_chat_id,
        `💰 *Hisobingiz to'ldirildi!*\n\nSumma: *${sum.toLocaleString()} so'm*\nJami balans: *${Number(rows[0].balance).toLocaleString()} so'm*`,
        { parse_mode: "Markdown" }
      ).catch(() => {});
    }

    res.json({ message: `${sum.toLocaleString()} so'm qo'shildi`, user: rows[0] });
  } catch (err) {
    res.status(500).json({ message: err.message });
  } finally {
    depositInProgress.delete(phoneKey);
  }
});

// ── Balansdan pul ayirish ─────────────────────────────────────────
router.post("/withdraw", async (req, res) => {
  try {
    const { phone, amount } = req.body;
    if (!phone || !amount) return res.status(400).json({ message: "phone va amount majburiy" });
    const sum = Number(amount);
    if (isNaN(sum) || sum <= 0) return res.status(400).json({ message: "Summa noto'g'ri" });

    const phoneKey = phone.replace(/\D/g, "").slice(-9);
    const { rows: found } = await query(
      "SELECT * FROM users WHERE phone = $1 LIMIT 1", [phoneKey]
    );
    if (!found[0]) return res.status(404).json({ message: "Foydalanuvchi topilmadi" });
    if (Number(found[0].balance) < sum) {
      return res.status(400).json({ message: "Balans yetarli emas" });
    }

    const { rows } = await query(
      "UPDATE users SET balance = balance - $1 WHERE id = $2 RETURNING id, name, phone, balance",
      [sum, found[0].id]
    );

    if (found[0].tg_chat_id) {
      const { notifyUser } = require("../bot");
      await notifyUser(found[0].tg_chat_id,
        `💸 *Hisobingizdan pul ayirildi*\n\nSumma: *${sum.toLocaleString()} so'm*\nQolgan balans: *${Number(rows[0].balance).toLocaleString()} so'm*`,
        { parse_mode: "Markdown" }
      ).catch(() => {});
    }

    res.json({ message: `${sum.toLocaleString()} so'm ayirildi`, user: rows[0] });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── Operatorlar ro'yxati ─────────────────────────────────────────
router.get("/operators", async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, name, phone, telegram, role, joined FROM users
       WHERE role = 'operator' OR phone = $1 ORDER BY joined ASC`,
      [MAIN_OPERATOR_PHONE]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── Operator qo'shish (faqat bosh operator) ──────────────────────
router.post("/operators", async (req, res) => {
  if (!isMainOp(req.user)) {
    return res.status(403).json({ message: "Faqat bosh operator operator qo'sha oladi" });
  }
  try {
    const { identifier, phone } = req.body;
    const search = (identifier || phone || "").trim();
    if (!search) return res.status(400).json({ message: "Telefon yoki ism majburiy" });

    // Try by phone first
    const phoneKey = search.replace(/\D/g, "").slice(-9);
    if (phoneKey === MAIN_OPERATOR_PHONE) {
      return res.status(400).json({ message: "Bosh operator allaqachon operator" });
    }
    let targetUser = null;
    if (phoneKey.length === 9) {
      const { rows: byPhone } = await query(
        "SELECT * FROM users WHERE phone = $1 LIMIT 1", [phoneKey]
      );
      targetUser = byPhone[0] || null;
    }
    // If not found by phone, try by name
    if (!targetUser) {
      const { rows: byName } = await query(
        "SELECT * FROM users WHERE name ILIKE $1 ORDER BY joined DESC LIMIT 1",
        [`%${search}%`]
      );
      targetUser = byName[0] || null;
    }
    if (!targetUser) return res.status(404).json({ message: "Foydalanuvchi topilmadi" });

    const { rows: updated } = await query(
      "UPDATE users SET role = 'operator' WHERE id = $1 RETURNING id, name, phone, role",
      [targetUser.id]
    );
    res.json({ message: "Operator qo'shildi", user: updated[0] });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── Operatorni o'chirish (faqat bosh operator) ───────────────────
router.delete("/operators/:id", async (req, res) => {
  if (!isMainOp(req.user)) {
    return res.status(403).json({ message: "Faqat bosh operator operatorni o'chira oladi" });
  }
  try {
    const { rows } = await query("SELECT phone FROM users WHERE id = $1 LIMIT 1", [req.params.id]);
    if (!rows[0]) return res.status(404).json({ message: "Topilmadi" });
    const phone = rows[0].phone?.replace(/\D/g, "").slice(-9);
    if (phone === MAIN_OPERATOR_PHONE) {
      return res.status(403).json({ message: "Bosh operatorni o'chirib bo'lmaydi" });
    }
    await query("UPDATE users SET role = 'user' WHERE id = $1", [req.params.id]);
    res.json({ message: "Operator o'chirildi" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── To'lovni operator tomonidan tasdiqlash ───────────────────────
router.put("/payments/:offerId/confirm", async (req, res) => {
  try {
    const { offerId } = req.params;

    // Lock
    const { rowCount } = await query(
      "INSERT INTO payment_locks (offer_id) VALUES ($1) ON CONFLICT DO NOTHING",
      [offerId]
    );
    if (rowCount === 0) return res.status(400).json({ message: "Bu to'lov allaqachon qayta ishlanmoqda" });

    try {
      const { rows: payRows } = await query(
        `SELECT pay.*, o.product_id, o.buyer_id AS offer_buyer, o.seller_id AS offer_seller,
                p.name AS product_name, p.price AS product_price,
                b.name AS buyer_name, b.phone AS buyer_phone, b.telegram AS buyer_tg,
                s.name AS seller_name, s.phone AS seller_phone, s.telegram AS seller_tg,
                s.tg_chat_id AS seller_chat, b.tg_chat_id AS buyer_chat
         FROM payments pay
         JOIN offers o ON o.id = pay.offer_id
         LEFT JOIN products p ON p.id = o.product_id
         LEFT JOIN users b ON b.id = o.buyer_id
         LEFT JOIN users s ON s.id = o.seller_id
         WHERE pay.offer_id = $1 LIMIT 1`,
        [offerId]
      );
      if (!payRows[0]) {
        await query("DELETE FROM payment_locks WHERE offer_id = $1", [offerId]);
        return res.status(404).json({ message: "To'lov topilmadi" });
      }
      const pay = payRows[0];
      if (pay.status === "confirmed") {
        await query("DELETE FROM payment_locks WHERE offer_id = $1", [offerId]);
        return res.status(400).json({ message: "Allaqachon tasdiqlangan" });
      }

      // Tasdiqlash
      await query(
        "UPDATE payments SET status='confirmed', confirmed_at=NOW(), updated_at=NOW() WHERE offer_id=$1",
        [offerId]
      );
      await query(
        "UPDATE offers SET status='paid', updated_at=NOW() WHERE id=$1",
        [offerId]
      );
      // Post o'chirilsin
      if (pay.product_id) {
        await Product.setStatus(pay.product_id, "deleted");
      }

      const { notifyUser } = require("../bot");
      const MINI_APP_URL = process.env.MINI_APP_URL || "https://frontend-353d.vercel.app/";

      // Xaridorga
      if (pay.buyer_chat) {
        await notifyUser(pay.buyer_chat,
          `✅ *To'lovingiz tasdiqlandi!*\n\n` +
          `📦 Mahsulot: ${pay.product_name}\n` +
          `💰 Summa: ${Number(pay.product_price).toLocaleString()} so'm\n\n` +
          `📞 Sotuvchi ma'lumotlari:\n` +
          `👤 Ism: ${pay.seller_name || "Noma'lum"}\n` +
          `📱 Tel: ${pay.seller_phone || "—"}\n` +
          `✈️ Telegram: ${pay.seller_tg || "—"}`,
          { parse_mode: "Markdown" }
        ).catch(() => {});
      }
      // Sotuvchiga
      if (pay.seller_chat) {
        await notifyUser(pay.seller_chat,
          `💸 *To'lov tasdiqlandi, bitim yakunlandi!*\n\n` +
          `📦 Mahsulot: ${pay.product_name}\n` +
          `💰 Summa: ${Number(pay.product_price).toLocaleString()} so'm\n\n` +
          `📞 Xaridor ma'lumotlari:\n` +
          `👤 Ism: ${pay.buyer_name || "Noma'lum"}\n` +
          `📱 Tel: ${pay.buyer_phone || "—"}\n` +
          `✈️ Telegram: ${pay.buyer_tg || "—"}`,
          { parse_mode: "Markdown" }
        ).catch(() => {});
      }

      res.json({ message: "To'lov tasdiqlandi, bitim yakunlandi" });
    } finally {
      await query("DELETE FROM payment_locks WHERE offer_id = $1", [offerId]).catch(() => {});
    }
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── App orqali kelmagan to'lovlar (pending_payment, payment yo'q) ─
router.get("/pending-offers", async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT o.id AS offer_id, o.status AS offer_status, o.created_at,
              p.id AS product_id, p.name AS product_name, p.price AS product_price,
              b.name AS buyer_name, b.phone AS buyer_phone,
              s.name AS seller_name, s.phone AS seller_phone
       FROM offers o
       LEFT JOIN products p ON p.id = o.product_id
       LEFT JOIN users b ON b.id = o.buyer_id
       LEFT JOIN users s ON s.id = o.seller_id
       LEFT JOIN payments pay ON pay.offer_id = o.id
       WHERE p.status = 'pending_payment'
         AND o.status = 'pending'
         AND pay.id IS NULL
       ORDER BY o.created_at DESC LIMIT 50`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── Qo'lda to'lovni tasdiqlash (app tashqarisida to'langan) ──────
router.post("/manual-confirm/:offerId", async (req, res) => {
  const { offerId } = req.params;
  const { rowCount } = await query(
    "INSERT INTO payment_locks (offer_id) VALUES ($1) ON CONFLICT DO NOTHING",
    [offerId]
  );
  if (rowCount === 0) return res.status(400).json({ message: "Allaqachon qayta ishlanmoqda" });

  try {
    const { rows: offerRows } = await query(
      `SELECT o.*, p.name AS product_name, p.price AS product_price,
              b.name AS buyer_name, b.phone AS buyer_phone, b.telegram AS buyer_tg, b.tg_chat_id AS buyer_chat,
              s.name AS seller_name, s.phone AS seller_phone, s.telegram AS seller_tg, s.tg_chat_id AS seller_chat
       FROM offers o
       LEFT JOIN products p ON p.id = o.product_id
       LEFT JOIN users b ON b.id = o.buyer_id
       LEFT JOIN users s ON s.id = o.seller_id
       WHERE o.id = $1 LIMIT 1`,
      [offerId]
    );
    if (!offerRows[0]) return res.status(404).json({ message: "Offer topilmadi" });
    const offer = offerRows[0];
    if (offer.status === "paid") return res.status(400).json({ message: "Allaqachon to'langan" });

    const opCard = process.env.OPERATOR_CARD || "9860160619731286";
    await query(
      `INSERT INTO payments (offer_id, buyer_id, seller_id, product_id, amount, status, card_to, confirmed_at)
       VALUES ($1,$2,$3,$4,$5,'confirmed',$6,NOW())
       ON CONFLICT (offer_id) DO UPDATE SET status='confirmed', confirmed_at=NOW(), updated_at=NOW()`,
      [offerId, offer.buyer_id, offer.seller_id, offer.product_id, offer.product_price || 0, opCard]
    );
    await query("UPDATE offers SET status='paid', updated_at=NOW() WHERE id=$1", [offerId]);
    if (offer.product_id) await Product.setStatus(offer.product_id, "deleted");

    const { notifyUser } = require("../bot");
    if (offer.buyer_chat) {
      await notifyUser(offer.buyer_chat,
        `✅ *To'lovingiz tasdiqlandi!*\n\n📦 ${offer.product_name}\n\n📞 Sotuvchi:\n👤 ${offer.seller_name||"—"}\n📱 ${offer.seller_phone||"—"}\n✈️ ${offer.seller_tg||"—"}`,
        { parse_mode: "Markdown" }
      ).catch(() => {});
    }
    if (offer.seller_chat) {
      await notifyUser(offer.seller_chat,
        `💸 *Bitim yakunlandi!*\n\n📦 ${offer.product_name}\n\n📞 Xaridor:\n👤 ${offer.buyer_name||"—"}\n📱 ${offer.buyer_phone||"—"}\n✈️ ${offer.buyer_tg||"—"}`,
        { parse_mode: "Markdown" }
      ).catch(() => {});
    }
    res.json({ message: "Qo'lda tasdiqlandi" });
  } finally {
    await query("DELETE FROM payment_locks WHERE offer_id=$1", [offerId]).catch(() => {});
  }
});

// ── Operator to'lovlari (pending) ───────────────────────────────
router.get("/payments", async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT pay.id, pay.offer_id, pay.amount, pay.status, pay.card_from, pay.card_to, pay.note, pay.created_at,
              p.name AS product_name,
              b.name AS buyer_name, b.phone AS buyer_phone,
              s.name AS seller_name, s.phone AS seller_phone
       FROM payments pay
       LEFT JOIN offers o ON o.id = pay.offer_id
       LEFT JOIN products p ON p.id = pay.product_id
       LEFT JOIN users b ON b.id = pay.buyer_id
       LEFT JOIN users s ON s.id = pay.seller_id
       WHERE pay.status = 'pending'
       ORDER BY pay.created_at DESC LIMIT 50`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── Statistika ───────────────────────────────────────────────────
router.get("/stats", async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT
        (SELECT COUNT(*) FROM users) AS total_users,
        (SELECT COUNT(*) FROM products WHERE status = 'active') AS active_products,
        (SELECT COUNT(*) FROM products WHERE status = 'pending_approval') AS pending_approval,
        (SELECT COUNT(*) FROM payments WHERE status = 'pending') AS pending_payments
    `);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
