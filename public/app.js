// State management
let currentRole = 'reader';
let currentToken = '';
let equipos = [];
let activeLocks = {}; // Format: { "id-field": "client_X" }
let ws = null;
let wsReconnectTimer = null;
let debounceTimers = {}; // Format: { "id-field": timer }
let currentViewMode = 'grid'; // 'grid' or 'list'

// DOM Elements
const loginScreen = document.getElementById('login-screen');
const dashboardScreen = document.getElementById('dashboard-screen');
const loginPasswordInput = document.getElementById('login-password');
const loginForm = document.getElementById('login-editor-form');
const loginError = document.getElementById('login-error');
const btnLoginReader = document.getElementById('btn-login-reader');
const btnLogout = document.getElementById('btn-logout');
const roleBadge = document.getElementById('role-badge');
const roleText = document.getElementById('role-text');
const connBanner = document.getElementById('conn-banner');

// View controls Elements
const btnViewGrid = document.getElementById('btn-view-grid');
const btnViewList = document.getElementById('btn-view-list');

// Stats Elements
const statsTotal = document.getElementById('stats-total');
const statsPending = document.getElementById('stats-pending');
const statsCompleted = document.getElementById('stats-completed');

// Filter Elements
const filterSearch = document.getElementById('filter-search');
const filterSede = document.getElementById('filter-sede');
const filterZona = document.getElementById('filter-zona');
const filterHasCorrective = document.getElementById('filter-has-corrective');
const filterOnlyPending = document.getElementById('filter-only-pending');
const equipmentGrid = document.getElementById('equipment-grid');

// Initialize app
function init() {
  const savedRole = localStorage.getItem('cocesna_role');
  const savedToken = localStorage.getItem('cocesna_token');
  
  if (savedRole) {
    currentRole = savedRole;
    currentToken = savedToken || '';
    showDashboard();
  } else {
    showLogin();
  }
  
  // Load saved view mode
  const savedView = localStorage.getItem('cocesna_view_mode') || 'grid';
  setViewMode(savedView);
  
  // Set up event listeners
  btnLoginReader.addEventListener('click', loginAsReader);
  loginForm.addEventListener('submit', loginAsEditor);
  btnLogout.addEventListener('click', logout);
  
  if (btnViewGrid && btnViewList) {
    btnViewGrid.addEventListener('click', () => setViewMode('grid'));
    btnViewList.addEventListener('click', () => setViewMode('list'));
  }
  
  filterSearch.addEventListener('input', () => renderEquipos());
  filterSede.addEventListener('change', () => renderEquipos());
  filterZona.addEventListener('change', () => renderEquipos());
  filterHasCorrective.addEventListener('change', () => renderEquipos());
  filterOnlyPending.addEventListener('change', () => renderEquipos());
}

// View switcher setter
function setViewMode(mode) {
  currentViewMode = mode;
  localStorage.setItem('cocesna_view_mode', mode);
  
  if (btnViewGrid && btnViewList) {
    if (mode === 'grid') {
      btnViewGrid.classList.add('active');
      btnViewList.classList.remove('active');
      equipmentGrid.classList.remove('list-view');
    } else {
      btnViewGrid.classList.remove('active');
      btnViewList.classList.add('active');
      equipmentGrid.classList.add('list-view');
    }
  }
  renderEquipos();
}

// Authentication Functions
function showLogin() {
  loginScreen.classList.remove('hidden');
  dashboardScreen.classList.add('hidden');
  stopWebSocket();
}

function showDashboard() {
  loginScreen.classList.add('hidden');
  dashboardScreen.classList.remove('hidden');
  
  if (currentRole === 'editor') {
    roleBadge.className = 'badge editor';
    roleText.textContent = 'Editor';
  } else {
    roleBadge.className = 'badge reader';
    roleText.textContent = 'Lector';
  }
  
  loadData();
  startWebSocket();
}

