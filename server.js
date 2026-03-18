const path = require('path');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const multer = require('multer');
require('dotenv').config();

const pool = require('./db');

const blacklistTokens = new Set();
const app = express();

app.use(cors({
  origin: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

app.use(express.json());

app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(express.static(path.join(__dirname, '..')));

app.use('/admin', express.static(path.join(__dirname, '..', 'admin')));
app.use('/Productos', express.static(path.join(__dirname, '..', 'Productos')));
app.use('/Compras', express.static(path.join(__dirname, '..', 'Compras')));
app.use('/images', express.static(path.join(__dirname, '..', 'images')));

// Multer para imágenes
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, '..', 'images'));
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Solo se permiten archivos de imagen'), false);
    }
  }
});

const PRODUCT_TABLES = {
  ramo: { table: 'ramos', idColumn: 'Id_ramo' },
  ramos: { table: 'ramos', idColumn: 'Id_ramo' },
  accesorio: { table: 'accesorios', idColumn: 'Id_accesorio' },
  accesorios: { table: 'accesorios', idColumn: 'Id_accesorio' },
  decorativo: { table: 'decorativos', idColumn: 'Id_decorativo' },
  decorativos: { table: 'decorativos', idColumn: 'Id_decorativo' }
};

function getProductTableInfo(tipo) {
  return PRODUCT_TABLES[(tipo || '').toLowerCase()] || null;
}

// Inicio
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'Index.html'));
});

// Log para productos
app.use('/api/productos', (req, res, next) => {
  console.log('[API] request to /api/productos', req.method, req.url);
  next();
});

// Obtener productos
app.get('/api/productos', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT 'ramos' AS tipo, Id_ramo AS id, Nombre, Precio, Descripcion, Stock,
             IFNULL(ImagenURL, '') AS ImagenURL,
             IFNULL(Categoria, 'Ramos') AS Categoria
      FROM ramos
      UNION ALL
      SELECT 'accesorios' AS tipo, Id_accesorio AS id, Nombre, Precio, Descripcion, Stock,
             IFNULL(ImagenURL, '') AS ImagenURL,
             IFNULL(Categoria, 'Accesorios') AS Categoria
      FROM accesorios
      UNION ALL
      SELECT 'decorativos' AS tipo, Id_decorativo AS id, Nombre, Precio, Descripcion, Stock,
             IFNULL(ImagenURL, '') AS ImagenURL,
             IFNULL(Categoria, 'Decorativos') AS Categoria
      FROM decorativos
      ORDER BY Nombre
    `);

    res.json(rows);
  } catch (err) {
    console.error('Error al obtener productos:', err);
    res.status(500).json({ error: 'Error al obtener productos' });
  }
});

// Obtener clientes
app.get('/api/clientes', async (req, res) => {
  try {
    let query = `
      SELECT c.Id_cliente, c.Nombre, c.Correo, c.Telefono,
             COUNT(p.Id_pedido) AS Pedidos,
             IFNULL(SUM(p.Total), 0) AS TotalComprado,
             MAX(p.Fecha) AS UltimaCompra
      FROM clientes c
      LEFT JOIN pedidos p ON c.Id_cliente = p.Id_cliente
      GROUP BY c.Id_cliente, c.Nombre, c.Correo, c.Telefono
    `;

    const filter = req.query.filter;

    if (filter === 'frecuentes') {
      query += ` HAVING COUNT(p.Id_pedido) > 5`;
    } else if (filter === 'recientes') {
      query += ` HAVING MAX(p.Fecha) >= DATE_SUB(NOW(), INTERVAL 1 MONTH)`;
    }

    query += ` ORDER BY c.Nombre`;

    const [rows] = await pool.query(query);
    res.json(rows);
  } catch (err) {
    console.error('Error al obtener clientes:', err);
    res.status(500).json({ error: 'Error al obtener clientes' });
  }
});

// Obtener pedidos
app.get('/api/pedidos', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT p.Id_pedido, p.Id_cliente, c.Nombre AS Cliente, p.Fecha, p.Estado, p.Total, p.Notas
      FROM pedidos p
      JOIN clientes c ON p.Id_cliente = c.Id_cliente
      ORDER BY p.Fecha DESC
    `);

    res.json(rows);
  } catch (err) {
    console.error('Error al obtener pedidos:', err);
    res.status(500).json({ error: 'Error al obtener pedidos' });
  }
});

// Obtener producto individual
app.get('/api/productos/:tipo/:id', async (req, res) => {
  try {
    const { tipo, id } = req.params;
    const info = getProductTableInfo(tipo);

    if (!info) {
      return res.status(400).json({ error: 'Tipo de producto inválido' });
    }

    const [rows] = await pool.query(
      `SELECT * FROM ${info.table} WHERE ${info.idColumn} = ?`,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }

    const producto = rows[0];

    res.json({
      id: producto[info.idColumn],
      tipo,
      nombre: producto.Nombre,
      descripcion: producto.Descripcion,
      precio: producto.Precio,
      stock: producto.Stock,
      imagen: producto.ImagenURL,
      categoria: producto.Categoria
    });
  } catch (err) {
    console.error('Error al obtener producto:', err);
    res.status(500).json({ error: 'Error al obtener producto' });
  }
});

