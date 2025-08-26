const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const bodyParser = require('body-parser');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { createClient } = require('@libsql/client');

const app = express();
const port = 3000;
const SECRET = 'supersecretkey';

// Initialize Turso libSQL client
const client = createClient({
  url: "libsql://plushofaddu-plushofaddu.aws-ap-south-1.turso.io",
  authToken: "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3NTYxOTk0MDksImlkIjoiOWUxYzc0M2ItMmI3NC00NjIxLTljZDgtZDgxNjM2MjYzMDVkIiwicmlkIjoiNjRhNTRiNzUtZDQ5Mi00Y2RjLThmMmEtMGRiMjU5ZjZmYWQ0In0.fM2PjR6QWk7VdewTvMDq0kT3ScyqM4CAaKYRdwpIOysU1VprijKX7NHlajMRyDG7ixfpiZAIRO3tYzYmKpaaBQ",
});

app.use(cors());
app.use(bodyParser.json());

// Serve uploaded images statically
const uploadsDir = path.join(__dirname, 'uploads');
app.use('/uploads', express.static(uploadsDir));
// Ensure uploads directory exists
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
const multiUpload = multer({ storage }).array('images', 5);

// Helper: Convert libSQL result to array of objects
function mapRowsToObjects(result) {
  return result.rows.map(row =>
    row.reduce((obj, value, idx) => {
      obj[result.columns[idx].name] = value;
      return obj;
    }, {})
  );
}

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
  return (instagram && instagram.trim() !== '') || (phone && phone.trim() !== '');
}

// Initialize database tables, including item_images
async function initTables() {
  const createTableQueries = [
    `CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      price REAL NOT NULL DEFAULT 0,
      image_url TEXT,
      status TEXT CHECK(status IN ('in-stock', 'pre-order')) NOT NULL,
      description TEXT,
      stock INTEGER DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS item_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL,
      image_url TEXT NOT NULL,
      FOREIGN KEY(item_id) REFERENCES items(id)
    )`,
    `CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE,
      password TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_name TEXT NOT NULL,
      instagram TEXT,
      phone TEXT,
      delivery_method TEXT CHECK(delivery_method IN ('pickup', 'delivery')) NOT NULL,
      payment_method TEXT CHECK(payment_method IN ('transfer', 'cash')) NOT NULL,
      delivery_charge REAL DEFAULT 0,
      tracking_id TEXT UNIQUE NOT NULL,
      status TEXT DEFAULT 'waiting for updates',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER,
      item_id INTEGER,
      quantity INTEGER,
      FOREIGN KEY(order_id) REFERENCES orders(id),
      FOREIGN KEY(item_id) REFERENCES items(id)
    )`,
  ];
  for (const sql of createTableQueries) {
    await client.execute(sql);
  }
}

// Migrate image URLs from items to item_images
async function migrateImagesToItemImages() {
  const res = await client.execute(
    "SELECT id, image_url FROM items WHERE image_url IS NOT NULL AND image_url != ''"
  );
  const rows = mapRowsToObjects(res);
  if (rows.length === 0) {
    console.log('Migration skipped: No image_url entries found in items.');
    return;
  }
  for (const { id, image_url } of rows) {
    await client.execute(
      "INSERT OR IGNORE INTO item_images(item_id, image_url) VALUES (?, ?)",
      [id, image_url]
    );
  }
  console.log('Migration complete: item_images populated from items.image_url');
}

// Seed default admin user if not exists
async function seedAdmin() {
  const res = await client.execute("SELECT * FROM admins WHERE username = ?", ['admin']);
  const admins = mapRowsToObjects(res);
  if (admins.length === 0) {
    const hash = await bcrypt.hash('adminpass', 10);
    await client.execute("INSERT INTO admins (username, password) VALUES (?, ?)", ['admin', hash]);
  }
}

// Init tables, migrate data, seed admin on startup
(async () => {
  try {
    await initTables();
    await migrateImagesToItemImages();
    await seedAdmin();
    console.log('Database initialized.');
  } catch (err) {
    console.error('DB initialization error:', err);
  }
})();

// Authentication middleware
function authenticate(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader) return res.status(403).json({ error: 'No token' });
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
  if (!token) return res.status(403).json({ error: 'No token' });
  jwt.verify(token, SECRET, (err) => {
    if (err) return res.status(403).json({ error: 'Token invalid' });
    next();
  });
}

