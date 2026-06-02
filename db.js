const { Pool } = require("pg");

let pool;
let _tablesReady = null;

function getPool() {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL .env da topilmadi");

    const cleanUrl = url.replace(/[&?]channel_binding=[^&]*/g, "");

    pool = new Pool({
      connectionString: cleanUrl,
      ssl: { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
  }
  return pool;
}

function ensureTables() {
  if (!_tablesReady) {
    _tablesReady = initTables(getPool()).catch((err) => {
      _tablesReady = null;
      throw err;
    });
  }
  return _tablesReady;
}

async function connect() {
  await ensureTables();
  return getPool();
}

async function query(text, params) {
  await ensureTables();
  return getPool().query(text, params);
}

async function checkAndResetSchema(p) {
  try {
    await p.query("SELECT phone FROM users LIMIT 1");
  } catch (e) {
    if (e.code === "42703" || e.code === "42P01" || e.message.includes("does not exist")) {
      console.log("⚠️  Eski sxema. Yangidan yaratilmoqda...");
      const drops = [
        "DROP TABLE IF EXISTS payment_locks CASCADE",
        "DROP TABLE IF EXISTS tg_tokens     CASCADE",
        "DROP TABLE IF EXISTS payments      CASCADE",
        "DROP TABLE IF EXISTS offers        CASCADE",
        "DROP TABLE IF EXISTS products      CASCADE",
        "DROP TABLE IF EXISTS users         CASCADE",
      ];
      for (const sql of drops) {
        await p.query(sql).catch(() => {});
      }
      console.log("🗑  Eski jadvallar o'chirildi.");
    }
  }
}

async function initTables(p) {
  const run = (sql) => p.query(sql);

  await checkAndResetSchema(p);

  await run(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp";`).catch(() => {});

  // 2. Users
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
      name        VARCHAR(255) NOT NULL DEFAULT '',
      phone       VARCHAR(50)  UNIQUE NOT NULL DEFAULT '',
      telegram    VARCHAR(255) DEFAULT '',
      avatar      TEXT,
      balance     NUMERIC      NOT NULL DEFAULT 0,
      tg_chat_id  BIGINT,
      is_blocked  BOOLEAN      DEFAULT FALSE,
      role        VARCHAR(50)  DEFAULT 'user',
      joined      TIMESTAMPTZ  DEFAULT NOW(),
      created_at  TIMESTAMPTZ  DEFAULT NOW(),
      updated_at  TIMESTAMPTZ  DEFAULT NOW()
    );
  `);

  const userCols = [
    [`tg_chat_id`,  `BIGINT`],
    [`is_blocked`,  `BOOLEAN DEFAULT FALSE`],
    [`role`,        `VARCHAR(50) DEFAULT 'user'`],
    [`balance`,     `NUMERIC NOT NULL DEFAULT 0`],
    [`updated_at`,  `TIMESTAMPTZ DEFAULT NOW()`],
    [`avatar`,      `TEXT`],
    [`telegram`,    `VARCHAR(255) DEFAULT ''`],
  ];
  for (const [col, def] of userCols) {
    await run(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name='users' AND column_name='${col}'
        ) THEN ALTER TABLE users ADD COLUMN ${col} ${def}; END IF;
      END $$;
    `).catch(() => {});
  }

  // 3. Products (x,y,z o'lchamlar va narx darajalari bilan)
  await run(`
    CREATE TABLE IF NOT EXISTS products (
      id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
      name            VARCHAR(255) NOT NULL DEFAULT '',
      category        VARCHAR(50)  NOT NULL DEFAULT 'boshqa',
      price           NUMERIC      NOT NULL DEFAULT 0,
      price_1         NUMERIC      DEFAULT 0,
      price_10        NUMERIC      DEFAULT 0,
      price_100       NUMERIC      DEFAULT 0,
      unit            VARCHAR(50)  NOT NULL DEFAULT 'dona',
      qty             INTEGER      NOT NULL DEFAULT 1,
      condition       VARCHAR(50)  DEFAULT 'A''lo',
      viloyat         VARCHAR(255) NOT NULL DEFAULT '',
      tuman           VARCHAR(255) DEFAULT '',
      photo           TEXT,
      photos          TEXT,
      dim_x           NUMERIC      DEFAULT NULL,
      dim_y           NUMERIC      DEFAULT NULL,
      dim_z           NUMERIC      DEFAULT NULL,
      owner_id        UUID,
      status          VARCHAR(30)  DEFAULT 'active',
      approved_by     UUID,
      rejected_reason TEXT,
      is_active       BOOLEAN      DEFAULT TRUE,
      created_at      TIMESTAMPTZ  DEFAULT NOW(),
      updated_at      TIMESTAMPTZ  DEFAULT NOW()
    );
  `);

  await run(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name='products' AND constraint_name='products_owner_id_fkey'
      ) THEN
        ALTER TABLE products
          ADD CONSTRAINT products_owner_id_fkey
          FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL;
      END IF;
    END $$;
  `).catch(() => {});

  // Products: yangi ustunlarni qo'shish (eski DB uchun migration)
  const prodCols = [
    [`photos`,          `TEXT`],
    [`status`,          `VARCHAR(30) DEFAULT 'active'`],
    [`approved_by`,     `UUID`],
    [`rejected_reason`, `TEXT`],
    [`updated_at`,      `TIMESTAMPTZ DEFAULT NOW()`],
    [`price_1`,         `NUMERIC DEFAULT 0`],
    [`price_10`,        `NUMERIC DEFAULT 0`],
    [`price_100`,       `NUMERIC DEFAULT 0`],
    [`dim_x`,           `NUMERIC DEFAULT NULL`],
    [`dim_y`,           `NUMERIC DEFAULT NULL`],
    [`dim_z`,           `NUMERIC DEFAULT NULL`],
  ];
  for (const [col, def] of prodCols) {
    await run(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name='products' AND column_name='${col}'
        ) THEN ALTER TABLE products ADD COLUMN ${col} ${def}; END IF;
      END $$;
    `).catch(() => {});
  }

  await run(`
    DO $$ BEGIN
      ALTER TABLE products ALTER COLUMN owner_id DROP NOT NULL;
    EXCEPTION WHEN others THEN NULL;
    END $$;
  `).catch(() => {});

  // 4. Offers
  await run(`
    CREATE TABLE IF NOT EXISTS offers (
      id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      product_id  UUID,
      buyer_id    UUID        NOT NULL,
      seller_id   UUID,
      status      VARCHAR(50) DEFAULT 'pending',
      message     TEXT        DEFAULT '',
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  const offerFKs = [
    [`offers_product_id_fkey`, `product_id`, `products(id)`, `ON DELETE SET NULL`],
    [`offers_buyer_id_fkey`,   `buyer_id`,   `users(id)`,    ``],
    [`offers_seller_id_fkey`,  `seller_id`,  `users(id)`,    `ON DELETE SET NULL`],
  ];
  for (const [name, col, ref, extra] of offerFKs) {
    await run(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_name='offers' AND constraint_name='${name}'
        ) THEN
          ALTER TABLE offers ADD CONSTRAINT ${name}
            FOREIGN KEY (${col}) REFERENCES ${ref} ${extra};
        END IF;
      END $$;
    `).catch(() => {});
  }

  // 5. Payment_locks
  await run(`
    CREATE TABLE IF NOT EXISTS payment_locks (
      offer_id  VARCHAR(100) PRIMARY KEY,
      locked_at TIMESTAMPTZ  DEFAULT NOW()
    );
  `);

  // 6. Telegram tokens
  await run(`
    CREATE TABLE IF NOT EXISTS tg_tokens (
      token      VARCHAR(20)  PRIMARY KEY,
      user_id    UUID         NOT NULL,
      expires_at TIMESTAMPTZ  NOT NULL,
      created_at TIMESTAMPTZ  DEFAULT NOW()
    );
  `);

  await run(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name='tg_tokens' AND constraint_name='tg_tokens_user_id_fkey'
      ) THEN
        ALTER TABLE tg_tokens ADD CONSTRAINT tg_tokens_user_id_fkey
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
      END IF;
    END $$;
  `).catch(() => {});

  // 7. Indexes
  const indexes = [
    `CREATE INDEX IF NOT EXISTS idx_products_status   ON products (status, created_at DESC);`,
    `CREATE INDEX IF NOT EXISTS idx_products_owner    ON products (owner_id);`,
    `CREATE INDEX IF NOT EXISTS idx_products_category ON products (category);`,
    `CREATE INDEX IF NOT EXISTS idx_products_dims     ON products (dim_x, dim_y, dim_z);`,
    `CREATE INDEX IF NOT EXISTS idx_offers_buyer      ON offers (buyer_id);`,
    `CREATE INDEX IF NOT EXISTS idx_offers_seller     ON offers (seller_id);`,
    `CREATE INDEX IF NOT EXISTS idx_users_tg          ON users (tg_chat_id);`,
    `CREATE INDEX IF NOT EXISTS idx_users_phone       ON users (phone);`,
  ];
  for (const idx of indexes) {
    await run(idx).catch(() => {});
  }

  console.log("✅ Database jadvallari tayyor");
}

module.exports = { connect, query };
