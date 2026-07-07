const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'database.db');
const PASSWORD_EDITOR = 'Cocesna2026';

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Connect to SQLite Database
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('Error connecting to SQLite database:', err.message);
  } else {
    console.log('Connected to SQLite database.');
  }
});

// Helper database functions
const dbRun = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
};

const dbAll = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
};

// Authentication Middleware
const authenticateEditor = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  if (authHeader === PASSWORD_EDITOR) {
    next();
  } else {
    res.status(401).json({ error: 'No autorizado. Se requiere acceso de editor.' });
  }
};

// API Routes

// Login route
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password === PASSWORD_EDITOR) {
    return res.json({ success: true, role: 'editor', token: PASSWORD_EDITOR });
  }
  return res.status(401).json({ success: false, error: 'Contraseña incorrecta' });
});

// Get all equipments
app.get('/api/equipos', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    const isEditor = authHeader === PASSWORD_EDITOR;
    
    const rows = await dbAll("SELECT * FROM equipos ORDER BY sede, area");
    
    // If not editor, strip quote links
    const sanitizedRows = rows.map(row => {
      const sanitized = { ...row };
      if (!isEditor) {
        delete sanitized.link_cotizacion;
      }
      return sanitized;
    });
    
    res.json(sanitizedRows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener los equipos' });
  }
});

// Update equipment details (Editor only)
app.put('/api/equipos/:id', authenticateEditor, async (req, res) => {
  const { id } = req.params;
  const { correctivo_sugerido, realizado, items_a_cotizar, link_cotizacion } = req.body;
  
  try {
    // Check if equipment exists
    const rows = await dbAll("SELECT * FROM equipos WHERE id = ?", [id]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Equipo no encontrado' });
    }
    
    const current = rows[0];
    
    // We update fields if they are provided in request, otherwise keep old ones
    const newCorrectivo = correctivo_sugerido !== undefined ? correctivo_sugerido : current.correctivo_sugerido;
    const newRealizado = realizado !== undefined ? (realizado ? 1 : 0) : current.realizado;
    const newItems = items_a_cotizar !== undefined ? items_a_cotizar : current.items_a_cotizar;
    const newLink = link_cotizacion !== undefined ? link_cotizacion : current.link_cotizacion;
    
    await dbRun(
      `UPDATE equipos 
       SET correctivo_sugerido = ?, realizado = ?, items_a_cotizar = ?, link_cotizacion = ?, updated_at = CURRENT_TIMESTAMP 
       WHERE id = ?`,
      [newCorrectivo, newRealizado, newItems, newLink, id]
    );
    
    const updatedRow = {
      id: parseInt(id),
      sede: current.sede,
      area: current.area,
      capacidad: current.capacidad,
      correctivo_sugerido: newCorrectivo,
      realizado: newRealizado,
      items_a_cotizar: newItems,
      link_cotizacion: newLink
    };
    
    // Broadcast the update to all connected WebSocket clients
    broadcast({
      type: 'update',
      data: updatedRow
    });
    
    res.json({ success: true, data: updatedRow });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al actualizar el equipo' });
  }
});

// WebSocket Server Sincronización
// Keep track of active locks: { "id-field": socketId }
const activeLocks = {};
// Keep track of client sockets: Map { socket -> socketId }
const clients = new Map();
let clientCounter = 0;

wss.on('connection', (ws) => {
  const clientId = `client_${++clientCounter}`;
  clients.set(ws, clientId);
  
  console.log(`WebSocket client connected: ${clientId}`);
  
  // Send active locks to the newly connected client
  ws.send(JSON.stringify({
    type: 'initial_locks',
    locks: activeLocks
  }));
  
  ws.on('message', (message) => {
    try {
      const parsed = JSON.parse(message);
      
      switch (parsed.type) {
        case 'lock':
          // Lock a field: parsed = { type: 'lock', id: 12, field: 'items_a_cotizar' }
          if (parsed.id && parsed.field) {
            const lockKey = `${parsed.id}-${parsed.field}`;
            activeLocks[lockKey] = clientId;
            
            // Broadcast lock to all other clients
            broadcastToOthers(ws, {
              type: 'lock',
              id: parsed.id,
              field: parsed.field,
              clientId: clientId
            });
          }
          break;
          
        case 'unlock':
          // Unlock a field: parsed = { type: 'unlock', id: 12, field: 'items_a_cotizar' }
          if (parsed.id && parsed.field) {
            const lockKey = `${parsed.id}-${parsed.field}`;
            if (activeLocks[lockKey] === clientId) {
              delete activeLocks[lockKey];
              
              // Broadcast unlock to all other clients
              broadcastToOthers(ws, {
                type: 'unlock',
                id: parsed.id,
                field: parsed.field
              });
            }
          }
          break;
          
        default:
          console.log(`Unknown message type: ${parsed.type}`);
      }
    } catch (e) {
      console.error('Error parsing WS message:', e);
    }
  });
  
  ws.on('close', () => {
    console.log(`WebSocket client disconnected: ${clientId}`);
    clients.delete(ws);
    
    // Release all locks held by this client
    let lockReleased = false;
    for (const [key, ownerId] of Object.entries(activeLocks)) {
      if (ownerId === clientId) {
        delete activeLocks[key];
        const [id, field] = key.split('-');
        
        // Broadcast unlock to remaining clients
        broadcast({
          type: 'unlock',
          id: parseInt(id),
          field: field
        });
        lockReleased = true;
      }
    }
  });
});

// Broadcast helper for all clients
function broadcast(data) {
  const messageStr = JSON.stringify(data);
  for (const client of clients.keys()) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(messageStr);
    }
  }
}

// Broadcast helper for everyone except the sender
function broadcastToOthers(senderWs, data) {
  const messageStr = JSON.stringify(data);
  for (const client of clients.keys()) {
    if (client !== senderWs && client.readyState === WebSocket.OPEN) {
      client.send(messageStr);
    }
  }
}

// Serve landing page/fallback to index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
