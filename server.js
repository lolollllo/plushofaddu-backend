const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const bodyParser = require('body-parser');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { createClient } = require('@libsql/client/node'); // Use the Turso client

const app = express();
const port = 6942; // Use environment variable for port
const SECRET = 'supersecretkey';

// Turso database connection details from environment variables
const tursoUrl = "libsql://plushofaddu-plushofaddu.aws-ap-south-1.turso.io";
const tursoAuthToken = "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3NTYxOTk0MDksImlkIjoiOWUxYzc0M2ItMmI3NC00NjIxLTljZDgtZDgxNjM2MjYzMDVkIiwicmlkIjoiNjRhNTRiNzUtZDQ5Mi00Y2RjLThmMmEtMGRiMjU5ZjZmYWQ0In0.fM2PjR6QWk7VdewTvMDq0kT3ScyqM4CAaKYRdwpIOysU1VprijKX7NHlajMRyDG7ixfpiZAIRO3tYzYmKpaaBQ";

// Initialize the Turso database client
const db = createClient({
  url: tursoUrl,
  authToken: tursoAuthToken,
});

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
const storage = multer.memoryStorage({
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

// A function to migrate existing images to the new item_images table structure
// A function to migrate existing images to the new item_images table structure
async function migrateImagesToItemImages() {
  console.log("Starting image migration...");
  const rs = await db.execute("SELECT id, image_url FROM items WHERE image_url IS NOT NULL");
  const itemsWithImages = rs.rows;

  if (itemsWithImages.length === 0) {
    console.log("No images to migrate.");
    return;
  }

  const batchStatements = itemsWithImages.map((item) => {
    return {
      sql: `INSERT INTO item_images (item_id, image_url) VALUES (?, ?)`,
      args: [Number(item.id), item.image_url],
    };
  });

  try {
    await db.batch(batchStatements);
    console.log(`Successfully migrated ${itemsWithImages.length} images.`);
  } catch (err) {
    console.error("Error during image migration:", err);
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

// Initialize database tables, including item_images
async function initializeDb() {
  try {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        price REAL NOT NULL DEFAULT 0,
        image_url TEXT,
        status TEXT CHECK(status IN ('in-stock', 'pre-order')) NOT NULL,
        description TEXT,
        stock INTEGER DEFAULT 0
      )`);
    await db.execute(`
      CREATE TABLE IF NOT EXISTS item_images (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id INTEGER NOT NULL,
        image_url TEXT NOT NULL,
        FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE
      )`);
    await db.execute(`
      CREATE TABLE IF NOT EXISTS admins (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT
      )`);
    await db.execute(`
      CREATE TABLE IF NOT EXISTS orders (
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
      )`);
    await db.execute(`
      CREATE TABLE IF NOT EXISTS order_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER,
        item_id INTEGER,
        quantity INTEGER,
        FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE,
        FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE
      )`);

    await migrateImagesToItemImages();

    // Seed default admin user if not exists
    const admin = await db.execute("SELECT * FROM admins WHERE username = 'admin'");
    if (admin.rows.length === 0) {
      const hash = await bcrypt.hash('adminpass', 10);
      await db.execute("INSERT INTO admins (username, password) VALUES (?, ?)", ['admin', hash]);
    }

    console.log('Database initialized successfully.');
  } catch (err) {
    console.error('Error initializing database:', err);
  }
}

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
    const rs = await db.execute(`
      SELECT i.*, (
        SELECT image_url
        FROM item_images
        WHERE item_id = i.id
        LIMIT 1
      ) as preview_image_url
      FROM items i
    `);
    res.json(rs.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Public endpoint: Get single item with all images
app.get('/items/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const itemRs = await db.execute({ sql: "SELECT * FROM items WHERE id = ?", args: [id] });
    const item = itemRs.rows[0];
    if (!item) return res.status(404).json({ error: "Item not found" });

    const imagesRs = await db.execute({ sql: "SELECT image_url FROM item_images WHERE item_id = ?", args: [id] });
    item.images = imagesRs.rows.map(img => img.image_url);
    res.json(item);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Public order placement endpoint (no auth)
app.post('/orders', async (req, res) => {
    const { customer_name, instagram, phone, delivery_method, payment_method, orderItems, delivery_charge } = req.body;

    // Data cleaning and validation
    // FIX: Replace non-breaking space before trimming
    const finalCustomerName = typeof customer_name === 'string' && customer_name.replace(/\u00a0/g, ' ').trim().length > 0 ? customer_name.replace(/\u00a0/g, ' ').trim() : null;
    const finalInstagram = typeof instagram === 'string' && instagram.replace(/\u00a0/g, ' ').trim().length > 0 ? instagram.replace(/\u00a0/g, ' ').trim() : null;
    const finalPhone = typeof phone === 'string' && phone.replace(/\u00a0/g, ' ').trim().length > 0 ? phone.replace(/\u00a0/g, ' ').trim() : null;
    const finalDeliveryMethod = typeof delivery_method === 'string' ? delivery_method.trim() : null;
    const finalPaymentMethod = typeof payment_method === 'string' ? payment_method.trim() : null;
    const finalDeliveryCharge = typeof delivery_charge === 'number' ? delivery_charge : 0;

    if (!finalCustomerName) {
        return res.status(400).json({ error: "Customer name is required" });
    }
    if (!finalInstagram && !finalPhone) {
        return res.status(400).json({ error: "Please provide either Instagram username or Phone number." });
    }
    if (!orderItems || !Array.isArray(orderItems) || orderItems.length === 0) {
        return res.status(400).json({ error: "Order must have at least one item." });
    }
    const tracking_id = generateTrackingId();
    let orderId;
    try {
        // Step 1: Insert the new order.
        const orderRs = await db.execute({
            sql: `INSERT INTO orders (
                customer_name, instagram, phone,
                delivery_method, payment_method, delivery_charge, tracking_id, status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [finalCustomerName, finalInstagram, finalPhone, finalDeliveryMethod, finalPaymentMethod, finalDeliveryCharge, tracking_id, 'waiting for updates'],
        });
        // Convert the BigInt to a Number.
        orderId = Number(orderRs.lastInsertRowid);
        // Step 2: Insert each order item individually.
        for (const oi of orderItems) {
            await db.execute({
                sql: "INSERT INTO order_items (order_id, item_id, quantity) VALUES (?, ?, ?)",
                args: [orderId, Number(oi.item_id), Number(oi.quantity)],
            });
        }
        // Step 3: All inserts succeeded, fetch details and send response.
        const itemsRs = await db.execute({
            sql: `SELECT i.name, i.status, i.price, oi.quantity
                  FROM order_items oi
                  JOIN items i ON oi.item_id = i.id
                  WHERE oi.order_id = ?`,
            args: [orderId]
        });

        const totalPrice = itemsRs.rows.reduce(
            (sum, row) => sum + row.price * row.quantity, 0
        );

        const items = itemsRs.rows.map(({ name, status, quantity }) => ({ name, status, quantity }));
        const totalPriceWithDelivery = totalPrice + finalDeliveryCharge;

        res.json({
            order_id: orderId.toString(),
            tracking_id,
            customer_name: finalCustomerName,
            instagram: finalInstagram,
            phone: finalPhone,
            delivery_method: finalDeliveryMethod,
            payment_method: finalPaymentMethod,
            delivery_charge: finalDeliveryCharge,
            total_price: totalPriceWithDelivery.toFixed(2),
            items,
            message: "Your order has been confirmed!",
        });
    } catch (err) {
        console.error('Error placing order:', err);
        // Manual Rollback: If any error occurred, delete the order that was created
        if (orderId) {
            try {
                // Delete the order and its items (due to ON DELETE CASCADE)
                await db.execute({ sql: "DELETE FROM orders WHERE id = ?", args: [orderId] });
            } catch (rollbackErr) {
                console.error('Failed to rollback order:', rollbackErr);
            }
        }
        res.status(500).json({ error: "An error occurred while placing your order. Please try again." });
    }
});

