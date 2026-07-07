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
    
    // Fetch data from Supabase (with joined correctives list)
    const { data, error } = await supabase
      .from('equipos')
      .select(`
        *,
        correctivos (
          id,
          correctivo_sugerido,
          realizado,
          items_a_cotizar,
          link_cotizacion,
          created_at,
          updated_at
        )
      `)
      .order('sede', { ascending: true })
      .order('edificio', { ascending: true })
      .order('numero_equipo', { ascending: true })
      .order('created_at', { foreignTable: 'correctivos', ascending: true });
      
    if (error) {
      throw error;
    }
    
    // Sanitize rows and translate boolean 'realizado' to 1/0 for frontend compatibility
    const sanitizedRows = data.map(row => {
      const correctives = (row.correctivos || []).map(corr => {
        const sanitizedCorr = {
          ...corr,
          realizado: corr.realizado ? 1 : 0 // Translate boolean to 1/0
        };
        if (!isEditor) {
          delete sanitizedCorr.link_cotizacion;
        }
        return sanitizedCorr;
      });
      
      return { 
        ...row,
        correctivos: correctives
      };
    });
    
    res.json(sanitizedRows);
  } catch (error) {
    console.error('Error fetching data from Supabase:', error);
    res.status(500).json({ error: error.message || 'Error al obtener los equipos de la base de datos' });
  }
});

// Update equipment details (Capacity only - Editor only)
app.put('/api/equipos/:id', authenticateEditor, async (req, res) => {
  const { id } = req.params;
  const { capacidad } = req.body;
  
  try {
    const { data, error } = await supabase
      .from('equipos')
      .update({ capacidad })
      .eq('id', id)
      .select();
      
    if (error) throw error;
    if (!data || data.length === 0) {
      return res.status(404).json({ error: 'Equipo no encontrado' });
    }
    
    // Fetch full equipment row with its correctives to broadcast
    const { data: fullEq, error: fetchErr } = await supabase
      .from('equipos')
      .select(`
        *,
        correctivos (
          id,
          correctivo_sugerido,
          realizado,
          items_a_cotizar,
          link_cotizacion,
          created_at,
          updated_at
        )
      `)
      .eq('id', id)
      .order('created_at', { foreignTable: 'correctivos', ascending: true });
      
    if (fetchErr) throw fetchErr;
    
    const updatedRow = {
      ...fullEq[0],
      correctivos: (fullEq[0].correctivos || []).map(c => ({
        ...c,
        realizado: c.realizado ? 1 : 0
      }))
    };
    
    // Broadcast the update to all connected WebSocket clients
    broadcast({
      type: 'update',
      data: updatedRow
    });
    
    res.json({ success: true, data: updatedRow });
  } catch (error) {
    console.error('Error updating equipment capacity in Supabase:', error);
    res.status(500).json({ error: error.message || 'Error al actualizar el equipo' });
  }
});

// Create a new corrective for an equipment (Editor only)
app.post('/api/correctivos', authenticateEditor, async (req, res) => {
  const { equipo_id } = req.body;
  if (!equipo_id) {
    return res.status(400).json({ error: 'equipo_id es requerido' });
  }
  
  try {
    const { data, error } = await supabase
      .from('correctivos')
      .insert({
        equipo_id,
        correctivo_sugerido: '',
        realizado: false,
        items_a_cotizar: '',
        link_cotizacion: ''
      })
      .select();
      
    if (error) throw error;
    
    // Fetch full equipment row to broadcast
    const { data: fullEq, error: fetchErr } = await supabase
      .from('equipos')
      .select(`
        *,
        correctivos (
          id,
          correctivo_sugerido,
          realizado,
          items_a_cotizar,
          link_cotizacion,
          created_at,
          updated_at
        )
      `)
      .eq('id', equipo_id)
      .order('created_at', { foreignTable: 'correctivos', ascending: true });
      
    if (fetchErr) throw fetchErr;
    
    const updatedRow = {
      ...fullEq[0],
      correctivos: (fullEq[0].correctivos || []).map(c => ({
        ...c,
        realizado: c.realizado ? 1 : 0
      }))
    };
    
    broadcast({
      type: 'update',
      data: updatedRow
    });
    
    res.json({ success: true, data: updatedRow });
  } catch (error) {
    console.error('Error creating corrective in Supabase:', error);
    res.status(500).json({ error: error.message || 'Error al agregar correctivo' });
  }
});