// Crear producto
app.post('/api/productos', upload.single('imagen'), async (req, res) => {
  try {
    const { tipo, nombre, precio, stock, descripcion, imagenURL, categoria } = req.body;

    let finalImagenURL = imagenURL;
    if (req.file) {
      finalImagenURL = `/images/${req.file.filename}`;
    }

    const info = getProductTableInfo(tipo);
    if (!info) {
      return res.status(400).json({ error: 'Tipo de producto inválido' });
    }

    const [result] = await pool.query(
      `INSERT INTO ${info.table} (Nombre, Precio, Stock, Descripcion, ImagenURL, Categoria)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [nombre, precio, stock, descripcion, finalImagenURL, categoria]
    );

    res.json({ id: result.insertId, tipo });
  } catch (err) {
    console.error('Error al crear producto:', err);
    res.status(500).json({ error: 'Error al crear producto' });
  }
});

// Actualizar producto
app.put('/api/productos/:tipo/:id', async (req, res) => {
  try {
    const { tipo, id } = req.params;
    const { nombre, precio, stock, descripcion, imagenURL, categoria } = req.body;

    const info = getProductTableInfo(tipo);
    if (!info) {
      return res.status(400).json({ error: 'Tipo de producto inválido' });
    }

    await pool.query(
      `UPDATE ${info.table}
       SET Nombre = ?, Precio = ?, Stock = ?, Descripcion = ?, ImagenURL = ?, Categoria = ?
       WHERE ${info.idColumn} = ?`,
      [nombre, precio, stock, descripcion, imagenURL, categoria, id]
    );

    res.json({ message: 'Producto actualizado' });
  } catch (err) {
    console.error('Error al actualizar producto:', err);
    res.status(500).json({ error: 'Error al actualizar producto' });
  }
});

// Eliminar producto
app.delete('/api/productos/:tipo/:id', async (req, res) => {
  try {
    const { tipo, id } = req.params;

    const info = getProductTableInfo(tipo);
    if (!info) {
      return res.status(400).json({ error: 'Tipo de producto inválido' });
    }

    await pool.query(
      `DELETE FROM ${info.table} WHERE ${info.idColumn} = ?`,
      [id]
    );

    res.json({ message: 'Producto eliminado' });
  } catch (err) {
    console.error('Error al eliminar producto:', err);
    res.status(500).json({ error: 'Error al eliminar producto' });
  }
});

// Obtener administradores
app.get('/api/administradores', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT Id_admin, Nombre, Correo FROM administradores'
    );
    res.json(rows);
  } catch (err) {
    console.error('Error al obtener administradores:', err);
    res.status(500).json({ error: 'Error al obtener administradores' });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  const { correo, contrasena } = req.body;

  if (!correo || !contrasena) {
    return res.status(400).json({ error: 'Correo y contraseña son requeridos' });
  }

  try {
    let [rows] = await pool.query(
      `SELECT Id_cliente AS id, Nombre, Contrasena, 'cliente' AS role
       FROM clientes
       WHERE Correo = ?`,
      [correo]
    );

    let user = rows[0];

    if (!user) {
      [rows] = await pool.query(
        `SELECT Id_admin AS id, Nombre, Contrasena, 'admin' AS role
         FROM administradores
         WHERE Correo = ?`,
        [correo]
      );
      user = rows[0];
    }

    if (!user) {
      return res.status(401).json({ error: 'Correo o contraseña incorrectos' });
    }

    const match = await bcrypt.compare(contrasena, String(user.Contrasena).trim());

    if (!match) {
      return res.status(401).json({ error: 'Correo o contraseña incorrectos' });
    }

    console.log(`Login exitoso: ${correo} (${user.role})`);

    res.json({
      success: true,
      token: 'token-simulado-' + Date.now(),
      role: user.role,
      nombre: user.Nombre,
      id: user.id
    });
  } catch (err) {
    console.error('Error en /api/login:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Registro
app.post('/api/signup', async (req, res) => {
  const { nombre, correo, contrasena } = req.body;

  if (!nombre || !correo || !contrasena) {
    return res.status(400).json({ error: 'Nombre, correo y contraseña son requeridos' });
  }

  try {
    let [rows] = await pool.query(
      'SELECT Id_cliente FROM clientes WHERE Correo = ?',
      [correo]
    );

    if (rows.length > 0) {
      return res.status(409).json({ error: 'El correo ya está registrado' });
    }

    [rows] = await pool.query(
      'SELECT Id_admin FROM administradores WHERE Correo = ?',
      [correo]
    );

    if (rows.length > 0) {
      return res.status(409).json({ error: 'El correo ya está registrado' });
    }

    const hashedPassword = await bcrypt.hash(contrasena, 10);

    await pool.query(
      'INSERT INTO clientes (Nombre, Correo, Contrasena) VALUES (?, ?, ?)',
      [nombre, correo, hashedPassword]
    );

    console.log(`Usuario registrado: ${correo}`);
    res.json({ success: true, message: 'Cuenta creada exitosamente' });
  } catch (err) {
    console.error('Error en /api/signup:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Logout
app.post('/api/logout', (req, res) => {
  const autoHeader = req.headers['authorization'];
  const token = autoHeader && autoHeader.split(' ')[1];

  if (token) {
    blacklistTokens.add(token);
  }

  res.json({ message: 'Logout exitoso' });
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
