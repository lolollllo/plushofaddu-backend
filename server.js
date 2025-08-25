const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2');
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
const multiUpload = multer({ storage }).array("images", 5);

// MySQL database pool setup
const db = mysql.createPool({
  host: 'sql101.infinityfree.com',
  user: 'if0_39504987',
  password: '4luwcqcuoJdMe',
  database: 'if0_39504987_XXX', // Replace XXX with your actual database name
  port: 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// Helper to execute queries with promise
function query(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.query(sql, params, (err, results) => {
      if (err) reject(err);
      else resolve(results);
    });
  });
}

async function migrateImagesToItemImages() {
  try {
    const rows = await query("SELECT id, image_url FROM items WHERE image_url IS NOT NULL AND image_url != ''");
    if (rows.length === 0) {
      console.log('Migration skipped: No image_url entries found in items.');
      return;
    }
    for (const { id, image_url } of rows) {
      await query("INSERT IGNORE INTO item_images(item_id, image_url) VALUES (?, ?)", [id, image_url]);
    }
    console.log('Migration complete: item_images populated from items.image_url');
  } catch (err) {
    console.error('Error during migration:', err);
  }
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
  return (instagram && instagram.trim() !== "") || (phone && phone.trim() !== "");
}

// Initialize database tables adapted for MySQL
async function initializeTables() {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS items (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        price DECIMAL(10,2) NOT NULL DEFAULT 0,
        image_url VARCHAR(255),
        status ENUM('in-stock', 'pre-order') NOT NULL,
        description TEXT,
        stock INT DEFAULT 0
      )
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS item_images (
        id INT AUTO_INCREMENT PRIMARY KEY,
        item_id INT NOT NULL,
        image_url VARCHAR(255) NOT NULL,
        FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE
      )
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS admins (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(255) UNIQUE,
        password VARCHAR(255)
      )
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS orders (
        id INT AUTO_INCREMENT PRIMARY KEY,
        customer_name VARCHAR(255) NOT NULL,
        instagram VARCHAR(255),
        phone VARCHAR(255),
        delivery_method ENUM('pickup', 'delivery') NOT NULL,
        payment_method ENUM('transfer', 'cash') NOT NULL,
        delivery_charge DECIMAL(10,2) DEFAULT 0,
        tracking_id VARCHAR(255) UNIQUE NOT NULL,
        status VARCHAR(255) DEFAULT 'waiting for updates',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS order_items (
        id INT AUTO_INCREMENT PRIMARY KEY,
        order_id INT,
        item_id INT,
        quantity INT,
        FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE,
        FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE
      )
    `);

    await migrateImagesToItemImages();

    // Seed default admin user if not exists
    const admins = await query("SELECT * FROM admins WHERE username = 'admin'");
    if (admins.length === 0) {
      const hash = await bcrypt.hash('adminpass', 10);
      await query("INSERT INTO admins (username, password) VALUES (?, ?)", ['admin', hash]);
    }
  } catch (err) {
    console.error("Initialization error:", err);
  }
}

initializeTables();

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

// Public endpoint: Get items with preview image (first from item_images)
app.get('/items', async (req, res) => {
  try {
    const rows = await query(`
      SELECT i.*, 
        (SELECT image_url FROM item_images WHERE item_id = i.id LIMIT 1) as preview_image_url
      FROM items i
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Public endpoint: Get single item with all images
app.get('/items/:id', async (req, res) => {
  const id = req.params.id;
  try {
    const items = await query("SELECT * FROM items WHERE id = ?", [id]);
    if (items.length === 0) return res.status(404).json({ error: "Item not found" });
    const item = items[0];

    const images = await query("SELECT image_url FROM item_images WHERE item_id = ?", [id]);
    item.images = images.map(img => img.image_url);
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
    await query("START TRANSACTION");

    const result = await query(
      `INSERT INTO orders (
        customer_name, instagram, phone,
        delivery_method, payment_method, delivery_charge, tracking_id, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting for updates')`,
      [customer_name, instagram || null, phone || null, delivery_method, payment_method, delivery_charge || 0, tracking_id]
    );

    const orderId = result.insertId;

    const insertOrderItemPromises = orderItems.map(oi =>
      query("INSERT INTO order_items (order_id, item_id, quantity) VALUES (?, ?, ?)", [orderId, oi.item_id, oi.quantity])
    );

    await Promise.all(insertOrderItemPromises);

    await query("COMMIT");

    const itemsWithNames = await query(
      `SELECT i.name, i.status, i.price, oi.quantity
       FROM order_items oi
       JOIN items i ON oi.item_id = i.id
       WHERE oi.order_id = ?`,
      [orderId]
    );

    const totalPrice = itemsWithNames.reduce((sum, row) => sum + row.price * row.quantity, 0);
    const totalPriceWithDelivery = totalPrice + (delivery_charge || 0);

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
      delivery_charge: delivery_charge || 0,
      total_price: totalPriceWithDelivery.toFixed(2),
      items,
      message: "Your order has been confirmed!",
    });
  } catch (err) {
    await query("ROLLBACK");
    res.status(500).json({ error: err.message });
  }
});

