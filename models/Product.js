const { query } = require("../db");

const Product = {
  async find(filter = {}) {
    const conditions = [];
    const values = [];
    let i = 1;

    const statusFilter = filter.status || "active";
    if (statusFilter === "active") {
      conditions.push(`p.status = 'active'`);
    } else if (Array.isArray(statusFilter)) {
      conditions.push(`p.status = ANY($${i++})`);
      values.push(statusFilter);
    } else if (statusFilter !== "all") {
      conditions.push(`p.status = $${i++}`);
      values.push(statusFilter);
    }

    if (filter.owner_ne) {
      conditions.push(`p.owner_id != $${i++}`);
      values.push(filter.owner_ne);
    }
    if (filter.owner_id) {
      conditions.push(`p.owner_id = $${i++}`);
      values.push(filter.owner_id);
    }
    if (filter.category) {
      conditions.push(`p.category = $${i++}`);
      values.push(filter.category);
    }
    if (filter.viloyat) {
      conditions.push(`p.viloyat = $${i++}`);
      values.push(filter.viloyat);
    }
    if (filter.tuman) {
      conditions.push(`p.tuman = $${i++}`);
      values.push(filter.tuman);
    }
    if (filter.search) {
      conditions.push(
        `(p.name ILIKE $${i} OR p.viloyat ILIKE $${i} OR p.tuman ILIKE $${i})`
      );
      values.push(`%${filter.search}%`);
      i++;
    }
    if (filter.dim_x_min !== undefined) {
      conditions.push(`p.dim_x >= $${i++}`); values.push(filter.dim_x_min);
    }
    if (filter.dim_x_max !== undefined) {
      conditions.push(`p.dim_x <= $${i++}`); values.push(filter.dim_x_max);
    }
    if (filter.dim_y_min !== undefined) {
      conditions.push(`p.dim_y >= $${i++}`); values.push(filter.dim_y_min);
    }
    if (filter.dim_y_max !== undefined) {
      conditions.push(`p.dim_y <= $${i++}`); values.push(filter.dim_y_max);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const { rows } = await query(
      `SELECT p.*,
              u.id        AS owner_uuid,
              u.name      AS owner_name,
              u.phone     AS owner_phone,
              u.telegram  AS owner_telegram,
              u.avatar    AS owner_avatar
       FROM products p
       LEFT JOIN users u ON u.id = p.owner_id
       ${where}
       ORDER BY p.created_at DESC`,
      values
    );
    return rows;
  },

  async findSimilarDims({ dim_x, dim_y, category, excludeId, tolerance = 20 }) {
    if (!dim_x && !dim_y) return [];
    const conditions = [`p.status = 'active'`];
    const values = [];
    let i = 1;

    if (category) {
      conditions.push(`p.category = $${i++}`);
      values.push(category);
    }
    if (excludeId) {
      conditions.push(`p.id != $${i++}`);
      values.push(excludeId);
    }
    if (dim_x) {
      conditions.push(`p.dim_x BETWEEN $${i} AND $${i+1}`);
      values.push(Number(dim_x) - tolerance, Number(dim_x) + tolerance);
      i += 2;
    }
    if (dim_y) {
      conditions.push(`p.dim_y BETWEEN $${i} AND $${i+1}`);
      values.push(Number(dim_y) - tolerance, Number(dim_y) + tolerance);
      i += 2;
    }

    const where = `WHERE ${conditions.join(" AND ")}`;
    const { rows } = await query(
      `SELECT p.*, u.name AS owner_name, u.phone AS owner_phone
       FROM products p
       LEFT JOIN users u ON u.id = p.owner_id
       ${where}
       ORDER BY p.created_at DESC
       LIMIT 10`,
      values
    );
    return rows;
  },

  async findById(id) {
    const { rows } = await query(
      `SELECT p.*, u.id AS owner_uuid, u.name AS owner_name, u.phone AS owner_phone, u.telegram AS owner_telegram
       FROM products p
       LEFT JOIN users u ON u.id = p.owner_id
       WHERE p.id = $1 LIMIT 1`,
      [id]
    );
    return rows[0] || null;
  },

  async findOne({ id, owner_id }) {
    const { rows } = await query(
      "SELECT * FROM products WHERE id = $1 AND owner_id = $2 LIMIT 1",
      [id, owner_id]
    );
    return rows[0] || null;
  },

  async create(data) {
    const { rows } = await query(
      `INSERT INTO products
         (name, category, price, price_1, price_10, price_100,
          unit, qty, condition, viloyat, tuman, photo, photos,
          dim_x, dim_y, dim_z, owner_id, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING *`,
      [
        data.name,
        data.category || "boshqa",
        data.price_1 || data.price || 0,
        data.price_1 || data.price || 0,
        data.price_10 || data.price || 0,
        data.price_100 || data.price || 0,
        data.unit || "dona",
        data.qty,
        data.condition || "A'lo",
        data.viloyat,
        data.tuman || "",
        data.photo || null,
        data.photos || null,
        data.dim_x || null,
        data.dim_y || null,
        data.dim_z || null,
        data.owner_id,
        data.status || "active",
      ]
    );
    return rows[0];
  },

  async update(id, owner_id, fields) {
    const sets = [];
    const values = [];
    let i = 1;
    const allowed = ["name","category","price","price_1","price_10","price_100",
                     "unit","qty","condition","viloyat","tuman","photo","photos",
                     "is_active","status","dim_x","dim_y","dim_z"];
    for (const [k, v] of Object.entries(fields)) {
      if (allowed.includes(k)) {
        sets.push(`${k} = $${i++}`);
        values.push(v);
      }
    }
    if (!sets.length) return null;
    sets.push(`updated_at = NOW()`);
    values.push(id, owner_id);
    const { rows } = await query(
      `UPDATE products SET ${sets.join(", ")} WHERE id = $${i++} AND owner_id = $${i} RETURNING *`,
      values
    );
    return rows[0] || null;
  },

  async setStatus(id, status, extra = {}) {
    const sets = [`status = $1`, `updated_at = NOW()`];
    const values = [status];
    let i = 2;

    if (extra.approved_by !== undefined) {
      sets.push(`approved_by = $${i++}`);
      values.push(extra.approved_by);
    }
    if (extra.rejected_reason !== undefined) {
      sets.push(`rejected_reason = $${i++}`);
      values.push(extra.rejected_reason);
    }
    const isActive = status === "active";
    sets.push(`is_active = $${i++}`);
    values.push(isActive);

    values.push(id);
    const { rows } = await query(
      `UPDATE products SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`,
      values
    );
    return rows[0] || null;
  },

  async setOwnerNull(owner_id) {
    await query(
      "UPDATE products SET owner_id = NULL, updated_at = NOW() WHERE owner_id = $1",
      [owner_id]
    );
  },
};

module.exports = Product;