function loginAsReader() {
  currentRole = 'reader';
  currentToken = '';
  localStorage.setItem('cocesna_role', 'reader');
  localStorage.removeItem('cocesna_token');
  showDashboard();
}

async function loginAsEditor(e) {
  e.preventDefault();
  const password = loginPasswordInput.value;
  
  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ password })
    });
    
    if (response.ok) {
      const data = await response.json();
      currentRole = 'editor';
      currentToken = data.token;
      localStorage.setItem('cocesna_role', 'editor');
      localStorage.setItem('cocesna_token', data.token);
      loginPasswordInput.value = '';
      loginError.classList.add('hidden');
      showDashboard();
    } else {
      loginError.classList.remove('hidden');
    }
  } catch (error) {
    console.error('Error during login:', error);
    loginError.textContent = 'Error de conexión con el servidor.';
    loginError.classList.remove('hidden');
  }
}

function logout() {
  localStorage.removeItem('cocesna_role');
  localStorage.removeItem('cocesna_token');
  currentRole = 'reader';
  currentToken = '';
  showLogin();
}

// Data Fetching
async function loadData() {
  equipmentGrid.innerHTML = `
    <div class="loading-spinner">
      <span class="material-symbols-outlined spin">progress_activity</span>
      Cargando inventario de equipos...
    </div>
  `;
  
  try {
    const headers = {};
    if (currentToken) {
      headers['Authorization'] = currentToken;
    }
    
    const response = await fetch('/api/equipos', { headers });
    if (!response.ok) {
      if (response.status === 401) {
        logout();
        return;
      }
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || 'Failed to fetch data');
    }
    
    equipos = await response.json();
    populateSedeDropdown();
    calculateStats();
    renderEquipos();
  } catch (error) {
    console.error('Error fetching data:', error);
    equipmentGrid.innerHTML = `
      <div class="empty-state">
        <span class="material-symbols-outlined empty-state-icon text-warning">error</span>
        <h3>Error al cargar datos</h3>
        <p>${error.message}</p>
        <button onclick="loadData()" class="btn btn-primary" style="margin-top: 16px;">Reintentar</button>
      </div>
    `;
  }
}

// Dropdown population
function populateSedeDropdown() {
  const sedes = [...new Set(equipos.map(item => item.sede))].filter(Boolean).sort();
  const currentSelection = filterSede.value;
  
  filterSede.innerHTML = '<option value="">Todas las sedes</option>';
  sedes.forEach(sede => {
    const option = document.createElement('option');
    option.value = sede;
    option.textContent = sede;
    filterSede.appendChild(option);
  });
  
  if (sedes.includes(currentSelection)) {
    filterSede.value = currentSelection;
  }
}

// Stats Calculation
function calculateStats() {
  const total = equipos.length;
  const pending = equipos.filter(item => item.correctivo_sugerido && item.realizado === 0).length;
  const completed = equipos.filter(item => item.correctivo_sugerido && item.realizado === 1).length;
  
  statsTotal.textContent = total;
  statsPending.textContent = pending;
  statsCompleted.textContent = completed;
}

