require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const PASSWORD_EDITOR = 'Cocesna2026';

// Initialize Supabase Client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('ERROR: SUPABASE_URL o SUPABASE_KEY faltan en el archivo .env');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);
console.log('Client Supabase initialized targeting:', supabaseUrl);

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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
    
    // Fetch data from Supabase
    const { data, error } = await supabase
      .from('equipos')
      .select('*')
      .order('sede', { ascending: true })
      .order('edificio', { ascending: true })
      .order('numero_equipo', { ascending: true });
      
    if (error) {
      throw error;
    }
    
    // Sanitize rows and translate boolean 'realizado' to 1/0 for frontend compatibility
    const sanitizedRows = data.map(row => {
      const sanitized = { 
        ...row,
        realizado: row.realizado ? 1 : 0 // Translate boolean to 1/0
      };
      if (!isEditor) {
        delete sanitized.link_cotizacion;
      }
      return sanitized;
    });
    
    res.json(sanitizedRows);
  } catch (error) {
    console.error('Error fetching data from Supabase:', error.message);
    res.status(500).json({ error: 'Error al obtener los equipos de la base de datos' });
  }
});

// Update equipment details (Editor only)
app.put('/api/equipos/:id', authenticateEditor, async (req, res) => {
  const { id } = req.params;
  const { correctivo_sugerido, realizado, items_a_cotizar, link_cotizacion, capacidad } = req.body;
  
  try {
    // Build update object
    const updateData = {};
    if (correctivo_sugerido !== undefined) updateData.correctivo_sugerido = correctivo_sugerido;
    if (realizado !== undefined) updateData.realizado = realizado ? true : false;
    if (items_a_cotizar !== undefined) updateData.items_a_cotizar = items_a_cotizar;
    if (link_cotizacion !== undefined) updateData.link_cotizacion = link_cotizacion;
    if (capacidad !== undefined) updateData.capacidad = capacidad;
    updateData.updated_at = new Date().toISOString();
    
    // Update in Supabase
    const { data, error } = await supabase
      .from('equipos')
      .update(updateData)
      .eq('id', id)
      .select();
      
    if (error) {
      throw error;
    }
    
    if (!data || data.length === 0) {
      return res.status(404).json({ error: 'Equipo no encontrado en la base de datos' });
    }
    
    // Map back for WebSocket broadcast (convert boolean to 1/0)
    const updatedRow = {
      ...data[0],
      realizado: data[0].realizado ? 1 : 0
    };
    
    // Broadcast the update to all connected WebSocket clients
    broadcast({
      type: 'update',
      data: updatedRow
    });
    
    res.json({ success: true, data: updatedRow });
  } catch (error) {
    console.error('Error updating equipment in Supabase:', error.message);
    res.status(500).json({ error: 'Error al actualizar el equipo' });
  }
});

// WebSocket Server Sincronización
const activeLocks = {};
const clients = new Map();
let clientCounter = 0;

wss.on('connection', (ws) => {
  const clientId = `client_${++clientCounter}`;
  clients.set(ws, clientId);
  
  console.log(`WebSocket client connected: ${clientId}`);
  
  ws.send(JSON.stringify({
    type: 'initial_locks',
    locks: activeLocks
  }));
  
  ws.on('message', (message) => {
    try {
      const parsed = JSON.parse(message);
      
      switch (parsed.type) {
        case 'lock':
          if (parsed.id && parsed.field) {
            const lockKey = `${parsed.id}-${parsed.field}`;
            activeLocks[lockKey] = clientId;
            
            broadcastToOthers(ws, {
              type: 'lock',
              id: parsed.id,
              field: parsed.field,
              clientId: clientId
            });
          }
          break;
          
        case 'unlock':
          if (parsed.id && parsed.field) {
            const lockKey = `${parsed.id}-${parsed.field}`;
            if (activeLocks[lockKey] === clientId) {
              delete activeLocks[lockKey];
              
              broadcastToOthers(ws, {
                type: 'unlock',
                id: parsed.id,
                field: parsed.field
              });
            }
          }
          break;
      }
    } catch (e) {
      console.error('Error parsing WS message:', e);
    }
  });
  
  ws.on('close', () => {
    console.log(`WebSocket client disconnected: ${clientId}`);
    clients.delete(ws);
    
    for (const [key, ownerId] of Object.entries(activeLocks)) {
      if (ownerId === clientId) {
        delete activeLocks[key];
        const [id, field] = key.split('-');
        
        broadcast({
          type: 'unlock',
          id: parseInt(id),
          field: field
        });
      }
    }
  });
});

function broadcast(data) {
  const messageStr = JSON.stringify(data);
  for (const client of clients.keys()) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(messageStr);
    }
  }
}

function broadcastToOthers(senderWs, data) {
  const messageStr = JSON.stringify(data);
  for (const client of clients.keys()) {
    if (client !== senderWs && client.readyState === WebSocket.OPEN) {
      client.send(messageStr);
    }
  }
}

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