// Update a specific corrective (Editor only)
app.put('/api/correctivos/:id', authenticateEditor, async (req, res) => {
  const { id } = req.params;
  const { correctivo_sugerido, realizado, items_a_cotizar, link_cotizacion } = req.body;
  
  try {
    const updateData = {};
    if (correctivo_sugerido !== undefined) updateData.correctivo_sugerido = correctivo_sugerido;
    if (realizado !== undefined) updateData.realizado = realizado ? true : false;
    if (items_a_cotizar !== undefined) updateData.items_a_cotizar = items_a_cotizar;
    if (link_cotizacion !== undefined) updateData.link_cotizacion = link_cotizacion;
    updateData.updated_at = new Date().toISOString();
    
    const { data, error } = await supabase
      .from('correctivos')
      .update(updateData)
      .eq('id', id)
      .select();
      
    if (error) throw error;
    if (!data || data.length === 0) {
      return res.status(404).json({ error: 'Correctivo no encontrado' });
    }
    
    const equipoId = data[0].equipo_id;
    
    // Fetch full equipment row to broadcast
    const { data: fullEq, error: fetchErr } = await supabase
      .from('equipos')
      .select(`
        *,
        correctivos (
          id,
          correctivo_sugerido,
          realizado,
          items_a_cotizar,
          link_cotizacion,
          created_at,
          updated_at
        )
      `)
      .eq('id', equipoId)
      .order('created_at', { foreignTable: 'correctivos', ascending: true });
      
    if (fetchErr) throw fetchErr;
    
    const updatedRow = {
      ...fullEq[0],
      correctivos: (fullEq[0].correctivos || []).map(c => ({
        ...c,
        realizado: c.realizado ? 1 : 0
      }))
    };
    
    broadcast({
      type: 'update',
      data: updatedRow
    });
    
    res.json({ success: true, data: updatedRow });
  } catch (error) {
    console.error('Error updating corrective in Supabase:', error);
    res.status(500).json({ error: error.message || 'Error al actualizar el correctivo' });
  }
});

// Delete a corrective (Editor only)
app.delete('/api/correctivos/:id', authenticateEditor, async (req, res) => {
  const { id } = req.params;
  
  try {
    const { data: corrData, error: findErr } = await supabase
      .from('correctivos')
      .select('equipo_id')
      .eq('id', id);
      
    if (findErr) throw findErr;
    if (!corrData || corrData.length === 0) {
      return res.status(404).json({ error: 'Correctivo no encontrado' });
    }
    
    const equipoId = corrData[0].equipo_id;
    
    const { error } = await supabase
      .from('correctivos')
      .delete()
      .eq('id', id);
      
    if (error) throw error;
    
    // Fetch full equipment row to broadcast
    const { data: fullEq, error: fetchErr } = await supabase
      .from('equipos')
      .select(`
        *,
        correctivos (
          id,
          correctivo_sugerido,
          realizado,
          items_a_cotizar,
          link_cotizacion,
          created_at,
          updated_at
        )
      `)
      .eq('id', equipoId)
      .order('created_at', { foreignTable: 'correctivos', ascending: true });
      
    if (fetchErr) throw fetchErr;
    
    // If the equipment has no more correctives, fullEq[0].correctivos will be empty
    const updatedRow = {
      ...fullEq[0],
      correctivos: (fullEq[0].correctivos || []).map(c => ({
        ...c,
        realizado: c.realizado ? 1 : 0
      }))
    };
    
    broadcast({
      type: 'update',
      data: updatedRow
    });
    
    res.json({ success: true, data: updatedRow });
  } catch (error) {
    console.error('Error deleting corrective in Supabase:', error);
    res.status(500).json({ error: error.message || 'Error al eliminar el correctivo' });
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