// Render the grid
function renderEquipos() {
  const searchVal = filterSearch.value.toLowerCase().trim();
  const sedeVal = filterSede.value;
  const zonaVal = filterZona.value;
  const hasCorrectiveVal = filterHasCorrective.checked;
  const onlyPendingVal = filterOnlyPending.checked;
  
  const filtered = equipos.filter(item => {
    // Sede filter
    if (sedeVal && item.sede !== sedeVal) return false;
    
    // Zona filter (GAM / Foráneo)
    if (zonaVal && item.zona !== zonaVal) return false;
    
    // Search text (checks equipo, edificio, num, correctivo, capacidad)
    if (searchVal) {
      const equipo = (item.equipo || '').toLowerCase();
      const edificio = (item.edificio || '').toLowerCase();
      const correctivo = (item.correctivo_sugerido || '').toLowerCase();
      const cap = (item.capacidad || '').toLowerCase();
      const num = String(item.numero_equipo || '');
      const match = equipo.includes(searchVal) || edificio.includes(searchVal) || correctivo.includes(searchVal) || cap.includes(searchVal) || num.includes(searchVal);
      if (!match) return false;
    }
    
    // Has corrective filter
    if (hasCorrectiveVal && !item.correctivo_sugerido) return false;
    
    // Only pending filter
    if (onlyPendingVal && (!item.correctivo_sugerido || item.realizado === 1)) return false;
    
    return true;
  });
  
  if (filtered.length === 0) {
    equipmentGrid.innerHTML = `
      <div class="empty-state">
        <span class="material-symbols-outlined empty-state-icon">search_off</span>
        <h3>No se encontraron equipos</h3>
        <p>Intente cambiando los filtros o el texto de búsqueda.</p>
      </div>
    `;
    return;
  }
  
  equipmentGrid.innerHTML = '';
  filtered.forEach(item => {
    const card = createEquipmentCard(item);
    equipmentGrid.appendChild(card);
  });
}

// Card DOM Creation
function createEquipmentCard(item) {
  const isEditor = currentRole === 'editor';
  const card = document.createElement('div');
  card.className = 'equip-card card';
  card.dataset.id = item.id;
  
  // Header section
  const header = document.createElement('div');
  header.className = 'equip-card-header';
  
  // Toggle expansion in list view
  header.addEventListener('click', (e) => {
    if (currentViewMode === 'list' && !e.target.closest('.checkbox-realizado-container') && !e.target.closest('.badge-realizado')) {
      card.classList.toggle('expanded');
    }
  });
  
  const titleBadges = document.createElement('div');
  titleBadges.className = 'equip-card-badges';
  
  // Badge Row (Sede, Zona, Número de equipo)
  const badgeRow = document.createElement('div');
  badgeRow.className = 'badge-row';
  
  const sedeBadge = document.createElement('span');
  sedeBadge.className = 'badge-sede';
  sedeBadge.textContent = item.sede;
  badgeRow.appendChild(sedeBadge);
  
  if (item.zona) {
    const zonaBadge = document.createElement('span');
    zonaBadge.className = item.zona === 'GAM' ? 'badge-zona-gam' : 'badge-zona-foraneo';
    zonaBadge.textContent = item.zona;
    badgeRow.appendChild(zonaBadge);
  }
  
  if (item.numero_equipo !== null && item.numero_equipo !== undefined) {
    const numBadge = document.createElement('span');
    numBadge.className = 'badge-numero';
    numBadge.textContent = `#${item.numero_equipo}`;
    badgeRow.appendChild(numBadge);
  }
  
  titleBadges.appendChild(badgeRow);
  
  // Title (Área / Nombre de equipo)
  const areaTitle = document.createElement('h3');
  areaTitle.className = 'equip-area';
  areaTitle.textContent = item.equipo;
  titleBadges.appendChild(areaTitle);
  
  // Subtitle (Sitio / Edificio)
  const edificioSubtitle = document.createElement('div');
  edificioSubtitle.className = 'equip-edificio';
  edificioSubtitle.innerHTML = `<span class="material-symbols-outlined">business</span> ${item.edificio}`;
  titleBadges.appendChild(edificioSubtitle);
  
  header.appendChild(titleBadges);
  
  // Realizado Status check/badge
  const realizadoContainer = document.createElement('div');
  realizadoContainer.className = 'realizado-status-container';
  
  if (isEditor) {
    const label = document.createElement('label');
    label.className = 'checkbox-realizado-container';
    
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = item.realizado === 1;
    input.addEventListener('change', (e) => {
      saveField(item.id, 'realizado', e.target.checked);
    });
    
    const customCheckbox = document.createElement('span');
    customCheckbox.className = 'checkbox-custom';
    customCheckbox.innerHTML = '<span class="material-symbols-outlined">check</span>';
    
    const textSpan = document.createElement('span');
    textSpan.textContent = 'Realizado';
    
    label.appendChild(input);
    label.appendChild(customCheckbox);
    label.appendChild(textSpan);
    realizadoContainer.appendChild(label);
  } else {
    const badge = document.createElement('span');
    if (item.correctivo_sugerido) {
      if (item.realizado === 1) {
        badge.className = 'badge-realizado done';
        badge.innerHTML = '<span class="material-symbols-outlined" style="font-size:16px;">check_circle</span> Realizado';
      } else {
        badge.className = 'badge-realizado pending';
        badge.innerHTML = '<span class="material-symbols-outlined" style="font-size:16px;">pending</span> Pendiente';
      }
    } else {
      badge.className = 'badge-realizado pending';
      badge.innerHTML = '<span class="material-symbols-outlined" style="font-size:16px;">remove</span> N/A';
    }
    realizadoContainer.appendChild(badge);
  }
  
  header.appendChild(realizadoContainer);
  card.appendChild(header);
  
  // Card Body (Inputs)
  const body = document.createElement('div');
  body.className = 'card-body';
  
  // 1. Capacidad del Equipo (Editable online)
  const fieldCapacidad = createFieldGroupInline(
    'capacidad', 
    'Capacidad del Equipo', 
    'ac_unit', 
    item.capacidad, 
    'Ej: 18.000 BTU, 36.000 BTU...', 
    item.id,
    isEditor
  );
  body.appendChild(fieldCapacidad);
  
  // 2. Correctivo Sugerido
  const fieldCorrectivo = createFieldGroup(
    'correctivo_sugerido', 
    'Correctivo Sugerido', 
    'build', 
    item.correctivo_sugerido, 
    'Describa el correctivo sugerido para este equipo...', 
    item.id,
    isEditor
  );
  body.appendChild(fieldCorrectivo);
  
  // 3. Items a Cotizar
  const fieldItems = createFieldGroup(
    'items_a_cotizar', 
    'Qué se debe cotizar', 
    'shopping_cart', 
    item.items_a_cotizar, 
    'Detalle repuestos o servicios a cotizar...', 
    item.id,
    isEditor
  );
  body.appendChild(fieldItems);
  
  // 4. Link a la Cotización (Only show for Editors)
  if (isEditor) {
    const fieldLink = createLinkFieldGroup(item);
    body.appendChild(fieldLink);
  }
  
  card.appendChild(body);
  return card;
}

