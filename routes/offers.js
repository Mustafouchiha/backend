const express = require("express");
const Offer = require("../models/Offer");
const Product = require("../models/Product");
const User = require("../models/User");
const authMiddleware = require("../middleware/auth");
const { notifyUser } = require("../bot");

const router = express.Router();

const MINI_APP_URL = () => process.env.MINI_APP_URL || "https://frontend-353d.vercel.app/";

// POST /api/offers — taklif yuborish
router.post("/", authMiddleware, async (req, res) => {
  try {
    const { productId, message } = req.body;
    if (!productId) return res.status(400).json({ message: "Mahsulot ID majburiy" });

    const product = await Product.findById(productId);
    if (!product || product.status !== "active") {
      return res.status(404).json({ message: "Mahsulot topilmadi yoki faol emas" });
    }
    if (product.owner_id === req.user.id) {
      return res.status(400).json({ message: "O'z mahsulotingizga taklif yubora olmaysiz" });
    }

    const existing = await Offer.findOne({ product_id: productId, buyer_id: req.user.id, status: "pending" });
    if (existing) return res.status(400).json({ message: "Bu mahsulotga allaqachon taklif yuborgan" });

    const offer = await Offer.create({
      product_id: productId,
      buyer_id:   req.user.id,
      seller_id:  product.owner_id,
      message:    message || "",
    });

    // Sotuvchiga xabar — xaridor kontakti mahfiy, faqat to'lovdan keyin yuboriladi
    if (product.owner_id) {
      const seller = await User.findById(product.owner_id);
      if (seller?.tg_chat_id) {
        await notifyUser(
          seller.tg_chat_id,
          `📦 *Yangi taklif keldi!*\n\n` +
          `🧱 Mahsulot: ${product.name}\n` +
          `💰 Narx: ${Number(product.price).toLocaleString()} so'm\n` +
          (message ? `💬 Xabar: ${message}\n` : "") +
          `\n🔒 Xaridor ma'lumotlari to'lovdan so'ng yuboriladi.`,
          {
            reply_markup: {
              inline_keyboard: [[{
                text: "📋 Taklifni ko'rish",
                web_app: { url: MINI_APP_URL() },
              }]],
            },
          }
        ).catch(() => {});
      }
    }

    res.status(201).json({
      id:           offer.id,
      productId:    product.id,
      productName:  product.name,
      productPrice: Number(product.price),
      productUnit:  product.unit,
      buyerId:      req.user.id,
      buyerName:    req.user.name,
      buyerPhone:   req.user.phone,
      buyerTelegram: req.user.telegram,
      sellerId:     product.owner_id,
      status:       offer.status,
      sentAt:       offer.created_at,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/offers — o'zimga kelgan takliflar (seller)
router.get("/", authMiddleware, async (req, res) => {
  try {
    const offers = await Offer.findBySeller(req.user.id);
    res.json(offers.map(o => ({
      id:           o.id,
      productId:    o.product_id,
      productName:  o.product_name,
      productPrice: Number(o.product_price),
      productUnit:  o.product_unit,
      buyerId:      o.buyer_id,
      buyerName:    o.buyer_name,
      buyerPhone:   o.buyer_phone,
      buyerTelegram: o.buyer_telegram,
      ownerId:      o.seller_id,
      status:       o.status,
      sentAt:       o.created_at,
    })));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/offers/sent — o'zim yuborgan takliflar (buyer)
router.get("/sent", authMiddleware, async (req, res) => {
  try {
    const offers = await Offer.findByBuyer(req.user.id);
    res.json(offers.map(o => ({
      id:           o.id,
      productId:    o.product_id,
      productName:  o.product_name,
      productPrice: Number(o.product_price),
      productUnit:  o.product_unit,
      sellerId:     o.seller_id,
      sellerName:   o.seller_name,
      status:       o.status,
      sentAt:       o.created_at,
    })));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PUT /api/offers/:id/paid — to'lov tasdiqlash (seller) + post o'chirish
router.put("/:id/paid", authMiddleware, async (req, res) => {
  try {
    const offer = await Offer.updateStatus(req.params.id, req.user.id, "paid");
    if (!offer) return res.status(404).json({ message: "Taklif topilmadi yoki ruxsat yo'q" });

    // Post avtomatik o'chirilsin
    if (offer.product_id) {
      await Product.setStatus(offer.product_id, "deleted").catch(() => {});
    }

    // Har ikki tomonga ma'lumot yuborish
    const fullOffer = await Offer.findById(offer.id);
    if (fullOffer) {
      const buyerUser = fullOffer.buyer_id ? await User.findById(fullOffer.buyer_id) : null;
      const sellerUser = req.user;

      if (buyerUser?.tg_chat_id) {
        await notifyUser(buyerUser.tg_chat_id,
          `🎉 *Bitim yakunlandi!*\n\n` +
          `📦 Mahsulot: ${fullOffer.product_name || "Noma'lum"}\n\n` +
          `📞 Sotuvchi ma'lumotlari:\n` +
          `👤 ${sellerUser.name}\n` +
          `📱 ${sellerUser.phone}\n` +
          `✈️ ${sellerUser.telegram || "—"}`,
          { parse_mode: "Markdown" }
        ).catch(() => {});
      }
      if (sellerUser?.tg_chat_id) {
        await notifyUser(sellerUser.tg_chat_id,
          `💸 *Bitim yakunlandi!*\n\n` +
          `📦 Mahsulot: ${fullOffer.product_name || "Noma'lum"}\n\n` +
          `📞 Xaridor ma'lumotlari:\n` +
          `👤 ${buyerUser?.name || "Noma'lum"}\n` +
          `📱 ${buyerUser?.phone || "—"}\n` +
          `✈️ ${buyerUser?.telegram || "—"}`,
          { parse_mode: "Markdown" }
        ).catch(() => {});
      }
    }

    res.json({ message: "Bitim yakunlandi", id: offer.id });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