// Admin login
app.post('/admin/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const userRs = await db.execute({ sql: "SELECT * FROM admins WHERE username = ?", args: [username] });
    const user = userRs.rows[0];
    if (!user) return res.status(401).json({ error: "Invalid credentials" });

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
    // Immediate check to ensure a file was uploaded
    if (!req.file || !req.file.buffer) {
        return res.status(400).json({ error: "No valid image file uploaded." });
    }
    
    // Process the image from the in-memory buffer
    try {
        const resizedFilename = `resized-${Date.now()}-${Math.round(Math.random() * 1e9)}.webp`;
        const finalPath = path.join(uploadsDir, resizedFilename);
        const finalUrl = `/uploads/${resizedFilename}`;

        await sharp(req.file.buffer)
            .resize(800, 800, {
                fit: 'inside',
                position: sharp.strategy.attention,
                withoutEnlargement: true,
            })
            .webp({ quality: 80 })
            .toFile(finalPath);

        res.json({ url: finalUrl });
    } catch (err) {
        console.error("Image processing error:", err);
        res.status(500).json({ error: "Failed to process image." });
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

    await db.execute({ sql: "INSERT INTO item_images (item_id, image_url) VALUES (?, ?)", args: [itemId, imageUrl] });
    res.json({ url: imageUrl });
  } catch (err) {
    console.error("Image processing error:", err);
    res.status(500).json({ error: "Failed to process image" });
  }
});