// Field creation helper (Block Layout)
function createFieldGroup(fieldKey, labelText, iconName, value, placeholder, itemId, isEditor) {
  const group = document.createElement('div');
  group.className = 'field-group';
  group.dataset.field = fieldKey;
  
  const label = document.createElement('span');
  label.className = 'field-label';
  label.innerHTML = `<span class="material-symbols-outlined">${iconName}</span> ${labelText}`;
  group.appendChild(label);
  
  const lockIndicator = document.createElement('div');
  lockIndicator.className = 'lock-badge hidden';
  lockIndicator.innerHTML = '<span class="material-symbols-outlined" style="font-size:12px;">lock</span> Editando';
  group.appendChild(lockIndicator);
  
  if (isEditor) {
    const textarea = document.createElement('textarea');
    textarea.className = 'field-input';
    textarea.rows = 2;
    textarea.placeholder = placeholder;
    textarea.value = value || '';
    
    textarea.addEventListener('focus', () => sendLock(itemId, fieldKey));
    textarea.addEventListener('input', (e) => debounceSave(itemId, fieldKey, e.target.value));
    textarea.addEventListener('blur', (e) => {
      sendUnlock(itemId, fieldKey);
      triggerImmediateSave(itemId, fieldKey, e.target.value);
    });
    
    group.appendChild(textarea);
  } else {
    const div = document.createElement('div');
    div.className = `field-value-readonly ${!value ? 'empty' : ''}`;
    div.textContent = value || 'Ninguno';
    group.appendChild(div);
  }
  
  return group;
}

