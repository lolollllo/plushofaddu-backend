const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const app = express();
const port = 3000;
const SECRET = 'supersecretkey';

app.use(cors());
app.use(bodyParser.json());

// Serve uploaded images statically
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}

// Multer setup for image uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    cb(null, file.fieldname + '-' + uniqueSuffix + ext);
  },
});
const upload = multer({ storage });

const db = new sqlite3.Database('./database.sqlite', (err) => {
  if (err) {
    console.error("DB connection error:", err);
  } else {
    console.log('Connected to SQLite database.');
  }
});

// Generate tracking ID: POA<8 chars uppercase alphanumeric>
function generateTrackingId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return 'POA' + code;
}

// Helper to validate Instagram or Phone required
function validateContact(instagram, phone) {
  return (instagram && instagram.trim() !== "") || (phone && phone.trim() !== "");
}

// Initialize database tables, including item_images
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      price REAL NOT NULL DEFAULT 0,
      image_url TEXT,
      status TEXT CHECK(status IN ('in-stock', 'pre-order')) NOT NULL,
      description TEXT,
      stock INTEGER DEFAULT 0
    )`);
  db.run(`
    CREATE TABLE IF NOT EXISTS item_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL,
      image_url TEXT NOT NULL,
      FOREIGN KEY(item_id) REFERENCES items(id)
    )`);
  db.run(`
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE,
      password TEXT
    )`);
  db.run(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_name TEXT NOT NULL,
      instagram TEXT,
      phone TEXT,
      delivery_method TEXT CHECK(delivery_method IN ('pickup', 'delivery')) NOT NULL,
      payment_method TEXT CHECK(payment_method IN ('transfer', 'cash')) NOT NULL,
      tracking_id TEXT UNIQUE NOT NULL,
      status TEXT DEFAULT 'waiting for updates',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);
  db.run(`
    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER,
      item_id INTEGER,
      quantity INTEGER,
      FOREIGN KEY(order_id) REFERENCES orders(id),
      FOREIGN KEY(item_id) REFERENCES items(id)
    )`);

  // Seed default admin user if not exists
  db.get("SELECT * FROM admins WHERE username = 'admin'", (err, row) => {
    if (err) {
      console.error("Admin lookup error:", err);
      return;
    }
    if (!row) {
      bcrypt.hash('adminpass', 10, (err, hash) => {
        if (err) {
          console.error("Admin password hash error:", err);
          return;
        }
        db.run("INSERT INTO admins (username, password) VALUES (?, ?)", ['admin', hash]);
      });
    }
  });
});

// Authentication middleware
function authenticate(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader) return res.status(403).json({ error: "No token" });

  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
  if (!token) return res.status(403).json({ error: "No token" });

  jwt.verify(token, SECRET, (err) => {
    if (err) return res.status(403).json({ error: "Token invalid" });
    next();
  });
}

// Public endpoint: Get items with preview image
app.get('/items', (req, res) => {
  db.all(
    `SELECT i.*, 
     (SELECT image_url FROM item_images WHERE item_id = i.id LIMIT 1) as preview_image_url
     FROM items i`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Public endpoint: Get single item with all image URLs
app.get('/items/:id', (req, res) => {
  const id = req.params.id;
  db.get("SELECT * FROM items WHERE id = ?", [id], (err, item) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!item) return res.status(404).json({ error: "Item not found" });

    db.all("SELECT image_url FROM item_images WHERE item_id = ?", [id], (err2, images) => {
      if (err2) return res.status(500).json({ error: err2.message });
      item.images = images.map(img => img.image_url);
      res.json(item);
    });
  });
});

// Public order placement endpoint (no auth)
app.post('/orders', (req, res) => {
  const { customer_name, instagram, phone, delivery_method, payment_method, orderItems } = req.body;

  if (!customer_name) {
    return res.status(400).json({ error: "Customer name is required" });
  }
  if (!validateContact(instagram, phone)) {
    return res.status(400).json({ error: "Please provide either Instagram username or Phone number" });
  }
  if (!orderItems || !Array.isArray(orderItems) || orderItems.length === 0) {
    return res.status(400).json({ error: "Order must have at least one item" });
  }

  const tracking_id = generateTrackingId();

  db.serialize(() => {
    db.run("BEGIN TRANSACTION");

    db.run(
      `INSERT INTO orders (
        customer_name, instagram, phone,
        delivery_method, payment_method, tracking_id, status
      ) VALUES (?, ?, ?, ?, ?, ?, 'waiting for updates')`,
      [customer_name, instagram || null, phone || null, delivery_method, payment_method, tracking_id],
      function (err) {
        if (err) {
          db.run("ROLLBACK");
          return res.status(500).json({ error: err.message });
        }

        const orderId = this.lastID;
        const stmt = db.prepare("INSERT INTO order_items (order_id, item_id, quantity) VALUES (?, ?, ?)");

        for (const oi of orderItems) {
          stmt.run(orderId, oi.item_id, oi.quantity, function (err) {
            if (err) {
              db.run("ROLLBACK");
              return res.status(500).json({ error: err.message });
            }
          });
        }

        stmt.finalize((err) => {
          if (err) {
            db.run("ROLLBACK");
            return res.status(500).json({ error: err.message });
          }

          // Commit after all inserts succeeded
          db.run("COMMIT", (commitErr) => {
            if (commitErr) return res.status(500).json({ error: commitErr.message });

            // Now fetch the order items with status included
            db.all(
              `SELECT i.name, i.status, i.price, oi.quantity
               FROM order_items oi
               JOIN items i ON oi.item_id = i.id
               WHERE oi.order_id = ?`,
              [orderId],
              (err, itemsWithNames) => {
                if (err) return res.status(500).json({ error: err.message });

                const totalPrice = itemsWithNames.reduce(
                  (sum, row) => sum + row.price * row.quantity,
                  0
                );

                const items = itemsWithNames.map(({ name, status, quantity }) => ({
                  name,
                  status,
                  quantity,
                }));

                res.json({
                  order_id: orderId,
                  tracking_id,
                  customer_name,
                  instagram,
                  phone,
                  delivery_method,
                  payment_method,
                  total_price: totalPrice.toFixed(2),
                  items,
                  message: "Your order has been confirmed!",
                });
              }
            );
          });
        });
      }
    );
  });
});

// Admin login
app.post('/admin/login', (req, res) => {
  const { username, password } = req.body;
  db.get("SELECT * FROM admins WHERE username = ?", [username], (err, user) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!user) return res.status(401).json({ error: "Invalid credentials" });

    bcrypt.compare(password, user.password, (err, valid) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!valid) return res.status(401).json({ error: "Invalid credentials" });

      const token = jwt.sign({ username: user.username }, SECRET, { expiresIn: '4h' });
      res.json({ token });
    });
  });
});

// Image upload route with sharp resize (single image)
app.post('/admin/items/upload-image', authenticate, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const imagePath = req.file.path;
  const resizedImagePath = path.join(uploadsDir, 'resized-' + req.file.filename);

  try {
    await sharp(imagePath)
      .resize(800, 800, {
        fit: 'inside',
        position: sharp.strategy.attention,
        withoutEnlargement: true,
      })
      .toFile(resizedImagePath);

    fs.unlinkSync(imagePath);
    fs.renameSync(resizedImagePath, imagePath);

    const imageUrl = `/uploads/${req.file.filename}`;
    res.json({ url: imageUrl });
  } catch (err) {
    console.error("Image processing error:", err);
    res.status(500).json({ error: "Failed to process image" });
  }
});

// Upload additional image for an item
app.post('/admin/items/:id/upload-image', authenticate, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const itemId = req.params.id;
  const imagePath = req.file.path;
  const resizedImagePath = path.join(uploadsDir, 'resized-' + req.file.filename);

  try {
    await sharp(imagePath)
      .resize(800, 800, {
        fit: 'inside',
        position: sharp.strategy.attention,
        withoutEnlargement: true,
      })
      .toFile(resizedImagePath);

    fs.unlinkSync(imagePath);
    fs.renameSync(resizedImagePath, imagePath);

    const imageUrl = `/uploads/${req.file.filename}`;

    db.run("INSERT INTO item_images (item_id, image_url) VALUES (?, ?)", [itemId, imageUrl], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ url: imageUrl });
    });
  } catch (err) {
    console.error("Image processing error:", err);
    res.status(500).json({ error: "Failed to process image" });
  }
});

// Add new item
app.post('/admin/items', authenticate, (req, res) => {
  const { name, price, image_url, status, description, stock } = req.body;

  if (!name || price === undefined || !status) {
    return res.status(400).json({ error: "Name, price and status are required" });
  }

  let priceNum = Number(price);
  if (isNaN(priceNum)) {
    return res.status(400).json({ error: "Price must be a number" });
  }
  priceNum = Math.round(priceNum * 100) / 100;
  let stockNum = Number(stock);
  if (isNaN(stockNum) || stockNum < 0) stockNum = 0;

  const finalStatus = stockNum === 0 ? "pre-order" : "in-stock";

  db.run(
    `INSERT INTO items (name, price, image_url, status, description, stock) VALUES (?, ?, ?, ?, ?, ?)`,
    [name, priceNum, image_url || null, finalStatus, description || "", stockNum],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, id: this.lastID });
    }
  );
});

// Get all orders (with item summaries)
app.get('/admin/orders', authenticate, (req, res) => {
  db.all(
    `SELECT * FROM orders ORDER BY created_at DESC`,
    [],
    (err, orders) => {
      if (err) return res.status(500).json({ error: err.message });

      if (!orders.length) return res.json([]);

      const orderIds = orders.map(o => o.id);

      db.all(
        `SELECT oi.order_id, i.name, i.status, oi.quantity
         FROM order_items oi
         JOIN items i ON oi.item_id = i.id
         WHERE oi.order_id IN (${orderIds.map(() => "?").join(",")})`,
        orderIds,
        (err, items) => {
          if (err) return res.status(500).json({ error: err.message });

          const itemsByOrder = {};
          for (const item of items) {
            if (!itemsByOrder[item.order_id]) itemsByOrder[item.order_id] = [];
            itemsByOrder[item.order_id].push({
              name: item.name,
              status: item.status,
              quantity: item.quantity,
            });
          }

          const ordersWithItems = orders.map(order => ({
            ...order,
            items: itemsByOrder[order.id] || [],
          }));

          res.json(ordersWithItems);
        }
      );
    }
  );
});

// Update order status by order id
app.post('/admin/orders/:id/status', authenticate, (req, res) => {
  const { status } = req.body;
  if (!status) return res.status(400).json({ error: "Status is required" });

  db.run("UPDATE orders SET status = ? WHERE id = ?", [status, req.params.id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes === 0) return res.status(404).json({ error: "Order not found" });
    res.json({ success: true });
  });
});

// Add new order with items (admin)
app.post('/admin/orders', authenticate, (req, res) => {
  const { customer_name, instagram, phone, delivery_method, payment_method, orderItems } = req.body;

  if (!customer_name) {
    return res.status(400).json({ error: "Customer name is required" });
  }
  if (!validateContact(instagram, phone)) {
    return res.status(400).json({ error: "Please provide either Instagram username or Phone number" });
  }
  if (!orderItems || !Array.isArray(orderItems) || orderItems.length === 0) {
    return res.status(400).json({ error: "Order must have at least one item" });
  }

  const tracking_id = generateTrackingId();

  db.serialize(() => {
    db.run("BEGIN TRANSACTION");

    db.run(
      `INSERT INTO orders (
        customer_name, instagram, phone,
        delivery_method, payment_method, tracking_id, status
      ) VALUES (?, ?, ?, ?, ?, ?, 'waiting for updates')`,
      [customer_name, instagram || null, phone || null, delivery_method, payment_method, tracking_id],
      function (err) {
        if (err) {
          db.run("ROLLBACK");
          return res.status(500).json({ error: err.message });
        }

        const orderId = this.lastID;
        const stmt = db.prepare("INSERT INTO order_items (order_id, item_id, quantity) VALUES (?, ?, ?)");

        for (const oi of orderItems) {
          stmt.run(orderId, oi.item_id, oi.quantity, function (err) {
            if (err) {
              db.run("ROLLBACK");
              return res.status(500).json({ error: err.message });
            }
          });
        }

        stmt.finalize((err) => {
          if (err) {
            db.run("ROLLBACK");
            return res.status(500).json({ error: err.message });
          }

          db.run("COMMIT", (commitErr) => {
            if (commitErr) return res.status(500).json({ error: commitErr.message });

            db.all(
              `SELECT i.name, i.status, i.price, oi.quantity
               FROM order_items oi
               JOIN items i ON oi.item_id = i.id
               WHERE oi.order_id = ?`,
              [orderId],
              (err, itemsWithNames) => {
                if (err) return res.status(500).json({ error: err.message });

                const totalPrice = itemsWithNames.reduce(
                  (sum, row) => sum + row.price * row.quantity,
                  0
                );

                const items = itemsWithNames.map(({ name, status, quantity }) => ({
                  name,
                  status,
                  quantity,
                }));

                res.json({
                  order_id: orderId,
                  tracking_id,
                  customer_name,
                  instagram,
                  phone,
                  delivery_method,
                  payment_method,
                  total_price: totalPrice.toFixed(2),
                  items,
                  message: "Order created successfully",
                });
              }
            );
          });
        });
      }
    );
  });
});

// DELETE an order by ID (admin only)
app.delete('/admin/orders/:id', authenticate, (req, res) => {
  const orderId = req.params.id;

  db.run(
    "DELETE FROM order_items WHERE order_id = ?",
    [orderId],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });

      db.run(
        "DELETE FROM orders WHERE id = ?",
        [orderId],
        function (err) {
          if (err) return res.status(500).json({ error: err.message });
          if (this.changes === 0) return res.status(404).json({ error: "Order not found" });
          res.json({ success: true, message: "Order deleted" });
        }
      );
    }
  );
});

// Track order by tracking id
app.get('/track/:trackingId', (req, res) => {
  db.get("SELECT * FROM orders WHERE tracking_id = ?", [req.params.trackingId], (err, order) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!order) return res.json({ found: false });

    db.all(
      `SELECT items.name, order_items.quantity
       FROM order_items
       JOIN items ON order_items.item_id = items.id
       WHERE order_items.order_id = ?`,
      [order.id],
      (err, items) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ found: true, order, items });
      }
    );
  });
});

app.put('/admin/items/:id', authenticate, (req, res) => {
  const { id } = req.params;
  const { name, price, image_url, description, stock } = req.body;

  if (!name || price === undefined) {
    return res.status(400).json({ error: "Name and price are required" });
  }

  if (!/^\d+$/.test(id)) {
    return res.status(400).json({ error: "Invalid item ID" });
  }

  let priceNum = Number(price);
  if (isNaN(priceNum)) {
    return res.status(400).json({ error: "Price must be a number" });
  }
  priceNum = Math.round(priceNum * 100) / 100;
  let stockNum = Number(stock);
  if (isNaN(stockNum) || stockNum < 0) stockNum = 0;

  // Auto set status based on stock
  const finalStatus = stockNum === 0 ? "pre-order" : "in-stock";

  db.run(
    `UPDATE items SET name=?, price=?, image_url=?, description=?, stock=?, status=? WHERE id=?`,
    [name, priceNum, image_url || null, description || "", stockNum, finalStatus, id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      if (this.changes === 0) return res.status(404).json({ error: "Item not found" });
      res.json({ success: true });
    }
  );
});

// Serve React build for non-API requests
app.use(express.static(path.join(__dirname, 'build')));
app.get('*', (req, res) => {
  res.sendFile(path.resolve(__dirname, 'build', 'index.html'));
});

app.listen(port, () => {
  console.log(`Backend running on http://localhost:${port}`);
});