// Public endpoint: Get items with preview image (first from item_images)
app.get('/items', async (req, res) => {
  try {
    const result = await client.execute(`
      SELECT i.*, 
        (SELECT image_url FROM item_images WHERE item_id = i.id LIMIT 1) as preview_image_url
      FROM items i
    `);
    const rows = mapRowsToObjects(result);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Public endpoint: Get single item with all images
app.get('/items/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const itemRes = await client.execute("SELECT * FROM items WHERE id = ?", [id]);
    const items = mapRowsToObjects(itemRes);
    if (items.length === 0) return res.status(404).json({ error: "Item not found" });
    const item = items[0];
    const imagesRes = await client.execute("SELECT image_url FROM item_images WHERE item_id = ?", [id]);
    item.images = mapRowsToObjects(imagesRes).map(img => img.image_url);
    res.json(item);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Public order placement endpoint (no auth)
app.post('/orders', async (req, res) => {
  const { customer_name, instagram, phone, delivery_method, payment_method, orderItems, delivery_charge } = req.body;
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
  try {
    await client.execute("BEGIN TRANSACTION");
    const orderInsert = await client.execute(
      `INSERT INTO orders (
        customer_name, instagram, phone, delivery_method, payment_method, delivery_charge, tracking_id, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting for updates')`,
      [customer_name, instagram || null, phone || null, delivery_method, payment_method, delivery_charge || 0, tracking_id]
    );
    const orderId = orderInsert.lastInsertRowid || orderInsert.lastRowId;
    for (const oi of orderItems) {
      await client.execute(
        "INSERT INTO order_items (order_id, item_id, quantity) VALUES (?, ?, ?)",
        [orderId, oi.item_id, oi.quantity]
      );
    }
    await client.execute("COMMIT");
    const itemsWithNamesRes = await client.execute(
      `SELECT i.name, i.status, i.price, oi.quantity
      FROM order_items oi
      JOIN items i ON oi.item_id = i.id
      WHERE oi.order_id = ?`,
      [orderId]
    );
    const itemsWithNames = mapRowsToObjects(itemsWithNamesRes);
    const totalPrice = itemsWithNames.reduce((sum, row) => sum + row.price * row.quantity, 0);
    const totalPriceWithDelivery = totalPrice + (delivery_charge || 0);
    const items = itemsWithNames.map(({ name, status, quantity }) => ({ name, status, quantity }));
    res.json({
      order_id: orderId,
      tracking_id,
      customer_name,
      instagram,
      phone,
      delivery_method,
      payment_method,
      delivery_charge: delivery_charge || 0,
      total_price: totalPriceWithDelivery.toFixed(2),
      items,
      message: "Your order has been confirmed!",
    });
  } catch (err) {
    await client.execute("ROLLBACK");
    res.status(500).json({ error: err.message });
  }
});

// Admin login
app.post('/admin/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const usersRes = await client.execute("SELECT * FROM admins WHERE username = ?", [username]);
    const users = mapRowsToObjects(usersRes);
    if (users.length === 0) return res.status(401).json({ error: "Invalid credentials" });
    const user = users[0];
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: "Invalid credentials" });
    const token = jwt.sign({ username: user.username }, SECRET, { expiresIn: '4h' });
    res.json({ token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Image upload, multi-upload, item image upload routes remain mostly unchanged but db.run replaced with async client.execute

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

app.post('/admin/items/upload-images', authenticate, (req, res) => {
  multiUpload(req, res, function (err) {
    if (err) {
      return res.status(500).json({ error: err.message || 'Upload failed' });
    }
    if (!req.files || req.files.length === 0) {
      return res.json({ urls: [] });
    }
    const imageUrls = req.files.map(file => `/uploads/${file.filename}`);
    res.json({ urls: imageUrls });
  });
});

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
    await client.execute("INSERT INTO item_images (item_id, image_url) VALUES (?, ?)", [itemId, imageUrl]);
    res.json({ url: imageUrl });
  } catch (err) {
    console.error("Image processing error:", err);
    res.status(500).json({ error: "Failed to process image" });
  }
});

// Add new item
app.post('/admin/items', authenticate, async (req, res) => {
  const { name, price, image_url, status, description, stock, images = [] } = req.body;
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
  try {
    const insertRes = await client.execute(
      "INSERT INTO items (name, price, image_url, status, description, stock) VALUES (?, ?, ?, ?, ?, ?)",
      [name, priceNum, image_url || null, finalStatus, description || "", stockNum]
    );
    const itemId = insertRes.lastInsertRowid || insertRes.lastRowId;
    for (const url of images) {
      await client.execute("INSERT INTO item_images(item_id, image_url) VALUES (?, ?)", [itemId, url]);
    }
    res.json({ success: true, id: itemId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all orders with item summaries
app.get('/admin/orders', authenticate, async (req, res) => {
  try {
    const ordersRes = await client.execute("SELECT * FROM orders ORDER BY created_at DESC");
    const orders = mapRowsToObjects(ordersRes);
    if (orders.length === 0) return res.json([]);
    const orderIds = orders.map(o => o.id);
    const placeholders = orderIds.map(() => "?").join(",");
    const itemsRes = await client.execute(
      `SELECT oi.order_id, i.name, i.status, oi.quantity
       FROM order_items oi
       JOIN items i ON oi.item_id = i.id
       WHERE oi.order_id IN (${placeholders})`,
      orderIds
    );
    const items = mapRowsToObjects(itemsRes);
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update order status by order id
app.post('/admin/orders/:id/status', authenticate, async (req, res) => {
  const { status } = req.body;
  const id = req.params.id;
  if (!status) return res.status(400).json({ error: "Status is required" });
  try {
    const updateRes = await client.execute("UPDATE orders SET status = ? WHERE id = ?", [status, id]);
    if (updateRes.rowsAffected === 0) return res.status(404).json({ error: "Order not found" });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add new order with items (admin)
app.post('/admin/orders', authenticate, async (req, res) => {
  const { customer_name, instagram, phone, delivery_method, payment_method, orderItems, delivery_charge } = req.body;
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
  try {
    await client.execute("BEGIN TRANSACTION");
    const insertOrder = await client.execute(
      `INSERT INTO orders (
        customer_name, instagram, phone,
        delivery_method, payment_method, tracking_id, status
      ) VALUES (?, ?, ?, ?, ?, ?, 'waiting for updates')`,
      [customer_name, instagram || null, phone || null, delivery_method, payment_method, tracking_id]
    );
    const orderId = insertOrder.lastInsertRowid || insertOrder.lastRowId;
    for (const oi of orderItems) {
      await client.execute("INSERT INTO order_items (order_id, item_id, quantity) VALUES (?, ?, ?)", [orderId, oi.item_id, oi.quantity]);
    }
    await client.execute("COMMIT");
    const itemsRes = await client.execute(
      `SELECT i.name, i.status, i.price, oi.quantity
       FROM order_items oi
       JOIN items i ON oi.item_id = i.id
       WHERE oi.order_id = ?`,
      [orderId]
    );
    const itemsWithNames = mapRowsToObjects(itemsRes);
    const totalPrice = itemsWithNames.reduce((sum, row) => sum + row.price * row.quantity, 0);
    const totalPriceWithDelivery = totalPrice + (delivery_charge || 0);
    const items = itemsWithNames.map(({ name, status, quantity }) => ({ name, status, quantity }));
    res.json({
      order_id: orderId,
      tracking_id,
      customer_name,
      instagram,
      phone,
      delivery_method,
      payment_method,
      delivery_charge: delivery_charge || 0,
      total_price: totalPriceWithDelivery.toFixed(2),
      items,
      message: "Order created successfully",
    });
  } catch (err) {
    await client.execute("ROLLBACK");
    res.status(500).json({ error: err.message });
  }
});

// DELETE an order by ID (admin only)
app.delete('/admin/orders/:id', authenticate, async (req, res) => {
  const orderId = req.params.id;
  try {
    await client.execute("DELETE FROM order_items WHERE order_id = ?", [orderId]);
    const deleteOrderRes = await client.execute("DELETE FROM orders WHERE id = ?", [orderId]);
    if (deleteOrderRes.rowsAffected === 0) return res.status(404).json({ error: "Order not found" });
    res.json({ success: true, message: "Order deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Track order by tracking id
app.get('/track/:trackingId', async (req, res) => {
  try {
    const orderRes = await client.execute("SELECT * FROM orders WHERE tracking_id = ?", [req.params.trackingId]);
    const orders = mapRowsToObjects(orderRes);
    if (orders.length === 0) return res.json({ found: false });
    const order = orders[0];
    const itemsRes = await client.execute(`
      SELECT items.name, order_items.quantity
      FROM order_items
      JOIN items ON order_items.item_id = items.id
      WHERE order_items.order_id = ?
    `, [order.id]);
    const items = mapRowsToObjects(itemsRes);
    res.json({ found: true, order, items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update an item
app.put('/admin/items/:id', authenticate, async (req, res) => {
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
  const finalStatus = stockNum === 0 ? "pre-order" : "in-stock";
  try {
    const updateRes = await client.execute(
      "UPDATE items SET name=?, price=?, image_url=?, description=?, stock=?, status=? WHERE id=?",
      [name, priceNum, image_url || null, description || "", stockNum, finalStatus, id]
    );
    if (updateRes.rowsAffected === 0) return res.status(404).json({ error: "Item not found" });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve React build for non-API requests
app.use(express.static(path.join(__dirname, 'build')));
app.get('*', (req, res) => {
  res.sendFile(path.resolve(__dirname, 'build', 'index.html'));
});

app.listen(port, () => {
  console.log(`Backend running on http://localhost:${port}`);
});