// Field creation helper (Inline Layout for Capacidad)
function createFieldGroupInline(fieldKey, labelText, iconName, value, placeholder, itemId, isEditor) {
  const group = document.createElement('div');
  group.className = 'field-group';
  group.dataset.field = fieldKey;
  
  const label = document.createElement('span');
  label.className = 'field-label';
  label.innerHTML = `<span class="material-symbols-outlined">${iconName}</span> ${labelText}`;
  group.appendChild(label);
  
  const lockIndicator = document.createElement('div');
  lockIndicator.className = 'lock-badge hidden';
  lockIndicator.innerHTML = '<span class="material-symbols-outlined" style="font-size:12px;">lock</span>';
  group.appendChild(lockIndicator);
  
  if (isEditor) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'field-input';
    input.placeholder = placeholder;
    input.value = value || '';
    
    input.addEventListener('focus', () => sendLock(itemId, fieldKey));
    input.addEventListener('input', (e) => debounceSave(itemId, fieldKey, e.target.value));
    input.addEventListener('blur', (e) => {
      sendUnlock(itemId, fieldKey);
      triggerImmediateSave(itemId, fieldKey, e.target.value);
    });
    
    group.appendChild(input);
  } else {
    const div = document.createElement('div');
    div.className = `field-value-readonly ${!value ? 'empty' : ''}`;
    div.textContent = value || 'No registrada';
    group.appendChild(div);
  }
  
  return group;
}

// Link Field group for Editors
function createLinkFieldGroup(item) {
  const group = document.createElement('div');
  group.className = 'field-group';
  group.dataset.field = 'link_cotizacion';
  
  const label = document.createElement('span');
  label.className = 'field-label';
  label.innerHTML = '<span class="material-symbols-outlined">link</span> Enlace a Cotización';
  group.appendChild(label);
  
  const lockIndicator = document.createElement('div');
  lockIndicator.className = 'lock-badge hidden';
  lockIndicator.innerHTML = '<span class="material-symbols-outlined" style="font-size:12px;">lock</span>';
  group.appendChild(lockIndicator);
  
  const linkRow = document.createElement('div');
  linkRow.className = 'quote-link-group';
  
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'field-input';
  input.placeholder = 'https://enlace-cotizacion.com';
  input.value = item.link_cotizacion || '';
  
  input.addEventListener('focus', () => sendLock(item.id, 'link_cotizacion'));
  input.addEventListener('input', (e) => debounceSave(item.id, 'link_cotizacion', e.target.value));
  input.addEventListener('blur', (e) => {
    sendUnlock(item.id, 'link_cotizacion');
    triggerImmediateSave(item.id, 'link_cotizacion', e.target.value);
  });
  
  linkRow.appendChild(input);
  
  const linkBtn = document.createElement('a');
  linkBtn.className = `btn btn-text icon-only ${!item.link_cotizacion ? 'hidden' : ''}`;
  linkBtn.href = item.link_cotizacion || '#';
  linkBtn.target = '_blank';
  linkBtn.title = 'Ir a la cotización';
  linkBtn.innerHTML = '<span class="material-symbols-outlined">open_in_new</span>';
  linkRow.appendChild(linkBtn);
  
  group.appendChild(linkRow);
  return group;
}

// Auto-saving functions (REST PUT)
function debounceSave(itemId, field, value) {
  const key = `${itemId}-${field}`;
  
  if (debounceTimers[key]) {
    clearTimeout(debounceTimers[key]);
  }
  
  debounceTimers[key] = setTimeout(() => {
    saveField(itemId, field, value);
    delete debounceTimers[key];
  }, 600);
}