// Admin login
app.post('/admin/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const users = await query("SELECT * FROM admins WHERE username = ?", [username]);
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

// Multiple images upload endpoint - no required files, returns empty array if none uploaded
app.post('/admin/items/upload-images', authenticate, (req, res) => {
  multiUpload(req, res, function (err) {
    if (err) {
      return res.status(500).json({ error: err.message || 'Upload failed' });
    }

    if (!req.files || req.files.length === 0) {
      // No files uploaded is OK, just return empty array
      return res.json({ urls: [] });
    }

    const imageUrls = req.files.map(file => `/uploads/${file.filename}`);
    res.json({ urls: imageUrls });
  });
});

// Upload additional image for an item (store in item_images)
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

    await query("INSERT INTO item_images (item_id, image_url) VALUES (?, ?)", [itemId, imageUrl]);
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
    const result = await query(
      `INSERT INTO items (name, price, image_url, status, description, stock) VALUES (?, ?, ?, ?, ?, ?)`,
      [name, priceNum, image_url || null, finalStatus, description || "", stockNum]
    );

    const itemId = result.insertId;

    if (images.length > 0) {
      const insertImagePromises = images.map(url =>
        query("INSERT INTO item_images(item_id, image_url) VALUES (?, ?)", [itemId, url])
      );
      await Promise.all(insertImagePromises);
    }

    res.json({ success: true, id: itemId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all orders (with item summaries)
app.get('/admin/orders', authenticate, async (req, res) => {
  try {
    const orders = await query(
      `SELECT * FROM orders ORDER BY created_at DESC`
    );

    if (orders.length === 0) return res.json([]);

    const orderIds = orders.map(o => o.id);
    const placeholders = orderIds.map(() => '?').join(',');

    const items = await query(
      `SELECT oi.order_id, i.name, i.status, oi.quantity
       FROM order_items oi
       JOIN items i ON oi.item_id = i.id
       WHERE oi.order_id IN (${placeholders})`,
      orderIds
    );

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
  if (!status) return res.status(400).json({ error: "Status is required" });

  try {
    const result = await query("UPDATE orders SET status = ? WHERE id = ?", [status, req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: "Order not found" });
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
    await query("START TRANSACTION");

    const result = await query(
      `INSERT INTO orders (
        customer_name, instagram, phone,
        delivery_method, payment_method, tracking_id, status
      ) VALUES (?, ?, ?, ?, ?, ?, 'waiting for updates')`,
      [customer_name, instagram || null, phone || null, delivery_method, payment_method, tracking_id]
    );

    const orderId = result.insertId;

    const insertOrderItemPromises = orderItems.map(oi =>
      query("INSERT INTO order_items (order_id, item_id, quantity) VALUES (?, ?, ?)", [orderId, oi.item_id, oi.quantity])
    );

    await Promise.all(insertOrderItemPromises);

    await query("COMMIT");

    const itemsWithNames = await query(
      `SELECT i.name, i.status, i.price, oi.quantity
       FROM order_items oi
       JOIN items i ON oi.item_id = i.id
       WHERE oi.order_id = ?`,
      [orderId]
    );

    const totalPrice = itemsWithNames.reduce((sum, row) => sum + row.price * row.quantity, 0);
    const totalPriceWithDelivery = totalPrice + (delivery_charge || 0);

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
      delivery_charge: delivery_charge || 0,
      total_price: totalPriceWithDelivery.toFixed(2),
      items,
      message: "Order created successfully",
    });
  } catch (err) {
    await query("ROLLBACK");
    res.status(500).json({ error: err.message });
  }
});

// DELETE an order by ID (admin only)
app.delete('/admin/orders/:id', authenticate, async (req, res) => {
  const orderId = req.params.id;

  try {
    await query("DELETE FROM order_items WHERE order_id = ?", [orderId]);
    const result = await query("DELETE FROM orders WHERE id = ?", [orderId]);
    if (result.affectedRows === 0) return res.status(404).json({ error: "Order not found" });
    res.json({ success: true, message: "Order deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Track order by tracking id
app.get('/track/:trackingId', async (req, res) => {
  try {
    const orders = await query("SELECT * FROM orders WHERE tracking_id = ?", [req.params.trackingId]);
    if (orders.length === 0) return res.json({ found: false });

    const order = orders[0];

    const items = await query(
      `SELECT items.name, order_items.quantity
       FROM order_items
       JOIN items ON order_items.item_id = items.id
       WHERE order_items.order_id = ?`,
      [order.id]
    );

    res.json({ found: true, order, items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
    const result = await query(
      `UPDATE items SET name=?, price=?, image_url=?, description=?, stock=?, status=? WHERE id=?`,
      [name, priceNum, image_url || null, description || "", stockNum, finalStatus, id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: "Item not found" });
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