// Add new item
app.post('/admin/items', authenticate, async (req, res) => {
    const { name, price, description, stock, images = [] } = req.body;

    if (!name || price === undefined) {
        return res.status(400).json({ error: "Name and price are required" });
    }

    let priceNum = Number(price);
    if (isNaN(priceNum)) {
        return res.status(400).json({ error: "Price must be a number" });
    }
    priceNum = Math.round(priceNum * 100) / 100;
    let stockNum = Number(stock) || 0;
    if (isNaN(stockNum) || stockNum < 0) stockNum = 0;

    const finalStatus = stockNum === 0 ? "pre-order" : "in-stock";
    const preview_image_url = images.length > 0 ? images[0] : null;

    try {
        const rs = await db.execute({
            sql: `INSERT INTO items (name, price, image_url, status, description, stock) VALUES (?, ?, ?, ?, ?, ?)`,
            args: [name, priceNum, preview_image_url, finalStatus, description || "", stockNum]
        });
        
        // Convert the BigInt to a string before including it in the JSON response
        const itemId = rs.lastInsertRowid.toString();

        await db.transaction(async (tx) => {
            const stmt = tx.prepare("INSERT INTO item_images(item_id, image_url) VALUES (?, ?)");
            for (const url of images) {
                await stmt.execute([itemId, url]);
            }
        });

        res.json({ success: true, id: itemId });
    } catch (err) {
        console.error('Error adding new item:', err);
        res.status(500).json({ error: err.message });
    }
});