function triggerImmediateSave(itemId, field, value) {
  const key = `${itemId}-${field}`;
  if (debounceTimers[key]) {
    clearTimeout(debounceTimers[key]);
    delete debounceTimers[key];
    saveField(itemId, field, value);
  }
}

async function saveField(itemId, field, value) {
  if (currentRole !== 'editor') return;
  
  const payload = {};
  payload[field] = value;
  
  try {
    const response = await fetch(`/api/equipos/${itemId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': currentToken
      },
      body: JSON.stringify(payload)
    });
    
    if (!response.ok) {
      if (response.status === 401) {
        logout();
        return;
      }
      throw new Error('Error al guardar');
    }
    
    const result = await response.json();
    
    const idx = equipos.findIndex(item => item.id === itemId);
    if (idx !== -1) {
      equipos[idx] = result.data;
      calculateStats();
      
      if (field === 'link_cotizacion') {
        const cardEl = document.querySelector(`.equip-card[data-id="${itemId}"]`);
        if (cardEl) {
          const linkBtn = cardEl.querySelector('.quote-link-group a');
          if (linkBtn) {
            if (value) {
              linkBtn.href = value;
              linkBtn.classList.remove('hidden');
            } else {
              linkBtn.classList.add('hidden');
            }
          }
        }
      }
    }
  } catch (error) {
    console.error('Error saving field:', error);
  }
}

// WebSocket Real-time Sync
function startWebSocket() {
  stopWebSocket();
  
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;
  
  console.log(`Connecting to WebSocket at ${wsUrl}`);
  ws = new WebSocket(wsUrl);
  
  ws.onopen = () => {
    console.log('WebSocket connected.');
    connBanner.classList.add('hidden');
    if (wsReconnectTimer) {
      clearTimeout(wsReconnectTimer);
      wsReconnectTimer = null;
    }
  };
  
  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      
      switch (msg.type) {
        case 'initial_locks':
          activeLocks = msg.locks;
          applyLocksUI();
          break;
          
        case 'lock':
          activeLocks[`${msg.id}-${msg.field}`] = msg.clientId;
          setFieldLockState(msg.id, msg.field, true);
          break;
          
        case 'unlock':
          delete activeLocks[`${msg.id}-${msg.field}`];
          setFieldLockState(msg.id, msg.field, false);
          break;
          
        case 'update':
          handleRemoteUpdate(msg.data);
          break;
      }
    } catch (e) {
      console.error('WS message error:', e);
    }
  };
  
  ws.onclose = () => {
    console.log('WebSocket disconnected.');
    connBanner.classList.remove('hidden');
    activeLocks = {};
    applyLocksUI();
    wsReconnectTimer = setTimeout(startWebSocket, 3000);
  };
  
  ws.onerror = (err) => {
    console.error('WebSocket error:', err);
  };
}

function stopWebSocket() {
  if (ws) {
    ws.close();
    ws = null;
  }
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }
}

// Send Lock messages
function sendLock(itemId, field) {
  if (ws && ws.readyState === WebSocket.OPEN && currentRole === 'editor') {
    ws.send(JSON.stringify({
      type: 'lock',
      id: itemId,
      field: field
    }));
  }
}

function sendUnlock(itemId, field) {
  if (ws && ws.readyState === WebSocket.OPEN && currentRole === 'editor') {
    ws.send(JSON.stringify({
      type: 'unlock',
      id: itemId,
      field: field
    }));
  }
}

// Apply locks in DOM
function applyLocksUI() {
  document.querySelectorAll('.field-input').forEach(el => {
    el.classList.remove('locked');
    el.removeAttribute('disabled');
  });
  document.querySelectorAll('.lock-badge').forEach(el => {
    el.classList.add('hidden');
  });
  
  for (const key of Object.keys(activeLocks)) {
    const [id, field] = key.split('-');
    setFieldLockState(id, field, true);
  }
}

function setFieldLockState(itemId, field, isLocked) {
  const cardEl = document.querySelector(`.equip-card[data-id="${itemId}"]`);
  if (!cardEl) return;
  
  const fieldGroup = cardEl.querySelector(`.field-group[data-field="${field}"]`);
  if (!fieldGroup) return;
  
  const inputEl = fieldGroup.querySelector('.field-input');
  const badgeEl = fieldGroup.querySelector('.lock-badge');
  
  if (isLocked) {
    if (inputEl && document.activeElement !== inputEl) {
      inputEl.classList.add('locked');
      inputEl.setAttribute('disabled', 'true');
      if (badgeEl) badgeEl.classList.remove('hidden');
    }
  } else {
    if (inputEl) {
      inputEl.classList.remove('locked');
      inputEl.removeAttribute('disabled');
    }
    if (badgeEl) badgeEl.classList.add('hidden');
  }
}

// Remote update processing
function handleRemoteUpdate(updatedItem) {
  const idx = equipos.findIndex(item => item.id === updatedItem.id);
  if (idx !== -1) {
    equipos[idx] = updatedItem;
    calculateStats();
    
    const cardEl = document.querySelector(`.equip-card[data-id="${updatedItem.id}"]`);
    if (cardEl) {
      const chkEl = cardEl.querySelector('.checkbox-realizado-container input');
      if (chkEl && document.activeElement !== chkEl) {
        chkEl.checked = updatedItem.realizado === 1;
      }
      
      const badgeEl = cardEl.querySelector('.badge-realizado');
      if (badgeEl) {
        if (updatedItem.correctivo_sugerido) {
          if (updatedItem.realizado === 1) {
            badgeEl.className = 'badge-realizado done';
            badgeEl.innerHTML = '<span class="material-symbols-outlined" style="font-size:16px;">check_circle</span> Realizado';
          } else {
            badgeEl.className = 'badge-realizado pending';
            badgeEl.innerHTML = '<span class="material-symbols-outlined" style="font-size:16px;">pending</span> Pendiente';
          }
        } else {
          badgeEl.className = 'badge-realizado pending';
          badgeEl.innerHTML = '<span class="material-symbols-outlined" style="font-size:16px;">remove</span> N/A';
        }
      }
      
      // Update Capacidad field
      updateFieldDOM(cardEl, 'capacidad', updatedItem.capacidad);
      
      // Update Correctivo Sugerido field
      updateFieldDOM(cardEl, 'correctivo_sugerido', updatedItem.correctivo_sugerido);
      
      // Update Items a Cotizar field
      updateFieldDOM(cardEl, 'items_a_cotizar', updatedItem.items_a_cotizar);
      
      if (currentRole === 'editor') {
        const linkInput = cardEl.querySelector('.quote-link-group input');
        const linkBtn = cardEl.querySelector('.quote-link-group a');
        
        if (linkInput && document.activeElement !== linkInput) {
          linkInput.value = updatedItem.link_cotizacion || '';
        }
        
        if (linkBtn) {
          if (updatedItem.link_cotizacion) {
            linkBtn.href = updatedItem.link_cotizacion;
            linkBtn.classList.remove('hidden');
          } else {
            linkBtn.classList.add('hidden');
          }
        }
      }
    }
  }
}

function updateFieldDOM(cardEl, field, value) {
  const group = cardEl.querySelector(`.field-group[data-field="${field}"]`);
  if (!group) return;
  
  const input = group.querySelector('.field-input');
  if (input) {
    if (document.activeElement !== input) {
      input.value = value || '';
    }
  } else {
    const readOnlyDiv = group.querySelector('.field-value-readonly');
    if (readOnlyDiv) {
      readOnlyDiv.textContent = value || 'Ninguno';
      if (!value) {
        readOnlyDiv.classList.add('empty');
      } else {
        readOnlyDiv.classList.remove('empty');
      }
    }
  }
}

// Start application
window.addEventListener('DOMContentLoaded', init);