// Get all orders (with item summaries)
app.get('/admin/orders', authenticate, async (req, res) => {
  try {
    const ordersRs = await db.execute("SELECT * FROM orders ORDER BY created_at DESC");
    const orders = ordersRs.rows;

    if (!orders.length) return res.json([]);

    const orderIds = orders.map(o => o.id);
    const placeholders = orderIds.map(() => "?").join(",");

    const itemsRs = await db.execute({
      sql: `SELECT oi.order_id, i.name, i.status, oi.quantity
            FROM order_items oi
            JOIN items i ON oi.item_id = i.id
            WHERE oi.order_id IN (${placeholders})`,
      args: orderIds,
    });
    const items = itemsRs.rows;

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
  const { id } = req.params;
  if (!status) return res.status(400).json({ error: "Status is required" });

  try {
    const rs = await db.execute({
      sql: "UPDATE orders SET status = ? WHERE id = ?",
      args: [status, id]
    });
    if (rs.rowsAffected === 0) return res.status(404).json({ error: "Order not found" });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add new order with items (admin)
app.post('/admin/orders', authenticate, async (req, res) => {
    // Note: Assuming you have an authentication middleware for this endpoint.
    // For example: app.post('/admin/orders', adminAuth, async (req, res) => { ... });
    const { customer_name, instagram, phone, delivery_method, payment_method, orderItems, delivery_charge } = req.body;

    // --- Validation and data cleaning ---
    const finalCustomerName = typeof customer_name === 'string' && customer_name.trim().length > 0 ? customer_name.trim() : null;
    const finalInstagram = typeof instagram === 'string' && instagram.trim().length > 0 ? instagram.trim() : null;
    const finalPhone = typeof phone === 'string' && phone.trim().length > 0 ? phone.trim() : null;
    const finalDeliveryMethod = typeof delivery_method === 'string' ? delivery_method.trim() : null;
    const finalPaymentMethod = typeof payment_method === 'string' ? payment_method.trim() : null;
    const finalDeliveryCharge = typeof delivery_charge === 'number' ? delivery_charge : 0;
    
    if (!finalCustomerName) {
        return res.status(400).json({ error: "Customer name is required" });
    }
    if (!finalInstagram && !finalPhone) {
        return res.status(400).json({ error: "Please provide either Instagram username or Phone number." });
    }
    if (!orderItems || !Array.isArray(orderItems) || orderItems.length === 0) {
        return res.status(400).json({ error: "Order must have at least one item." });
    }

    const tracking_id = generateTrackingId();
    let orderId;

    try {
        // Step 1: Insert the new order.
        const orderRs = await db.execute({
            sql: `INSERT INTO orders (
                customer_name, instagram, phone,
                delivery_method, payment_method, delivery_charge, tracking_id, status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [finalCustomerName, finalInstagram, finalPhone, finalDeliveryMethod, finalPaymentMethod, finalDeliveryCharge, tracking_id, 'waiting for updates'],
        });
        
        // Convert the BigInt to a Number.
        orderId = Number(orderRs.lastInsertRowid);

        // Step 2: Insert each order item individually.
        for (const oi of orderItems) {
            await db.execute({
                sql: "INSERT INTO order_items (order_id, item_id, quantity) VALUES (?, ?, ?)",
                args: [orderId, Number(oi.item_id), Number(oi.quantity)],
            });
        }

        // Step 3: All inserts succeeded, fetch details and send response.
        const itemsRs = await db.execute({
            sql: `SELECT i.name, i.status, i.price, oi.quantity
                  FROM order_items oi
                  JOIN items i ON oi.item_id = i.id
                  WHERE oi.order_id = ?`,
            args: [orderId]
        });

        const totalPrice = itemsRs.rows.reduce(
            (sum, row) => sum + row.price * row.quantity,
            0
        );

        const items = itemsRs.rows.map(({ name, status, quantity }) => ({ name, status, quantity }));
        const totalPriceWithDelivery = totalPrice + finalDeliveryCharge;

        res.json({
            order_id: orderId.toString(),
            tracking_id,
            customer_name: finalCustomerName,
            instagram: finalInstagram,
            phone: finalPhone,
            delivery_method: finalDeliveryMethod,
            payment_method: finalPaymentMethod,
            delivery_charge: finalDeliveryCharge,
            total_price: totalPriceWithDelivery.toFixed(2),
            items,
            message: "Order placed successfully for admin!",
        });

    } catch (err) {
        console.error('Error placing order:', err);

        // Manual Rollback: If any error occurred, delete the order that was created
        if (orderId) {
            try {
                // Delete the order and its items (due to ON DELETE CASCADE)
                await db.execute({ sql: "DELETE FROM orders WHERE id = ?", args: [orderId] });
            } catch (rollbackErr) {
                console.error('Failed to rollback order:', rollbackErr);
            }
        }

        res.status(500).json({ error: "An error occurred while placing your order. Please try again." });
    }
});

// DELETE an order by ID (admin only)
app.delete('/admin/orders/:id', authenticate, async (req, res) => {
  const orderId = req.params.id;

  try {
    await db.transaction(async (tx) => {
      await tx.execute({
        sql: "DELETE FROM order_items WHERE order_id = ?",
        args: [orderId]
      });
      const rs = await tx.execute({
        sql: "DELETE FROM orders WHERE id = ?",
        args: [orderId]
      });
      if (rs.rowsAffected === 0) throw new Error("Order not found");
    });
    res.json({ success: true, message: "Order deleted" });
  } catch (err) {
    if (err.message === "Order not found") {
      res.status(404).json({ error: err.message });
    } else {
      res.status(500).json({ error: err.message });
    }
  }
});

// Track order by tracking id
app.get('/track/:trackingId', async (req, res) => {
  const { trackingId } = req.params;
  try {
    const orderRs = await db.execute({ sql: "SELECT * FROM orders WHERE tracking_id = ?", args: [trackingId] });
    const order = orderRs.rows[0];
    if (!order) return res.json({ found: false });

    const itemsRs = await db.execute({
      sql: `SELECT items.name, order_items.quantity
            FROM order_items
            JOIN items ON order_items.item_id = items.id
            WHERE order_items.order_id = ?`,
      args: [order.id]
    });
    res.json({ found: true, order, items: itemsRs.rows });
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
  let stockNum = Number(stock) || 0;
  if (isNaN(stockNum) || stockNum < 0) stockNum = 0;

  const finalStatus = stockNum === 0 ? "pre-order" : "in-stock";

  try {
    const rs = await db.execute({
      sql: `UPDATE items SET name=?, price=?, image_url=?, description=?, stock=?, status=? WHERE id=?`,
      args: [name, priceNum, image_url || null, description || "", stockNum, finalStatus, id]
    });
    if (rs.rowsAffected === 0) return res.status(404).json({ error: "Item not found" });
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

// Start the server after DB initialization
initializeDb().then(() => {
  app.listen(port, () => {
    console.log(`Backend running on http://localhost:${port}`);
  });
}).catch(err => {
  console.error('Failed to start server:', err);
});
